import { MealDraft } from "@/lib/log-meal";
import { MealItemDraft } from "@/lib/log-meal-items";

type NutritionPer100g = {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

export type LookupSourceType = "openfoodfacts_de" | "openfoodfacts_global" | "openfoodfacts_web";

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

export type RankedNutritionCandidate = NutritionCandidate & {
  score: number;
  rationale: string;
};

const DEFAULT_LOOKUP_GRAMS = 100;
const LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;
const lookupCache = new Map<string, { expiresAt: number; value: NutritionCandidate[] }>();

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

function openFoodFactsSearchUrl(item: string, countryTag?: string): string {
  const params = new URLSearchParams({
    search_terms: item,
    search_simple: "1",
    action: "process",
    page_size: "20",
  });
  if (countryTag) {
    params.set("countries_tags", countryTag);
  }
  return `https://world.openfoodfacts.org/cgi/search.pl?${params.toString()}`;
}

function openFoodFactsSearchJsonUrl(item: string, limit: number, countryTag?: string): string {
  const params = new URLSearchParams({
    search_terms: item,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: String(Math.max(1, Math.min(limit, 20))),
  });
  if (countryTag) {
    params.set("countries_tags", countryTag);
  }
  return `https://world.openfoodfacts.org/cgi/search.pl?${params.toString()}`;
}

function openFoodFactsProductUrl(code: string): string {
  return `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}`;
}

type OpenFoodFactsProduct = {
  code?: string;
  product_name?: string;
  brands?: string;
  nutriments?: Record<string, number | string | undefined>;
};

function candidatesFromProducts(
  item: string,
  products: OpenFoodFactsProduct[],
  sourceType: LookupSourceType,
  sourceLabel: string
): NutritionCandidate[] {
  const out: NutritionCandidate[] = [];

  for (const [index, product] of products.entries()) {
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
      sourceType,
      sourceLabel,
    });
  }

  return out;
}

async function searchOpenFoodFacts(
  item: string,
  limit: number,
  opts: { countryTag?: string; sourceType: LookupSourceType; sourceLabel: string }
): Promise<NutritionCandidate[]> {
  const response = await fetch(openFoodFactsSearchJsonUrl(item, limit, opts.countryTag), {
    method: "GET",
    headers: {
      "User-Agent": "ai-calorie-app/0.1 (nutrition lookup)",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as { products?: OpenFoodFactsProduct[] };
  return candidatesFromProducts(item, payload.products ?? [], opts.sourceType, opts.sourceLabel);
}

function extractOpenFoodFactsCodesFromHtml(html: string): string[] {
  const codes = new Set<string>();

  const plainRegex = /https?:\/\/world\.openfoodfacts\.org\/product\/([A-Za-z0-9_-]+)/g;
  for (const match of html.matchAll(plainRegex)) {
    if (match[1]) codes.add(match[1]);
  }

  const encodedRegex = /world\.openfoodfacts\.org%2Fproduct%2F([A-Za-z0-9_-]+)/g;
  for (const match of html.matchAll(encodedRegex)) {
    if (match[1]) {
      try {
        codes.add(decodeURIComponent(match[1]));
      } catch {
        codes.add(match[1]);
      }
    }
  }

  return Array.from(codes);
}

async function getOpenFoodFactsProductByCode(code: string): Promise<OpenFoodFactsProduct | null> {
  const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`, {
    method: "GET",
    headers: {
      "User-Agent": "ai-calorie-app/0.1 (nutrition lookup)",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { product?: OpenFoodFactsProduct | null };
  return payload.product ?? null;
}

async function browseInternetForOpenFoodFacts(item: string, limit: number): Promise<NutritionCandidate[]> {
  const query = encodeURIComponent(`${item} site:openfoodfacts.org/product`);
  const response = await fetch(`https://duckduckgo.com/html/?q=${query}`, {
    method: "GET",
    headers: {
      "User-Agent": "ai-calorie-app/0.1 (web browse lookup)",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return [];
  }

  const html = await response.text();
  const codes = extractOpenFoodFactsCodesFromHtml(html).slice(0, limit);
  if (codes.length === 0) {
    return [];
  }

  const products = await Promise.all(codes.map((code) => getOpenFoodFactsProductByCode(code)));
  const hydrated = products.filter((value): value is OpenFoodFactsProduct => Boolean(value));
  return candidatesFromProducts(item, hydrated, "openfoodfacts_web", "OpenFoodFacts (Web Browse)");
}

export async function getOpenFoodFactsCandidates(
  item: string,
  limit = 8
): Promise<NutritionCandidate[]> {
  const cacheKey = `${item.toLowerCase().trim()}::${Math.max(1, Math.min(limit, 20))}`;
  const cached = lookupCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const normalizedLimit = Math.max(1, Math.min(limit, 20));
  const merged = new Map<string, NutritionCandidate>();

  const deCandidates = await searchOpenFoodFacts(item, normalizedLimit, {
    countryTag: "de",
    sourceType: "openfoodfacts_de",
    sourceLabel: "OpenFoodFacts Germany",
  });
  for (const candidate of deCandidates) {
    merged.set(candidate.id, candidate);
  }

  if (merged.size < normalizedLimit) {
    const globalCandidates = await searchOpenFoodFacts(item, normalizedLimit, {
      sourceType: "openfoodfacts_global",
      sourceLabel: "OpenFoodFacts Global",
    });
    for (const candidate of globalCandidates) {
      if (!merged.has(candidate.id)) {
        merged.set(candidate.id, candidate);
      }
      if (merged.size >= normalizedLimit) break;
    }
  }

  if (merged.size === 0) {
    const webCandidates = await browseInternetForOpenFoodFacts(item, normalizedLimit);
    for (const candidate of webCandidates) {
      if (!merged.has(candidate.id)) {
        merged.set(candidate.id, candidate);
      }
      if (merged.size >= normalizedLimit) break;
    }
  }

  const results = Array.from(merged.values()).slice(0, normalizedLimit);
  lookupCache.set(cacheKey, {
    expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS,
    value: results,
  });
  return results;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export async function getRankedFoodCandidates(
  item: string,
  limit = 5
): Promise<RankedNutritionCandidate[]> {
  const candidates = await getOpenFoodFactsCandidates(item, Math.max(limit, 8));
  const itemTokens = new Set(tokenize(item));
  if (itemTokens.size === 0) {
    return candidates.slice(0, limit).map((candidate) => ({
      ...candidate,
      score: 0.5,
      rationale: "No strong tokens found in user phrase; returned best available candidates.",
    }));
  }

  const ranked = candidates
    .map((candidate) => {
      const candidateTokens = new Set(tokenize(`${candidate.name} ${candidate.brand ?? ""}`));
      let overlap = 0;
      for (const token of itemTokens) {
        if (candidateTokens.has(token)) overlap += 1;
      }
      const overlapScore = overlap / itemTokens.size;
      const sourceBonus =
        candidate.sourceType === "openfoodfacts_de"
          ? 0.12
          : candidate.sourceType === "openfoodfacts_global"
            ? 0.08
            : 0.04;
      const score = Math.max(0, Math.min(1, roundToSingleDecimal(overlapScore + sourceBonus)));
      return {
        ...candidate,
        score,
        rationale:
          overlap > 0
            ? `Token overlap ${overlap}/${itemTokens.size}; preferred ${candidate.sourceLabel}.`
            : `No direct token overlap; kept for fallback from ${candidate.sourceLabel}.`,
      } satisfies RankedNutritionCandidate;
    })
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, limit);
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
