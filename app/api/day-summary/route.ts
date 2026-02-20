import { NextResponse } from "next/server";
import { isValidIsoDate } from "@/lib/berlin-time";
import { prisma } from "@/lib/prisma";

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function hasMealModel() {
  return Boolean((prisma as unknown as { meal?: { findMany?: unknown } }).meal);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date");

  if (!date || !isValidIsoDate(date)) {
    return NextResponse.json(
      { error: "Missing or invalid date. Use ?date=YYYY-MM-DD" },
      { status: 400 }
    );
  }

  const entries = await prisma.mealEntry.findMany({
    where: {
      berlinDate: date,
    },
    orderBy: [{ berlinTime: "asc" }, { id: "asc" }],
  });
  const meals = hasMealModel()
    ? await (
        prisma as unknown as {
          meal: {
            findMany: (args: unknown) => Promise<
              Array<{
                id: number;
                label: string;
                berlinTime: string;
                kcal: number | null;
                proteinG: number | null;
                carbsG: number | null;
                fatG: number | null;
                entries: Array<{
                  id: number;
                  item: string;
                  amountGrams: number | null;
                  kcal: number | null;
                  proteinG: number | null;
                  carbsG: number | null;
                  fatG: number | null;
                  source: string;
                  confidence: string;
                  lookupSourceType: string | null;
                  lookupLabel: string | null;
                  lookupUrl: string | null;
                }>;
              }>
            >;
          };
        }
      ).meal.findMany({
        where: {
          berlinDate: date,
        },
        include: {
          entries: {
            orderBy: [{ id: "asc" }],
          },
        },
        orderBy: [{ berlinTime: "asc" }, { id: "asc" }],
      })
    : [];

  const fallbackMeals =
    meals.length > 0
      ? meals
      : entries.map((entry) => ({
          id: entry.id,
          label: "Meal",
          berlinTime: entry.berlinTime,
          kcal: entry.kcal,
          proteinG: entry.proteinG,
          carbsG: entry.carbsG,
          fatG: entry.fatG,
          entries: [entry],
        }));

  const totals = entries.reduce(
    (accumulator, entry) => {
      accumulator.kcal += entry.kcal ?? 0;
      accumulator.proteinG += entry.proteinG ?? 0;
      accumulator.carbsG += entry.carbsG ?? 0;
      accumulator.fatG += entry.fatG ?? 0;
      return accumulator;
    },
    { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }
  );

  return NextResponse.json({
    ok: true,
    date,
    totals: {
      kcal: roundToSingleDecimal(totals.kcal),
      proteinG: roundToSingleDecimal(totals.proteinG),
      carbsG: roundToSingleDecimal(totals.carbsG),
      fatG: roundToSingleDecimal(totals.fatG),
    },
    mealCount: fallbackMeals.length,
    entryCount: entries.length,
    meals: fallbackMeals.map((meal) => ({
      id: meal.id,
      label: meal.label,
      berlinTime: meal.berlinTime,
      totals: {
        kcal: meal.kcal,
        proteinG: meal.proteinG,
        carbsG: meal.carbsG,
        fatG: meal.fatG,
      },
      foods: meal.entries.map((entry) => ({
        id: entry.id,
        item: entry.item,
        amountGrams: entry.amountGrams,
        kcal: entry.kcal,
        proteinG: entry.proteinG,
        carbsG: entry.carbsG,
        fatG: entry.fatG,
        source: entry.source,
        confidence: entry.confidence,
        lookupSourceType: entry.lookupSourceType,
        lookupLabel: entry.lookupLabel,
        lookupUrl: entry.lookupUrl,
      })),
    })),
    entries: entries.map((entry) => ({
      id: entry.id,
      item: entry.item,
      amountGrams: entry.amountGrams,
      kcal: entry.kcal,
      proteinG: entry.proteinG,
      carbsG: entry.carbsG,
      fatG: entry.fatG,
      berlinTime: entry.berlinTime,
      source: entry.source,
      confidence: entry.confidence,
    })),
  });
}
