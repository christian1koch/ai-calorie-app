import { MealDraft } from "@/lib/log-meal";
import { MealItemDraft } from "@/lib/log-meal-items";

type NutritionPer100g = {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

export type LookupSourceType = "openfoodfacts_de";

export type NutritionLookupMeta = {
  sourceType: LookupSourceType;
  label: string;
  url?: string;
};

export type NutritionCandidate = {
  id: string;
  name: string;
  brand?: string;
  kcalPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
  url: string;
  sourceType: LookupSourceType;
  sourceLabel: string;
};

const DEFAULT_LOOKUP_GRAMS = 100;

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export function scaleFromPer100g(
  nutrition: {
    kcalPer100g: number;
    proteinPer100g: number;
    carbsPer100g: number;
    fatPer100g: number;
  },
  amountGrams: number
): NutritionPer100g {
  const factor = amountGrams / 100;
  return {
    kcal: roundToSingleDecimal(nutrition.kcalPer100g * factor),
    proteinG: roundToSingleDecimal(nutrition.proteinPer100g * factor),
    carbsG: roundToSingleDecimal(nutrition.carbsPer100g * factor),
    fatG: roundToSingleDecimal(nutrition.fatPer100g * factor),
  };
}

function itemNeedsLookup(item: MealItemDraft): boolean {
  return (
    item.kcal === undefined ||
    item.proteinG === undefined ||
    item.carbsG === undefined ||
    item.fatG === undefined
  );
}

function maybeNeedsLookup(draft: MealDraft): boolean {
  return (
    draft.kcal === undefined ||
    draft.proteinG === undefined ||
    draft.carbsG === undefined ||
    draft.fatG === undefined
  );
}

function openFoodFactsSearchUrl(item: string): string {
  const params = new URLSearchParams({
    search_terms: item,
    search_simple: "1",
    action: "process",
    page_size: "20",
    countries_tags: "de",
  });
  return `https://world.openfoodfacts.org/cgi/search.pl?${params.toString()}`;
}

function openFoodFactsProductUrl(code: string): string {
  return `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}`;
}

export async function getOpenFoodFactsCandidates(
  item: string,
  limit = 8
): Promise<NutritionCandidate[]> {
  const params = new URLSearchParams({
    search_terms: item,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: String(Math.max(1, Math.min(limit, 20))),
    countries_tags: "de",
  });

  const response = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?${params.toString()}`, {
    method: "GET",
    headers: {
      "User-Agent": "ai-calorie-app/0.1 (nutrition lookup)",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as {
    products?: Array<{
      code?: string;
      product_name?: string;
      brands?: string;
      nutriments?: Record<string, number | string | undefined>;
    }>;
  };

  const out: NutritionCandidate[] = [];
  for (const [index, product] of (payload.products ?? []).entries()) {
    const nutriments = product.nutriments;
    if (!nutriments) continue;

    const kcalRaw = nutriments["energy-kcal_100g"] ?? nutriments["energy-kcal"];
    const kcal = typeof kcalRaw === "number" ? kcalRaw : Number(kcalRaw);
    const protein = Number(nutriments.proteins_100g);
    const carbs = Number(nutriments.carbohydrates_100g);
    const fat = Number(nutriments.fat_100g);
    if (![kcal, protein, carbs, fat].every((value) => Number.isFinite(value))) {
      continue;
    }

    const id = product.code ? `off_${product.code}` : `off_idx_${index}_${item}`;
    const url = product.code ? openFoodFactsProductUrl(product.code) : openFoodFactsSearchUrl(item);
    out.push({
      id,
      name: product.product_name?.trim() || item,
      brand: product.brands?.trim() || undefined,
      kcalPer100g: roundToSingleDecimal(kcal),
      proteinPer100g: roundToSingleDecimal(protein),
      carbsPer100g: roundToSingleDecimal(carbs),
      fatPer100g: roundToSingleDecimal(fat),
      url,
      sourceType: "openfoodfacts_de",
      sourceLabel: "OpenFoodFacts Germany",
    });
  }

  return out;
}

function mergeNutritionWithItem(
  item: MealItemDraft,
  nutritionForAmount: NutritionPer100g,
  source: NutritionLookupMeta
) {
  const assumptions = [...item.assumptions];
  assumptions.push(`Lookup source used: ${source.label}.`);
  if (item.amountGrams === undefined) {
    assumptions.push("No grams provided; lookup assumed 100g.");
  }

  return {
    ...item,
    kcal: item.kcal ?? nutritionForAmount.kcal,
    proteinG: item.proteinG ?? nutritionForAmount.proteinG,
    carbsG: item.carbsG ?? nutritionForAmount.carbsG,
    fatG: item.fatG ?? nutritionForAmount.fatG,
    source:
      item.kcal === undefined &&
      item.proteinG === undefined &&
      item.carbsG === undefined &&
      item.fatG === undefined
        ? "lookup"
        : "mixed",
    assumptions: Array.from(new Set(assumptions)),
  } satisfies MealItemDraft;
}

function mergeNutritionWithDraft(
  draft: MealDraft,
  nutritionForAmount: NutritionPer100g,
  source: NutritionLookupMeta
) {
  const assumptions = [...draft.assumptions];
  assumptions.push(`Lookup source used: ${source.label}.`);
  if (draft.amountGrams === undefined) {
    assumptions.push("No grams provided; lookup assumed 100g.");
  }

  return {
    ...draft,
    kcal: draft.kcal ?? nutritionForAmount.kcal,
    proteinG: draft.proteinG ?? nutritionForAmount.proteinG,
    carbsG: draft.carbsG ?? nutritionForAmount.carbsG,
    fatG: draft.fatG ?? nutritionForAmount.fatG,
    source:
      draft.kcal === undefined &&
      draft.proteinG === undefined &&
      draft.carbsG === undefined &&
      draft.fatG === undefined
        ? "lookup"
        : "mixed",
    assumptions: Array.from(new Set(assumptions)),
  } satisfies MealDraft;
}

// Compatibility path for older callers. Uses the top web candidate directly.
export async function enrichItemWithLookup(
  item: MealItemDraft
): Promise<{ item: MealItemDraft; lookup?: NutritionLookupMeta }> {
  if (!itemNeedsLookup(item)) {
    return { item };
  }

  try {
    const candidates = await getOpenFoodFactsCandidates(item.name, 1);
    const first = candidates[0];
    if (!first) {
      return { item };
    }
    const amountForScale = item.amountGrams ?? DEFAULT_LOOKUP_GRAMS;
    const nutrition = scaleFromPer100g(first, amountForScale);
    const lookup = {
      sourceType: first.sourceType,
      label: first.sourceLabel,
      url: first.url,
    };
    return {
      item: mergeNutritionWithItem(item, nutrition, lookup),
      lookup,
    };
  } catch (error) {
    console.error("[nutrition-lookup] OpenFoodFacts lookup failed.", {
      item: item.name,
      error,
    });
    return { item };
  }
}

// Compatibility path for older callers. Uses the top web candidate directly.
export async function enrichDraftWithLookup(
  draft: MealDraft
): Promise<{ draft: MealDraft; lookup?: NutritionLookupMeta }> {
  if (!maybeNeedsLookup(draft)) {
    return { draft };
  }

  try {
    const candidates = await getOpenFoodFactsCandidates(draft.item, 1);
    const first = candidates[0];
    if (!first) {
      return { draft };
    }
    const amountForScale = draft.amountGrams ?? DEFAULT_LOOKUP_GRAMS;
    const nutrition = scaleFromPer100g(first, amountForScale);
    const lookup = {
      sourceType: first.sourceType,
      label: first.sourceLabel,
      url: first.url,
    };
    return {
      draft: mergeNutritionWithDraft(draft, nutrition, lookup),
      lookup,
    };
  } catch (error) {
    console.error("[nutrition-lookup] OpenFoodFacts lookup failed.", {
      item: draft.item,
      error,
    });
    return { draft };
  }
}
