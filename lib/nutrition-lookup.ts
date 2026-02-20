import { MealDraft } from "@/lib/log-meal";

type NutritionPer100g = {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

type ConsumedProduct = {
  name: string;
  aliases: string[];
  nutritionPer100g: NutritionPer100g;
};

export type LookupSourceType = "consumed_products" | "openfoodfacts_de";

export type NutritionLookupMeta = {
  sourceType: LookupSourceType;
  label: string;
};

const DEFAULT_LOOKUP_GRAMS = 100;

const CONSUMED_PRODUCTS_DB: ConsumedProduct[] = [
  {
    name: "Milbona Skyr Natur",
    aliases: ["skyr", "milbona skyr", "natur skyr"],
    nutritionPer100g: { kcal: 62, proteinG: 11, carbsG: 3.9, fatG: 0.2 },
  },
  {
    name: "Magerquark",
    aliases: ["quark", "magerquark"],
    nutritionPer100g: { kcal: 67, proteinG: 12, carbsG: 4, fatG: 0.2 },
  },
  {
    name: "Haferflocken",
    aliases: ["oats", "haferflocken"],
    nutritionPer100g: { kcal: 372, proteinG: 13.5, carbsG: 58.7, fatG: 7 },
  },
];

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function scaleFromPer100g(nutrition: NutritionPer100g, amountGrams: number): NutritionPer100g {
  const factor = amountGrams / 100;
  return {
    kcal: roundToSingleDecimal(nutrition.kcal * factor),
    proteinG: roundToSingleDecimal(nutrition.proteinG * factor),
    carbsG: roundToSingleDecimal(nutrition.carbsG * factor),
    fatG: roundToSingleDecimal(nutrition.fatG * factor),
  };
}

function maybeNeedsLookup(draft: MealDraft): boolean {
  return (
    draft.kcal === undefined ||
    draft.proteinG === undefined ||
    draft.carbsG === undefined ||
    draft.fatG === undefined
  );
}

function findConsumedProduct(item: string): ConsumedProduct | undefined {
  const normalizedItem = item.toLowerCase();
  return CONSUMED_PRODUCTS_DB.find((product) =>
    product.aliases.some((alias) => normalizedItem.includes(alias))
  );
}

async function searchOpenFoodFactsGermany(item: string): Promise<NutritionPer100g | undefined> {
  const params = new URLSearchParams({
    search_terms: item,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: "1",
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
    return undefined;
  }

  const payload = (await response.json()) as {
    products?: Array<{
      nutriments?: Record<string, number | string | undefined>;
    }>;
  };
  const nutriments = payload.products?.[0]?.nutriments;
  if (!nutriments) {
    return undefined;
  }

  const kcalRaw = nutriments["energy-kcal_100g"] ?? nutriments["energy-kcal"];
  const kcal = typeof kcalRaw === "number" ? kcalRaw : Number(kcalRaw);
  const protein = Number(nutriments.proteins_100g);
  const carbs = Number(nutriments.carbohydrates_100g);
  const fat = Number(nutriments.fat_100g);

  if (![kcal, protein, carbs, fat].every((value) => Number.isFinite(value))) {
    return undefined;
  }

  return {
    kcal: roundToSingleDecimal(kcal),
    proteinG: roundToSingleDecimal(protein),
    carbsG: roundToSingleDecimal(carbs),
    fatG: roundToSingleDecimal(fat),
  };
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

  const updated: MealDraft = {
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
  };

  return updated;
}

export async function enrichDraftWithLookup(
  draft: MealDraft
): Promise<{ draft: MealDraft; lookup?: NutritionLookupMeta }> {
  if (!maybeNeedsLookup(draft)) {
    return { draft };
  }

  const amountForScale = draft.amountGrams ?? DEFAULT_LOOKUP_GRAMS;

  const consumedHit = findConsumedProduct(draft.item);
  if (consumedHit) {
    const nutrition = scaleFromPer100g(consumedHit.nutritionPer100g, amountForScale);
    const lookup = {
      sourceType: "consumed_products" as const,
      label: `Consumed products DB (${consumedHit.name})`,
    };
    return {
      draft: mergeNutritionWithDraft(draft, nutrition, lookup),
      lookup,
    };
  }

  try {
    const nutritionPer100g = await searchOpenFoodFactsGermany(draft.item);
    if (!nutritionPer100g) {
      return { draft };
    }

    const lookup = {
      sourceType: "openfoodfacts_de" as const,
      label: "OpenFoodFacts Germany",
    };

    return {
      draft: mergeNutritionWithDraft(
        draft,
        scaleFromPer100g(nutritionPer100g, amountForScale),
        lookup
      ),
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
