export type MealDraft = {
  intent: "log_meal";
  rawText: string;
  item: string;
  amountGrams?: number;
  kcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  source: "user" | "mixed" | "lookup" | "estimated" | "agent";
  assumptions: string[];
  confidence: "low" | "medium" | "high";
};

const NUMBER_CAPTURE = "(\\d+(?:[.,]\\d+)?)";
const DEFAULT_LOOKUP_GRAMS = 100;

type NutritionPer100g = {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  aliases: string[];
  source: string;
};

const GERMANY_FOOD_REFERENCE: NutritionPer100g[] = [
  {
    kcal: 67,
    proteinG: 12,
    carbsG: 4,
    fatG: 0.2,
    aliases: ["skyr", "magerquark", "quark"],
    source: "German dairy reference (quark/skyr, per 100g)",
  },
  {
    kcal: 52,
    proteinG: 0.3,
    carbsG: 14,
    fatG: 0.2,
    aliases: ["apple", "apfel"],
    source: "German fruit reference (apple, per 100g)",
  },
  {
    kcal: 131,
    proteinG: 2.7,
    carbsG: 28,
    fatG: 0.3,
    aliases: ["rice", "reis", "cooked rice"],
    source: "German staple reference (cooked rice, per 100g)",
  },
  {
    kcal: 165,
    proteinG: 31,
    carbsG: 0,
    fatG: 3.6,
    aliases: ["chicken breast", "hahnchenbrust", "hähnchenbrust", "chicken"],
    source: "German poultry reference (chicken breast, per 100g)",
  },
  {
    kcal: 247,
    proteinG: 13,
    carbsG: 41,
    fatG: 3.5,
    aliases: ["brotchen", "brötchen", "bread roll"],
    source: "German bakery reference (bread roll, per 100g)",
  },
];

function parseNumber(value: string): number {
  return Number(value.replace(",", "."));
}

function captureValue(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }

  return parseNumber(match[1]);
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function inferItem(text: string): string {
  const stopWords = new Set([
    "i",
    "ate",
    "had",
    "for",
    "breakfast",
    "lunch",
    "dinner",
    "snack",
    "with",
    "and",
    "plus",
    "a",
    "an",
    "the",
    "of",
    "my",
  ]);

  const cleaned = text
    .toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\s?(g|gram|grams|kcal|cal|protein|carbs|fat)\b/g, "")
    .replace(/[^\w\s]/g, " ")
    .trim();

  const words = cleaned
    .split(/\s+/)
    .filter((word) => word.length > 1 && !stopWords.has(word));

  if (words.length === 0) {
    return "unknown meal";
  }

  return words.slice(0, 4).join(" ");
}

function lookupNutrition(rawText: string, inferredItem: string): NutritionPer100g | undefined {
  const haystack = `${rawText.toLowerCase()} ${inferredItem.toLowerCase()}`;
  return GERMANY_FOOD_REFERENCE.find((entry) =>
    entry.aliases.some((alias) => haystack.includes(alias))
  );
}

function scaleNutrition(base: NutritionPer100g, grams: number) {
  const factor = grams / 100;
  return {
    kcal: roundToSingleDecimal(base.kcal * factor),
    proteinG: roundToSingleDecimal(base.proteinG * factor),
    carbsG: roundToSingleDecimal(base.carbsG * factor),
    fatG: roundToSingleDecimal(base.fatG * factor),
  };
}

export function parseLogMeal(text: string): MealDraft {
  const normalized = normalizeText(text);
  const assumptions: string[] = [];

  const amountGrams = captureValue(
    normalized,
    new RegExp(`${NUMBER_CAPTURE}\\s?(?:g|gram|grams)\\b`, "i")
  );
  const kcal = captureValue(
    normalized,
    new RegExp(`${NUMBER_CAPTURE}\\s?(?:kcal|calories|cal)\\b`, "i")
  );
  const proteinG = captureValue(
    normalized,
    new RegExp(`(?:protein|p)\\s?${NUMBER_CAPTURE}\\s?g\\b`, "i")
  );
  const carbsG = captureValue(
    normalized,
    new RegExp(`(?:carbs|carbohydrates|c)\\s?${NUMBER_CAPTURE}\\s?g\\b`, "i")
  );
  const fatG = captureValue(
    normalized,
    new RegExp(`(?:fat|f)\\s?${NUMBER_CAPTURE}\\s?g\\b`, "i")
  );
  const item = inferItem(normalized);
  const lookup = lookupNutrition(normalized, item);
  const lookupGrams = amountGrams ?? (lookup ? DEFAULT_LOOKUP_GRAMS : undefined);
  const scaledLookup = lookup && lookupGrams ? scaleNutrition(lookup, lookupGrams) : undefined;

  const finalProtein = proteinG ?? scaledLookup?.proteinG;
  const finalCarbs = carbsG ?? scaledLookup?.carbsG;
  const finalFat = fatG ?? scaledLookup?.fatG;

  let finalKcal = kcal ?? scaledLookup?.kcal;
  if (finalKcal === undefined && finalProtein !== undefined && finalCarbs !== undefined && finalFat !== undefined) {
    finalKcal = roundToSingleDecimal(finalProtein * 4 + finalCarbs * 4 + finalFat * 9);
    assumptions.push("Calories estimated from macros with deterministic 4/4/9 formula.");
  }

  if (item === "unknown meal") {
    assumptions.push("Could not identify food item; kept generic meal label.");
  }

  if (amountGrams === undefined) {
    assumptions.push("No amount in grams provided.");
  }

  if (kcal === undefined && scaledLookup?.kcal !== undefined) {
    assumptions.push(`Calories filled from Germany-focused lookup (${lookup?.source}).`);
  } else if (kcal === undefined) {
    assumptions.push("No calories provided.");
  }

  if (
    proteinG === undefined &&
    scaledLookup?.proteinG !== undefined &&
    carbsG === undefined &&
    scaledLookup?.carbsG !== undefined &&
    fatG === undefined &&
    scaledLookup?.fatG !== undefined
  ) {
    assumptions.push(`Macros filled from Germany-focused lookup (${lookup?.source}).`);
  } else if (proteinG === undefined || carbsG === undefined || fatG === undefined) {
    assumptions.push("Missing one or more macros (protein/carbs/fat).");
  }

  if (lookup && amountGrams === undefined) {
    assumptions.push("No grams provided; used 100g default for lookup values.");
  }

  let source: MealDraft["source"] = "user";
  if (
    kcal === undefined &&
    proteinG === undefined &&
    carbsG === undefined &&
    fatG === undefined &&
    scaledLookup
  ) {
    source = "lookup";
  } else if (
    (kcal === undefined || proteinG === undefined || carbsG === undefined || fatG === undefined) &&
    scaledLookup
  ) {
    source = "mixed";
  } else if (kcal === undefined && finalKcal !== undefined) {
    source = "estimated";
  }

  const confidence: MealDraft["confidence"] =
    assumptions.length === 0 ? "high" : assumptions.length <= 2 ? "medium" : "low";

  return {
    intent: "log_meal",
    rawText: normalized,
    item,
    amountGrams,
    kcal: finalKcal,
    proteinG: finalProtein,
    carbsG: finalCarbs,
    fatG: finalFat,
    source,
    assumptions,
    confidence,
  };
}
