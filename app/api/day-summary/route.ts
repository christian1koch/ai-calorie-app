import { NextResponse } from "next/server";
import { isValidIsoDate } from "@/lib/berlin-time";
import { prisma } from "@/lib/prisma";

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
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
    entryCount: entries.length,
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
