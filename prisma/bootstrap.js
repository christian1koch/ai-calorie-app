/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const products = [
  {
    name: "Milbona Skyr Natur",
    aliases: "skyr,milbona skyr,natur skyr",
    searchText: "milbona skyr natur skyr",
    kcalPer100g: 62,
    proteinPer100g: 11,
    carbsPer100g: 3.9,
    fatPer100g: 0.2,
  },
  {
    name: "Magerquark",
    aliases: "quark,magerquark",
    searchText: "magerquark quark",
    kcalPer100g: 67,
    proteinPer100g: 12,
    carbsPer100g: 4,
    fatPer100g: 0.2,
  },
  {
    name: "Haferflocken",
    aliases: "oats,haferflocken",
    searchText: "haferflocken oats oatmeal",
    kcalPer100g: 372,
    proteinPer100g: 13.5,
    carbsPer100g: 58.7,
    fatPer100g: 7,
  },
];

async function main() {
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
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "ConsumedProduct_searchText_idx" ON "ConsumedProduct"("searchText");'
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
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "Meal_berlinDate_idx" ON "Meal"("berlinDate");');

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
      "lookupUrl" TEXT,
      "agentModel" TEXT,
      "berlinDate" TEXT NOT NULL,
      "berlinTime" TEXT NOT NULL,
      "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "MealEntry" ADD COLUMN "mealId" INTEGER;');
  } catch {
    // Column already exists for existing local databases.
  }
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "MealEntry" ADD COLUMN "lookupUrl" TEXT;');
  } catch {
    // Column already exists for existing local databases.
  }
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "MealEntry" ADD COLUMN "assumptionsJson" TEXT NOT NULL DEFAULT \'[]\';');
  } catch {
    // Column already exists.
  }
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "MealEntry" ADD COLUMN "provenanceJson" TEXT NOT NULL DEFAULT \'{}\';');
  } catch {
    // Column already exists.
  }
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "MealEntry" ADD COLUMN "confidenceScore" REAL;');
  } catch {
    // Column already exists.
  }
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "MealEntry" ADD COLUMN "deletedAt" DATETIME;');
  } catch {
    // Column already exists.
  }
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "MealEntry_berlinDate_idx" ON "MealEntry"("berlinDate");'
  );
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "MealEntry_mealId_idx" ON "MealEntry"("mealId");');
  await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "MealEntry_deletedAt_idx" ON "MealEntry"("deletedAt");');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ConversationSession" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "sessionId" TEXT NOT NULL,
      "activeMealId" INTEGER,
      "lastIntent" TEXT,
      "metadataJson" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "ConversationSession_sessionId_key" ON "ConversationSession"("sessionId");'
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "MealAction" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "sessionId" TEXT,
      "mealId" INTEGER,
      "actionType" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "rawText" TEXT NOT NULL,
      "resolvedIntent" TEXT NOT NULL,
      "reason" TEXT,
      "entryIdsJson" TEXT NOT NULL DEFAULT '[]',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "MealAction_sessionId_idx" ON "MealAction"("sessionId");'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "MealAction_mealId_idx" ON "MealAction"("mealId");'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "MealAction_createdAt_idx" ON "MealAction"("createdAt");'
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "EntryRevision" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "entryId" INTEGER NOT NULL,
      "actor" TEXT NOT NULL,
      "reason" TEXT NOT NULL,
      "beforeJson" TEXT NOT NULL,
      "afterJson" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "EntryRevision_entryId_idx" ON "EntryRevision"("entryId");'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "EntryRevision_createdAt_idx" ON "EntryRevision"("createdAt");'
  );

  for (const product of products) {
    await prisma.consumedProduct.upsert({
      where: { name: product.name },
      update: product,
      create: product,
    });
  }
}

main()
  .catch((error) => {
    console.error("Prisma bootstrap failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
