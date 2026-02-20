import assert from "node:assert/strict";
import { parseLogMeal } from "../lib/log-meal";
import { enrichDraftWithLookup } from "../lib/nutrition-lookup";
import { getUserFacingItemLabel, normalizeItemQuantity } from "../lib/log-meal-items";
import { prisma } from "../lib/prisma";
import type { MealDraft } from "../lib/log-meal";
import { GET as getDaySummary } from "../app/api/day-summary/route";

async function testDeterministicMath() {
  const draft = parseLogMeal("I had tofu protein 10g carbs 20g fat 10g");
  assert.equal(draft.kcal, 210);
  assert.equal(draft.source, "estimated");
}

async function testLookupPriority() {
  await prisma.consumedProduct.upsert({
    where: { name: "Ahead Gummies Test" },
    update: {
      aliases: "ahead gummies",
      searchText: "ahead gummies",
      kcalPer100g: 350,
      proteinPer100g: 5,
      carbsPer100g: 80,
      fatPer100g: 0.2,
    },
    create: {
      name: "Ahead Gummies Test",
      aliases: "ahead gummies",
      searchText: "ahead gummies",
      kcalPer100g: 350,
      proteinPer100g: 5,
      carbsPer100g: 80,
      fatPer100g: 0.2,
    },
  });

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("External lookup should not run for DB hit");
  };

  const draft: MealDraft = {
    intent: "log_meal",
    rawText: "I had ahead gummies",
    item: "ahead gummies",
    amountGrams: 100,
    source: "agent",
    assumptions: [],
    confidence: "medium",
  };

  const result = await enrichDraftWithLookup(draft);

  globalThis.fetch = originalFetch;

  assert.equal(result.lookup?.sourceType, "consumed_products");
  assert.equal(result.draft.kcal, 350);
  assert.equal(result.draft.carbsG, 80);
  assert.equal(fetchCalled, false);
}

async function testEggQuantityConversion() {
  const converted = normalizeItemQuantity({
    name: "eggs",
    quantity: 4,
    unit: "eggs",
    size: "medium",
    assumptions: [],
    source: "agent",
  });

  assert.equal(converted.amountGrams, 200);
  assert.equal(
    converted.assumptions.includes("Converted 4 medium egg(s) to 200g (50g each)."),
    true
  );
  assert.equal(getUserFacingItemLabel(converted), "4 eggs");
}

async function testDaySummaryBucketing() {
  await prisma.meal.deleteMany();
  await prisma.mealEntry.deleteMany();

  const breakfastMeal = await prisma.meal.create({
    data: {
      rawText: "breakfast",
      label: "Breakfast",
      kcal: 500,
      proteinG: 50,
      carbsG: 50,
      fatG: 15,
      confidence: "high",
      assumptions: "",
      berlinDate: "2026-02-20",
      berlinTime: "08:00:00",
      timezone: "Europe/Berlin",
    },
  });

  const nextDayMeal = await prisma.meal.create({
    data: {
      rawText: "next day meal",
      label: "Meal",
      kcal: 900,
      proteinG: 90,
      carbsG: 90,
      fatG: 90,
      confidence: "high",
      assumptions: "",
      berlinDate: "2026-02-21",
      berlinTime: "09:00:00",
      timezone: "Europe/Berlin",
    },
  });

  await prisma.mealEntry.createMany({
    data: [
      {
        intent: "log_meal",
        mealId: breakfastMeal.id,
        rawText: "meal-1",
        item: "Meal 1",
        kcal: 200,
        proteinG: 20,
        carbsG: 10,
        fatG: 5,
        source: "user",
        confidence: "high",
        assumptions: "",
        berlinDate: "2026-02-20",
        berlinTime: "08:00:00",
        timezone: "Europe/Berlin",
      },
      {
        intent: "log_meal",
        mealId: breakfastMeal.id,
        rawText: "meal-2",
        item: "Meal 2",
        kcal: 300,
        proteinG: 30,
        carbsG: 40,
        fatG: 10,
        source: "user",
        confidence: "high",
        assumptions: "",
        berlinDate: "2026-02-20",
        berlinTime: "12:00:00",
        timezone: "Europe/Berlin",
      },
      {
        intent: "log_meal",
        mealId: nextDayMeal.id,
        rawText: "meal-3",
        item: "Meal 3",
        kcal: 900,
        proteinG: 90,
        carbsG: 90,
        fatG: 90,
        source: "user",
        confidence: "high",
        assumptions: "",
        berlinDate: "2026-02-21",
        berlinTime: "09:00:00",
        timezone: "Europe/Berlin",
      },
    ],
  });

  const response = await getDaySummary(
    new Request("http://localhost:3000/api/day-summary?date=2026-02-20")
  );
  const body = (await response.json()) as {
    mealCount: number;
    entryCount: number;
    totals: { kcal: number; proteinG: number; carbsG: number; fatG: number };
  };

  assert.equal(response.status, 200);
  assert.equal(body.mealCount, 1);
  assert.equal(body.entryCount, 2);
  assert.deepEqual(body.totals, {
    kcal: 500,
    proteinG: 50,
    carbsG: 50,
    fatG: 15,
  });
}

async function run() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ConsumedProduct" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "aliases" TEXT NOT NULL DEFAULT '',
      "searchText" TEXT NOT NULL,
      "kcalPer100g" REAL NOT NULL,
      "proteinPer100g" REAL NOT NULL,
      "carbsPer100g" REAL NOT NULL,
      "fatPer100g" REAL NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "ConsumedProduct_name_key" ON "ConsumedProduct"("name");'
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Meal" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "rawText" TEXT NOT NULL,
      "label" TEXT NOT NULL,
      "kcal" REAL,
      "proteinG" REAL,
      "carbsG" REAL,
      "fatG" REAL,
      "confidence" TEXT NOT NULL,
      "assumptions" TEXT NOT NULL,
      "berlinDate" TEXT NOT NULL,
      "berlinTime" TEXT NOT NULL,
      "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "Meal_berlinDate_idx" ON "Meal"("berlinDate");'
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "MealEntry" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "intent" TEXT NOT NULL DEFAULT 'log_meal',
      "mealId" INTEGER,
      "rawText" TEXT NOT NULL,
      "item" TEXT NOT NULL,
      "amountGrams" REAL,
      "kcal" REAL,
      "proteinG" REAL,
      "carbsG" REAL,
      "fatG" REAL,
      "source" TEXT NOT NULL,
      "confidence" TEXT NOT NULL,
      "assumptions" TEXT NOT NULL,
      "lookupSourceType" TEXT,
      "lookupLabel" TEXT,
      "agentModel" TEXT,
      "berlinDate" TEXT NOT NULL,
      "berlinTime" TEXT NOT NULL,
      "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await testDeterministicMath();
  await testLookupPriority();
  await testEggQuantityConversion();
  await testDaySummaryBucketing();

  console.log("All tests passed.");
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
