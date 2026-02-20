export type MealItemDraft = {
  name: string;
  displayName?: string;
  quantity?: number;
  unit?: string;
  size?: "small" | "medium" | "large";
  amountGrams?: number;
  kcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  assumptions: string[];
  source: "user" | "mixed" | "lookup" | "estimated" | "agent";
};

export type MealDraftV2 = {
  intent: "log_meal";
  rawText: string;
  items: MealItemDraft[];
  assumptions: string[];
  confidence: "low" | "medium" | "high";
};

export type MealTotals = {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

const EGG_GRAMS_BY_SIZE: Record<"small" | "medium" | "large", number> = {
  small: 40,
  medium: 50,
  large: 60,
};

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeUnit(unit?: string): string | undefined {
  if (!unit) return undefined;
  const normalized = unit.toLowerCase().trim();
  if (["g", "gram", "grams"].includes(normalized)) return "g";
  if (["kg", "kilogram", "kilograms"].includes(normalized)) return "kg";
  if (["egg", "eggs", "piece", "pieces"].includes(normalized)) return "piece";
  if (["pack", "packs", "package", "pkg"].includes(normalized)) return "pack";
  return normalized;
}

export function normalizeItemQuantity(item: MealItemDraft): MealItemDraft {
  const normalized: MealItemDraft = {
    ...item,
    assumptions: [...item.assumptions],
    unit: normalizeUnit(item.unit),
  };

  if (normalized.amountGrams !== undefined) {
    return normalized;
  }

  if (normalized.quantity !== undefined && normalized.unit === "g") {
    normalized.amountGrams = normalized.quantity;
    return normalized;
  }

  if (normalized.quantity !== undefined && normalized.unit === "kg") {
    normalized.amountGrams = normalized.quantity * 1000;
    normalized.assumptions.push("Converted kilograms to grams.");
    return normalized;
  }

  const lowerName = normalized.name.toLowerCase();
  if (
    normalized.quantity !== undefined &&
    (normalized.unit === "piece" || normalized.unit === undefined) &&
    (lowerName.includes("egg") || lowerName.includes("eggs"))
  ) {
    const size = normalized.size ?? "medium";
    const gramsPerEgg = EGG_GRAMS_BY_SIZE[size];
    normalized.amountGrams = normalized.quantity * gramsPerEgg;
    normalized.assumptions.push(
      `Converted ${normalized.quantity} ${size} egg(s) to ${normalized.amountGrams}g (${gramsPerEgg}g each).`
    );
  }

  return normalized;
}

export function getUserFacingItemLabel(item: MealItemDraft): string {
  if (item.displayName && item.displayName.trim().length > 0) {
    return item.displayName.trim();
  }

  if (item.quantity !== undefined && item.unit) {
    if (item.unit === "piece" && item.name.toLowerCase().includes("egg")) {
      return `${item.quantity} eggs`;
    }
    const unit = item.unit === "piece" ? "pieces" : item.unit;
    return `${item.quantity} ${unit} ${item.name}`.trim();
  }

  if (item.amountGrams !== undefined) {
    return `${item.amountGrams}g ${item.name}`.trim();
  }

  return item.name;
}

export function estimateCaloriesFromMacros(item: MealItemDraft): MealItemDraft {
  if (
    item.kcal === undefined &&
    item.proteinG !== undefined &&
    item.carbsG !== undefined &&
    item.fatG !== undefined
  ) {
    return {
      ...item,
      kcal: roundToSingleDecimal(item.proteinG * 4 + item.carbsG * 4 + item.fatG * 9),
      source: item.source === "agent" ? "estimated" : item.source,
      assumptions: [
        ...item.assumptions,
        "Calories estimated from macros with deterministic 4/4/9 formula.",
      ],
    };
  }
  return item;
}

export function aggregateMealTotals(items: MealItemDraft[]): MealTotals {
  return {
    kcal: roundToSingleDecimal(items.reduce((sum, item) => sum + (item.kcal ?? 0), 0)),
    proteinG: roundToSingleDecimal(items.reduce((sum, item) => sum + (item.proteinG ?? 0), 0)),
    carbsG: roundToSingleDecimal(items.reduce((sum, item) => sum + (item.carbsG ?? 0), 0)),
    fatG: roundToSingleDecimal(items.reduce((sum, item) => sum + (item.fatG ?? 0), 0)),
  };
}
