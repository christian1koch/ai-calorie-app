import { getRankedFoodCandidates, scaleFromPer100g } from "@/lib/nutrition-lookup";
import { AgentItemInput, ResolvedItem } from "@/lib/agent/types";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function estimateFromCommonFood(item: AgentItemInput): ResolvedItem | null {
  const grams = item.amountGrams ?? 100;
  const name = item.name.toLowerCase();

  const fromPer100 = (
    kcalPer100g: number,
    proteinPer100g: number,
    carbsPer100g: number,
    fatPer100g: number,
    label: string
  ) => {
    const scaled = scaleFromPer100g({ kcalPer100g, proteinPer100g, carbsPer100g, fatPer100g }, grams);
    return {
      name: item.name,
      displayName: item.displayName ?? item.name,
      amountGrams: item.amountGrams ?? null,
      kcal: item.kcal ?? scaled.kcal,
      proteinG: item.proteinG ?? scaled.proteinG,
      carbsG: item.carbsG ?? scaled.carbsG,
      fatG: item.fatG ?? scaled.fatG,
      source: "estimated",
      confidence: 0.55,
      assumptions: [`Used built-in estimate for ${label}.`],
      provenance: {
        sourceType: "estimated",
        label: "Built-in fallback",
        url: null,
        rationale: `Applied fallback profile for ${label}.`,
      },
    } satisfies ResolvedItem;
  };

  if (/(^|\b)(egg|eggs|ei|eier)(\b|$)/.test(name)) return fromPer100(143, 12.6, 1.1, 9.5, "eggs");
  if (name.includes("chicken")) return fromPer100(165, 31, 0, 3.6, "chicken breast");
  if (name.includes("rice")) return fromPer100(131, 2.7, 28, 0.3, "cooked rice");
  if (name.includes("skyr")) return fromPer100(62, 11, 4, 0.2, "skyr");
  if (name.includes("almond")) return fromPer100(579, 21.2, 21.6, 49.9, "almonds");
  return null;
}

export async function findFoodCandidates(item: AgentItemInput): Promise<ResolvedItem> {
  const hasAnyUserNutrition =
    item.kcal !== null && item.kcal !== undefined ||
    item.proteinG !== null && item.proteinG !== undefined ||
    item.carbsG !== null && item.carbsG !== undefined ||
    item.fatG !== null && item.fatG !== undefined;

  if (hasAnyUserNutrition) {
    return {
      name: item.name,
      displayName: item.displayName ?? item.name,
      amountGrams: item.amountGrams ?? null,
      kcal: item.kcal ?? null,
      proteinG: item.proteinG ?? null,
      carbsG: item.carbsG ?? null,
      fatG: item.fatG ?? null,
      source: "user",
      confidence: 0.95,
      assumptions: ["Used explicit nutrition from user message."],
      provenance: {
        sourceType: "user",
        label: "User provided",
        url: null,
        rationale: "Direct value override supplied by user.",
      },
    };
  }

  const ranked = await getRankedFoodCandidates(item.name, 5);
  const top = ranked[0];
  if (top) {
    const grams = item.amountGrams ?? 100;
    const scaled = scaleFromPer100g(top, grams);
    const confidence = Math.max(0.35, Math.min(0.95, round1(top.score)));

    return {
      name: item.name,
      displayName: item.displayName ?? item.name,
      amountGrams: item.amountGrams ?? null,
      kcal: scaled.kcal,
      proteinG: scaled.proteinG,
      carbsG: scaled.carbsG,
      fatG: scaled.fatG,
      source: "lookup",
      confidence,
      assumptions: item.amountGrams ? [] : ["No grams provided; assumed 100g for lookup values."],
      provenance: {
        sourceType: top.sourceType,
        label: top.sourceLabel,
        url: top.url,
        rationale: top.rationale,
      },
    };
  }

  const fallback = estimateFromCommonFood(item);
  if (fallback) {
    return fallback;
  }

  return {
    name: item.name,
    displayName: item.displayName ?? item.name,
    amountGrams: item.amountGrams ?? null,
    kcal: null,
    proteinG: null,
    carbsG: null,
    fatG: null,
    source: "estimated",
    confidence: 0.25,
    assumptions: ["No reliable candidate found."],
    provenance: {
      sourceType: null,
      label: null,
      url: null,
      rationale: "Could not resolve nutrition confidently.",
    },
  };
}
