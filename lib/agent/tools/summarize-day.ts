import { prisma } from "@/lib/prisma";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export async function summarizeDay(berlinDate: string) {
  const entries = await prisma.mealEntry.findMany({
    where: { berlinDate, deletedAt: null },
    select: {
      id: true,
      item: true,
      kcal: true,
      proteinG: true,
      carbsG: true,
      fatG: true,
      confidenceScore: true,
      provenanceJson: true,
    },
    orderBy: [{ id: "asc" }],
  });

  const totals = entries.reduce(
    (acc, entry) => {
      acc.kcal += entry.kcal ?? 0;
      acc.proteinG += entry.proteinG ?? 0;
      acc.carbsG += entry.carbsG ?? 0;
      acc.fatG += entry.fatG ?? 0;
      return acc;
    },
    { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }
  );

  return {
    totals: {
      kcal: round1(totals.kcal),
      proteinG: round1(totals.proteinG),
      carbsG: round1(totals.carbsG),
      fatG: round1(totals.fatG),
    },
    entries,
  };
}
