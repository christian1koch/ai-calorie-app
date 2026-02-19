export type MealDraft = {
  intent: "log_meal";
  rawText: string;
  item: string;
  amountGrams?: number;
  kcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  assumptions: string[];
  confidence: "low" | "medium" | "high";
};

const NUMBER_CAPTURE = "(\\d+(?:[.,]\\d+)?)";

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

  if (item === "unknown meal") {
    assumptions.push("Could not identify food item; kept generic meal label.");
  }

  if (amountGrams === undefined) {
    assumptions.push("No amount in grams provided.");
  }

  if (kcal === undefined) {
    assumptions.push("No calories provided.");
  }

  if (proteinG === undefined || carbsG === undefined || fatG === undefined) {
    assumptions.push("Missing one or more macros (protein/carbs/fat).");
  }

  const confidence: MealDraft["confidence"] =
    assumptions.length === 0 ? "high" : assumptions.length <= 2 ? "medium" : "low";

  return {
    intent: "log_meal",
    rawText: normalized,
    item,
    amountGrams,
    kcal,
    proteinG,
    carbsG,
    fatG,
    assumptions,
    confidence,
  };
}
