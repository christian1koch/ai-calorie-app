import { ResolvedItem } from "@/lib/agent/types";
import { prisma } from "@/lib/prisma";

type MealTotals = { kcal: number; proteinG: number; carbsG: number; fatG: number };

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function aggregateTotals(items: ResolvedItem[]): MealTotals {
  return {
    kcal: round1(items.reduce((acc, item) => acc + (item.kcal ?? 0), 0)),
    proteinG: round1(items.reduce((acc, item) => acc + (item.proteinG ?? 0), 0)),
    carbsG: round1(items.reduce((acc, item) => acc + (item.carbsG ?? 0), 0)),
    fatG: round1(items.reduce((acc, item) => acc + (item.fatG ?? 0), 0)),
  };
}

function inferLabel(rawText: string): string {
  const lower = rawText.toLowerCase();
  if (lower.includes("breakfast")) return "Breakfast";
  if (lower.includes("lunch")) return "Lunch";
  if (lower.includes("dinner")) return "Dinner";
  if (lower.includes("snack")) return "Snack";
  return "Meal";
}

export async function createMeal(args: {
  rawText: string;
  berlinDate: string;
  berlinTime: string;
  timezone: string;
  commandModel: string;
  items: ResolvedItem[];
  assumptions: string[];
  confidence: number;
}) {
  const mealDelegate = (prisma as unknown as {
    meal?: {
      create: (args: unknown) => Promise<{ id: number }>;
    };
  }).meal;

  const totals = aggregateTotals(args.items);
  const confidenceLabel = args.confidence >= 0.8 ? "high" : args.confidence >= 0.5 ? "medium" : "low";

  const meal = mealDelegate
    ? await mealDelegate.create({
        data: {
          rawText: args.rawText,
          label: inferLabel(args.rawText),
          kcal: totals.kcal,
          proteinG: totals.proteinG,
          carbsG: totals.carbsG,
          fatG: totals.fatG,
          confidence: confidenceLabel,
          assumptions: args.assumptions.join("\n"),
          berlinDate: args.berlinDate,
          berlinTime: args.berlinTime,
          timezone: args.timezone,
        },
        select: { id: true },
      })
    : null;

  const savedEntryIds: number[] = [];
  for (const item of args.items) {
    const created = await prisma.mealEntry.create({
      data: {
        intent: "log_meal",
        ...(meal?.id ? { meal: { connect: { id: meal.id } } } : {}),
        rawText: args.rawText,
        item: item.displayName,
        amountGrams: item.amountGrams,
        kcal: item.kcal,
        proteinG: item.proteinG,
        carbsG: item.carbsG,
        fatG: item.fatG,
        source: item.source,
        confidence: item.confidence >= 0.8 ? "high" : item.confidence >= 0.5 ? "medium" : "low",
        confidenceScore: item.confidence,
        assumptions: item.assumptions.join("\n"),
        assumptionsJson: JSON.stringify(item.assumptions),
        provenanceJson: JSON.stringify(item.provenance),
        lookupSourceType: item.provenance.sourceType,
        lookupLabel: item.provenance.label,
        lookupUrl: item.provenance.url,
        agentModel: args.commandModel,
        berlinDate: args.berlinDate,
        berlinTime: args.berlinTime,
        timezone: args.timezone,
      },
      select: { id: true },
    });
    savedEntryIds.push(created.id);
  }

  return {
    mealId: meal?.id ?? null,
    entryIds: savedEntryIds,
    totals,
  };
}
