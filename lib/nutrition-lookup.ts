import { MealDraft } from "@/lib/log-meal";
import { MealItemDraft } from "@/lib/log-meal-items";
import { prisma } from "@/lib/prisma";

type NutritionPer100g = {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

export type LookupSourceType = "consumed_products" | "openfoodfacts_de";

export type NutritionLookupMeta = {
  sourceType: LookupSourceType;
  label: string;
};

const DEFAULT_LOOKUP_GRAMS = 100;

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

async function findConsumedProduct(item: string) {
  const normalizedItem = item.toLowerCase().trim();
  if (!normalizedItem) {
    return null;
  }

  const products = await prisma.consumedProduct.findMany({
    select: {
      id: true,
      name: true,
      aliases: true,
      searchText: true,
      kcalPer100g: true,
      proteinPer100g: true,
      carbsPer100g: true,
      fatPer100g: true,
    },
    take: 200,
  });

  let bestMatch: (typeof products)[number] | null = null;
  let bestScore = 0;

  for (const product of products) {
    const aliases = product.aliases
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const terms = [product.name.toLowerCase(), ...aliases, product.searchText.toLowerCase()];

    const score = terms.reduce((accumulator, term) => {
      if (!term) {
        return accumulator;
      }
      if (normalizedItem.includes(term)) {
        return Math.max(accumulator, term.length + 5);
      }
      if (term.includes(normalizedItem)) {
        return Math.max(accumulator, normalizedItem.length + 2);
      }
      return accumulator;
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = product;
    }
  }

  return bestMatch;
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

  const merged: MealItemDraft = {
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
  };

  return merged;
}

function itemNeedsLookup(item: MealItemDraft): boolean {
  return (
    item.kcal === undefined ||
    item.proteinG === undefined ||
    item.carbsG === undefined ||
    item.fatG === undefined
  );
}

export async function enrichItemWithLookup(
  item: MealItemDraft
): Promise<{ item: MealItemDraft; lookup?: NutritionLookupMeta }> {
  if (!itemNeedsLookup(item)) {
    return { item };
  }

  const amountForScale = item.amountGrams ?? DEFAULT_LOOKUP_GRAMS;

  try {
    const consumedHit = await findConsumedProduct(item.name);
    if (consumedHit) {
      const nutrition = scaleFromPer100g(
        {
          kcal: consumedHit.kcalPer100g,
          proteinG: consumedHit.proteinPer100g,
          carbsG: consumedHit.carbsPer100g,
          fatG: consumedHit.fatPer100g,
        },
        amountForScale
      );

      const lookup = {
        sourceType: "consumed_products" as const,
        label: `Consumed products DB (${consumedHit.name})`,
      };
      return {
        item: mergeNutritionWithItem(item, nutrition, lookup),
        lookup,
      };
    }
  } catch (error) {
    console.error("[nutrition-lookup] Consumed products DB lookup failed.", {
      item: item.name,
      error,
    });
  }

  try {
    const nutritionPer100g = await searchOpenFoodFactsGermany(item.name);
    if (!nutritionPer100g) {
      return { item };
    }

    const lookup = {
      sourceType: "openfoodfacts_de" as const,
      label: "OpenFoodFacts Germany",
    };

    return {
      item: mergeNutritionWithItem(item, scaleFromPer100g(nutritionPer100g, amountForScale), lookup),
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

export async function enrichDraftWithLookup(
  draft: MealDraft
): Promise<{ draft: MealDraft; lookup?: NutritionLookupMeta }> {
  if (!maybeNeedsLookup(draft)) {
    return { draft };
  }

  const amountForScale = draft.amountGrams ?? DEFAULT_LOOKUP_GRAMS;

  try {
    const consumedHit = await findConsumedProduct(draft.item);
    if (consumedHit) {
      const nutrition = scaleFromPer100g(
        {
          kcal: consumedHit.kcalPer100g,
          proteinG: consumedHit.proteinPer100g,
          carbsG: consumedHit.carbsPer100g,
          fatG: consumedHit.fatPer100g,
        },
        amountForScale
      );

      const lookup = {
        sourceType: "consumed_products" as const,
        label: `Consumed products DB (${consumedHit.name})`,
      };
      return {
        draft: mergeNutritionWithDraft(draft, nutrition, lookup),
        lookup,
      };
    }
  } catch (error) {
    console.error("[nutrition-lookup] Consumed products DB lookup failed.", {
      item: draft.item,
      error,
    });
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
