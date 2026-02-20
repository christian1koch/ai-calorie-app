import { NextResponse } from "next/server";
import { getOpenFoodFactsCandidates, scaleFromPer100g, type NutritionCandidate } from "@/lib/nutrition-lookup";
import { prisma } from "@/lib/prisma";
import { getBerlinNow } from "@/lib/berlin-time";
import {
  MealDraftV2,
  MealItemDraft,
  aggregateMealTotals,
  estimateCaloriesFromMacros,
  getUserFacingItemLabel,
  normalizeItemQuantity,
} from "@/lib/log-meal-items";

type LogMealRequest = {
  text?: string;
  context?: {
    activeMealId?: number | null;
  };
};

type AgentItemExtraction = {
  name: string;
  displayName: string | null;
  quantity: number | null;
  unit: string | null;
  size: "small" | "medium" | "large" | null;
  amountGrams: number | null;
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
};

type AgentCommand = {
  action: "log_meal" | "list_meals" | "delete_meal" | "add_to_meal";
  targetMealId: number | null;
  targetReference: "this_meal" | "latest" | "explicit_id" | "none";
  items: AgentItemExtraction[];
  assumptions: string[];
  confidence: "low" | "medium" | "high";
};

type ItemSelectionResult = {
  decision: "select_candidate" | "estimate" | "clarify";
  selectedCandidateId: string | null;
  confidence: "low" | "medium" | "high";
  rationale: string;
  estimated: {
    kcal: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
  };
  clarificationQuestion: string | null;
};

type DecisionTraceItem = {
  itemName: string;
  selectedSource: "internet" | "user" | "estimated";
  confidence: "low" | "medium" | "high";
  rationale: string;
  lookupLabel?: string;
  lookupUrl?: string;
};

type ResolvedDraftResult =
  | {
      status: "clarify";
      assistantText: string;
      draft: MealDraftV2;
      decisionTrace: DecisionTraceItem[];
    }
  | {
      status: "ok";
      draft: MealDraftV2;
      decisionTrace: DecisionTraceItem[];
    };

const ITEM_STOPWORDS = new Set([
  "from",
  "the",
  "and",
  "with",
  "of",
  "a",
  "an",
  "to",
  "for",
  "in",
  "rewe",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 2 && !ITEM_STOPWORDS.has(value));
}

function candidateOverlapScore(itemName: string, candidateName: string, brand?: string): number {
  const itemTokens = tokenize(itemName);
  if (itemTokens.length === 0) return 0;
  const candidateTokens = new Set([...tokenize(candidateName), ...tokenize(brand ?? "")]);
  const overlap = itemTokens.filter((token) => candidateTokens.has(token)).length;
  return overlap / itemTokens.length;
}

function candidateIsPlausibleForItem(
  itemName: string,
  candidate: { name: string; brand?: string; kcalPer100g: number; proteinPer100g: number; carbsPer100g: number; fatPer100g: number }
): boolean {
  const eggTerms = ["egg", "eggs", "ei", "eier"];
  const macroSum = candidate.proteinPer100g + candidate.carbsPer100g + candidate.fatPer100g;
  if (candidate.kcalPer100g <= 0 || candidate.kcalPer100g > 900) {
    return false;
  }
  if (macroSum <= 0 || macroSum > 105) {
    return false;
  }

  const itemTokens = tokenize(itemName);
  const candidateTokens = tokenize(`${candidate.name} ${candidate.brand ?? ""}`);
  const looksLikeEggItem = itemTokens.some((token) => eggTerms.includes(token));
  if (looksLikeEggItem) {
    const candidateHasEggTerm = candidateTokens.some((token) => eggTerms.includes(token));
    if (!candidateHasEggTerm) {
      return false;
    }
    if (candidate.carbsPer100g > 10) {
      return false;
    }
  }
  const overlap = candidateOverlapScore(itemName, candidate.name, candidate.brand);
  if (overlap <= 0) {
    return false;
  }
  return true;
}

function bestFallbackCandidate(
  item: MealItemDraft,
  candidates: NutritionCandidate[]
): NutritionCandidate | undefined {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      overlap: candidateOverlapScore(item.name, candidate.name, candidate.brand),
      plausible: candidateIsPlausibleForItem(item.name, candidate),
    }))
    .filter((value) => value.plausible)
    .sort((a, b) => b.overlap - a.overlap);
  return ranked[0]?.candidate;
}

function extractOutputText(responseBody: unknown): string | null {
  if (!responseBody || typeof responseBody !== "object") {
    return null;
  }

  const withOutputText = responseBody as { output_text?: unknown };
  if (typeof withOutputText.output_text === "string" && withOutputText.output_text.length > 0) {
    return withOutputText.output_text;
  }

  const withOutput = responseBody as {
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };

  for (const item of withOutput.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return null;
}

function logAgentError(message: string, details: unknown) {
  console.error(`[agent/log-meal] ${message}`, details);
}

function hasMealModel() {
  return Boolean((prisma as unknown as { meal?: unknown }).meal);
}

function inferMealLabel(rawText: string): string {
  const lower = rawText.toLowerCase();
  if (lower.includes("breakfast")) return "Breakfast";
  if (lower.includes("lunch")) return "Lunch";
  if (lower.includes("dinner")) return "Dinner";
  if (lower.includes("snack")) return "Snack";
  return "Meal";
}

function toMealItem(item: AgentItemExtraction): MealItemDraft {
  return {
    name: item.name.trim(),
    displayName: item.displayName ?? undefined,
    quantity: item.quantity ?? undefined,
    unit: item.unit ?? undefined,
    size: item.size ?? undefined,
    amountGrams: item.amountGrams ?? undefined,
    kcal: item.kcal ?? undefined,
    proteinG: item.proteinG ?? undefined,
    carbsG: item.carbsG ?? undefined,
    fatG: item.fatG ?? undefined,
    assumptions: [],
    source: "agent",
  };
}

function hasUserProvidedNutrition(item: MealItemDraft): boolean {
  return (
    item.kcal !== undefined ||
    item.proteinG !== undefined ||
    item.carbsG !== undefined ||
    item.fatG !== undefined
  );
}

async function runCommandParser(
  apiKey: string,
  model: string,
  text: string
): Promise<AgentCommand> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are a meal-tracker command parser. Choose exactly one action: log_meal, list_meals, delete_meal, add_to_meal. " +
                "For food logging actions, return one item per food mention. " +
                "Preserve user-visible phrasing in displayName (e.g. '4 medium eggs', '150g laugencroissant from rewe'). " +
                "Use targetReference='this_meal' when user says 'this meal'.",
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "meal_command",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: {
                type: "string",
                enum: ["log_meal", "list_meals", "delete_meal", "add_to_meal"],
              },
              targetMealId: { type: ["number", "null"] },
              targetReference: {
                type: "string",
                enum: ["this_meal", "latest", "explicit_id", "none"],
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    displayName: { type: ["string", "null"] },
                    quantity: { type: ["number", "null"] },
                    unit: { type: ["string", "null"] },
                    size: { type: ["string", "null"], enum: ["small", "medium", "large", null] },
                    amountGrams: { type: ["number", "null"] },
                    kcal: { type: ["number", "null"] },
                    proteinG: { type: ["number", "null"] },
                    carbsG: { type: ["number", "null"] },
                    fatG: { type: ["number", "null"] },
                  },
                  required: [
                    "name",
                    "displayName",
                    "quantity",
                    "unit",
                    "size",
                    "amountGrams",
                    "kcal",
                    "proteinG",
                    "carbsG",
                    "fatG",
                  ],
                },
              },
              assumptions: { type: "array", items: { type: "string" } },
              confidence: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["action", "targetMealId", "targetReference", "items", "assumptions", "confidence"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    let errorBody: unknown = null;
    try {
      errorBody = (await response.json()) as unknown;
    } catch {
      errorBody = await response.text();
    }
    throw new Error(`Command parse failed (${response.status}): ${JSON.stringify(errorBody)}`);
  }

  const raw = (await response.json()) as unknown;
  const output = extractOutputText(raw);
  if (!output) {
    throw new Error("Command parse returned no output text.");
  }
  return JSON.parse(output) as AgentCommand;
}

async function selectCandidateForItem(
  apiKey: string,
  model: string,
  rawText: string,
  item: MealItemDraft
): Promise<{
  item: MealItemDraft;
  trace: DecisionTraceItem;
  requiresClarification: boolean;
  clarificationText?: string;
}> {
  if (hasUserProvidedNutrition(item)) {
    const corrected = estimateCaloriesFromMacros(item);
    return {
      item: corrected,
      trace: {
        itemName: corrected.name,
        selectedSource: "user",
        confidence: "high",
        rationale: "Used explicit user-provided nutrition values.",
      },
      requiresClarification: false,
    };
  }

  const candidates = await getOpenFoodFactsCandidates(item.name, 8);
  if (candidates.length === 0) {
    return {
      item,
      trace: {
        itemName: item.name,
        selectedSource: "estimated",
        confidence: "low",
        rationale: "No viable web candidates found.",
      },
      requiresClarification: true,
      clarificationText: `I could not find a reliable nutrition match for ${getUserFacingItemLabel(item)}. Can you share brand or package details?`,
    };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Pick the best nutrition candidate for the item. Think about name match, brand hints, quantity context, and plausibility. " +
                "Prefer selecting a candidate. Use clarify only if no defensible choice and no plausible estimate exists.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                rawText,
                item: {
                  name: item.name,
                  display: getUserFacingItemLabel(item),
                  amountGrams: item.amountGrams ?? null,
                },
                candidates: candidates.map((candidate) => ({
                  id: candidate.id,
                  name: candidate.name,
                  brand: candidate.brand ?? null,
                  kcalPer100g: candidate.kcalPer100g,
                  proteinPer100g: candidate.proteinPer100g,
                  carbsPer100g: candidate.carbsPer100g,
                  fatPer100g: candidate.fatPer100g,
                  url: candidate.url,
                })),
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "candidate_selection",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              decision: { type: "string", enum: ["select_candidate", "estimate", "clarify"] },
              selectedCandidateId: { type: ["string", "null"] },
              confidence: { type: "string", enum: ["low", "medium", "high"] },
              rationale: { type: "string" },
              estimated: {
                type: "object",
                additionalProperties: false,
                properties: {
                  kcal: { type: ["number", "null"] },
                  proteinG: { type: ["number", "null"] },
                  carbsG: { type: ["number", "null"] },
                  fatG: { type: ["number", "null"] },
                },
                required: ["kcal", "proteinG", "carbsG", "fatG"],
              },
              clarificationQuestion: { type: ["string", "null"] },
            },
            required: [
              "decision",
              "selectedCandidateId",
              "confidence",
              "rationale",
              "estimated",
              "clarificationQuestion",
            ],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    return {
      item,
      trace: {
        itemName: item.name,
        selectedSource: "estimated",
        confidence: "low",
        rationale: "Candidate reasoning call failed.",
      },
      requiresClarification: true,
      clarificationText: `I could not confidently match ${getUserFacingItemLabel(item)}. Can you share brand or product details?`,
    };
  }

  const raw = (await response.json()) as unknown;
  const output = extractOutputText(raw);
  if (!output) {
    return {
      item,
      trace: {
        itemName: item.name,
        selectedSource: "estimated",
        confidence: "low",
        rationale: "Candidate reasoning returned no output.",
      },
      requiresClarification: true,
      clarificationText: `I could not confidently match ${getUserFacingItemLabel(item)}. Can you share brand or product details?`,
    };
  }

  const selection = JSON.parse(output) as ItemSelectionResult;
  if (selection.decision === "clarify") {
    return {
      item,
      trace: {
        itemName: item.name,
        selectedSource: "estimated",
        confidence: selection.confidence,
        rationale: selection.rationale,
      },
      requiresClarification: true,
      clarificationText:
        selection.clarificationQuestion ||
        `I need a bit more detail to identify ${getUserFacingItemLabel(item)} reliably.`,
    };
  }

  if (selection.decision === "select_candidate" && selection.selectedCandidateId) {
    const selected = candidates.find((value) => value.id === selection.selectedCandidateId);
    const selectedPlausible = selected ? candidateIsPlausibleForItem(item.name, selected) : false;
    const candidate =
      selected && selectedPlausible
        ? selected
        : bestFallbackCandidate(item, candidates);
    if (candidate) {
      const amountForScale = item.amountGrams ?? 100;
      const scaled = scaleFromPer100g(candidate, amountForScale);
      const merged = estimateCaloriesFromMacros({
        ...item,
        kcal: item.kcal ?? scaled.kcal,
        proteinG: item.proteinG ?? scaled.proteinG,
        carbsG: item.carbsG ?? scaled.carbsG,
        fatG: item.fatG ?? scaled.fatG,
        source: "lookup",
        assumptions: Array.from(
          new Set([
            ...item.assumptions,
            `Selected candidate: ${candidate.name}${candidate.brand ? ` (${candidate.brand})` : ""}.`,
          ])
        ),
      });

      return {
        item: merged,
        trace: {
          itemName: item.name,
          selectedSource: "internet",
          confidence: selection.confidence,
          rationale: selection.rationale,
          lookupLabel: candidate.sourceLabel,
          lookupUrl: candidate.url,
        },
        requiresClarification: false,
      };
    }
  }

  const estimated = estimateCaloriesFromMacros({
    ...item,
    kcal: item.kcal ?? (selection.estimated.kcal ?? undefined),
    proteinG: item.proteinG ?? (selection.estimated.proteinG ?? undefined),
    carbsG: item.carbsG ?? (selection.estimated.carbsG ?? undefined),
    fatG: item.fatG ?? (selection.estimated.fatG ?? undefined),
    source: "estimated",
    assumptions: Array.from(new Set([...item.assumptions, `Estimated by agent reasoning: ${selection.rationale}`])),
  });

  if (
    estimated.kcal === undefined &&
    estimated.proteinG === undefined &&
    estimated.carbsG === undefined &&
    estimated.fatG === undefined
  ) {
    return {
      item,
      trace: {
        itemName: item.name,
        selectedSource: "estimated",
        confidence: selection.confidence,
        rationale: selection.rationale,
      },
      requiresClarification: true,
      clarificationText:
        selection.clarificationQuestion ||
        `I couldn’t confidently infer nutrition for ${getUserFacingItemLabel(item)}.`,
    };
  }

  return {
    item: estimated,
    trace: {
      itemName: item.name,
      selectedSource: "estimated",
      confidence: selection.confidence,
      rationale: selection.rationale,
    },
    requiresClarification: false,
  };
}

async function buildResolvedDraft(
  apiKey: string,
  reasoningModel: string,
  rawText: string,
  extractedItems: AgentItemExtraction[],
  assumptions: string[],
  confidence: "low" | "medium" | "high"
): Promise<ResolvedDraftResult> {
  const normalized = extractedItems.map(toMealItem).map(normalizeItemQuantity);
  const resolvedItems: MealItemDraft[] = [];
  const decisionTrace: DecisionTraceItem[] = [];

  for (const item of normalized) {
    const result = await selectCandidateForItem(apiKey, reasoningModel, rawText, item);
    decisionTrace.push(result.trace);
    if (result.requiresClarification) {
      return {
        status: "clarify",
        assistantText:
          result.clarificationText ||
          `I need a bit more detail to log ${getUserFacingItemLabel(item)} correctly.`,
        draft: {
          intent: "log_meal",
          rawText,
          items: normalized,
          assumptions,
          confidence,
        },
        decisionTrace,
      };
    }
    resolvedItems.push(result.item);
  }

  return {
    status: "ok",
    draft: {
      intent: "log_meal",
      rawText,
      items: resolvedItems,
      assumptions: Array.from(new Set([...assumptions, ...resolvedItems.flatMap((item) => item.assumptions)])),
      confidence,
    },
    decisionTrace,
  };
}

function formatNaturalSummary(draft: MealDraftV2) {
  const totals = aggregateMealTotals(draft.items);
  const itemParts = draft.items.map((item) => {
    const kcal = item.kcal !== undefined ? `${item.kcal} kcal` : "kcal unknown";
    return `${getUserFacingItemLabel(item)} (${kcal})`;
  });

  return {
    text: `Logged ${itemParts.join(" + ")}. Total: ${totals.kcal} kcal (protein ${totals.proteinG}g, carbs ${totals.carbsG}g, fat ${totals.fatG}g).`,
    totals,
  };
}

async function recalcMealTotals(mealId: number) {
  if (!hasMealModel()) {
    return { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  }
  const entries = await prisma.mealEntry.findMany({
    where: { meal: { is: { id: mealId } } },
    select: { kcal: true, proteinG: true, carbsG: true, fatG: true },
  });
  const totals = aggregateMealTotals(
    entries.map((entry) => ({
      name: "",
      kcal: entry.kcal ?? undefined,
      proteinG: entry.proteinG ?? undefined,
      carbsG: entry.carbsG ?? undefined,
      fatG: entry.fatG ?? undefined,
      assumptions: [],
      source: "user",
    }))
  );
  await (prisma as unknown as { meal: { update: (args: unknown) => Promise<unknown> } }).meal.update({
    where: { id: mealId },
    data: totals,
  });
  return totals;
}

async function resolveTargetMealId(
  command: AgentCommand,
  activeMealId: number | null | undefined,
  berlinDate: string
): Promise<number | null> {
  if (!hasMealModel()) {
    return null;
  }

  const mealDelegate = (
    prisma as unknown as {
      meal: {
        findUnique: (args: unknown) => Promise<{ id: number } | null>;
        findFirst: (args: unknown) => Promise<{ id: number } | null>;
      };
    }
  ).meal;

  if (command.targetMealId && Number.isInteger(command.targetMealId)) {
    const exists = await mealDelegate.findUnique({ where: { id: command.targetMealId }, select: { id: true } });
    return exists?.id ?? null;
  }
  if (command.targetReference === "this_meal" && activeMealId) {
    const exists = await mealDelegate.findUnique({ where: { id: activeMealId }, select: { id: true } });
    if (exists) return exists.id;
  }
  if (command.targetReference === "latest" || command.targetReference === "this_meal") {
    const latest = await mealDelegate.findFirst({
      where: { berlinDate },
      orderBy: [{ berlinTime: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    return latest?.id ?? null;
  }
  return null;
}

function listMealsText(meals: Array<{ id: number; label: string; berlinTime: string; kcal: number | null }>) {
  if (meals.length === 0) return "You have no meals logged for today.";
  const lines = meals.map((meal) => `#${meal.id} ${meal.label} at ${meal.berlinTime} (${meal.kcal ?? "-"} kcal)`);
  return `Here are your meals for today:\n${lines.join("\n")}`;
}

export async function POST(request: Request) {
  let payload: LogMealRequest;
  try {
    payload = (await request.json()) as LogMealRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body. Send { "text": "..." }' }, { status: 400 });
  }

  const text = payload.text?.trim();
  if (!text) {
    return NextResponse.json(
      { error: "Missing text. Send a meal description in English." },
      { status: 400 }
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, ...getBerlinNow(), error: "Missing OPENAI_API_KEY on server." },
      { status: 500 }
    );
  }

  const berlinNow = getBerlinNow();
  const commandModel = process.env.OPENAI_MODEL_COMMAND ?? process.env.OPENAI_MODEL ?? "gpt-4.1";
  const reasoningModel = process.env.OPENAI_MODEL_REVIEW ?? process.env.OPENAI_MODEL ?? "gpt-4.1";

  let command: AgentCommand;
  try {
    command = await runCommandParser(apiKey, commandModel, text);
  } catch (error) {
    logAgentError("Command parser failed.", { error, commandModel });
    return NextResponse.json(
      { ok: false, ...berlinNow, error: "Agent command parsing failed. See server logs for details." },
      { status: 502 }
    );
  }

  if (command.action === "list_meals") {
    if (hasMealModel()) {
      const meals = await (
        prisma as unknown as {
          meal: {
            findMany: (args: unknown) => Promise<
              Array<{ id: number; label: string; berlinTime: string; kcal: number | null }>
            >;
          };
        }
      ).meal.findMany({
        where: { berlinDate: berlinNow.berlinDate },
        orderBy: [{ berlinTime: "desc" }, { id: "desc" }],
        select: { id: true, label: true, berlinTime: true, kcal: true },
        take: 20,
      });
      return NextResponse.json({
        ok: true,
        ...berlinNow,
        action: "list_meals",
        assistantText: listMealsText(meals),
        meals,
        activeMealId: meals[0]?.id ?? null,
      });
    }

    const entries = await prisma.mealEntry.findMany({
      where: { berlinDate: berlinNow.berlinDate },
      orderBy: [{ berlinTime: "desc" }, { id: "desc" }],
      select: { id: true, item: true, berlinTime: true, kcal: true },
      take: 20,
    });
    const lines =
      entries.length === 0
        ? "You have no meals logged for today."
        : `Here are your logged foods for today:\n${entries
            .map((entry) => `#${entry.id} ${entry.item} at ${entry.berlinTime} (${entry.kcal ?? "-"} kcal)`)
            .join("\n")}`;

    return NextResponse.json({
      ok: true,
      ...berlinNow,
      action: "list_meals",
      assistantText: lines,
      entries,
      activeMealId: null,
    });
  }

  if (command.action === "delete_meal") {
    if (!hasMealModel()) {
      const deleted = await prisma.mealEntry.deleteMany({ where: { berlinDate: berlinNow.berlinDate } });
      return NextResponse.json({
        ok: true,
        ...berlinNow,
        action: "delete_meal",
        assistantText:
          deleted.count > 0
            ? `Deleted ${deleted.count} logged food item(s) for today.`
            : "No logged foods found for today.",
        activeMealId: null,
      });
    }

    const targetMealId = await resolveTargetMealId(command, payload.context?.activeMealId, berlinNow.berlinDate);
    if (!targetMealId) {
      const meals = await prisma.meal.findMany({
        where: { berlinDate: berlinNow.berlinDate },
        select: { id: true },
      });
      if (meals.length === 0) {
        return NextResponse.json({
          ok: true,
          ...berlinNow,
          action: "delete_meal",
          assistantText: "No meals found for today.",
          activeMealId: null,
        });
      }
      const ids = meals.map((meal) => meal.id);
      await prisma.mealEntry.deleteMany({ where: { meal: { is: { id: { in: ids } } } } });
      await prisma.meal.deleteMany({ where: { id: { in: ids } } });
      return NextResponse.json({
        ok: true,
        ...berlinNow,
        action: "delete_meal",
        assistantText: `Deleted ${ids.length} meal(s) from today.`,
        activeMealId: null,
      });
    }

    await prisma.mealEntry.deleteMany({ where: { meal: { is: { id: targetMealId } } } });
    await prisma.meal.delete({ where: { id: targetMealId } });
    return NextResponse.json({
      ok: true,
      ...berlinNow,
      action: "delete_meal",
      assistantText: `Deleted meal #${targetMealId}.`,
      deletedMealId: targetMealId,
      activeMealId: null,
    });
  }

  if (command.items.length === 0) {
    return NextResponse.json({
      ok: true,
      ...berlinNow,
      action: command.action,
      assistantText: "I couldn't find any food items in that message.",
    });
  }

  const resolved = await buildResolvedDraft(
    apiKey,
    reasoningModel,
    text,
    command.items,
    command.assumptions,
    command.confidence
  );
  if (resolved.status === "clarify") {
    return NextResponse.json({
      ok: true,
      ...berlinNow,
      action: command.action,
      assistantText: resolved.assistantText,
      normalizedDraft: resolved.draft,
      decisionTrace: resolved.decisionTrace,
      requiresClarification: true,
      activeMealId: payload.context?.activeMealId ?? null,
    });
  }

  const draft = resolved.draft;
  const mealSummary = formatNaturalSummary(draft);

  if (command.action === "add_to_meal" && hasMealModel()) {
    const targetMealId = await resolveTargetMealId(command, payload.context?.activeMealId, berlinNow.berlinDate);
    if (!targetMealId) {
      return NextResponse.json({
        ok: true,
        ...berlinNow,
        action: "add_to_meal",
        assistantText: "I couldn't find which meal to add to. Say 'add this to meal #ID' or open a meal first.",
      });
    }

    const meal = await prisma.meal.findUnique({
      where: { id: targetMealId },
      select: { id: true, berlinDate: true, berlinTime: true, timezone: true },
    });
    if (!meal) {
      return NextResponse.json({
        ok: true,
        ...berlinNow,
        action: "add_to_meal",
        assistantText: "That meal no longer exists.",
        activeMealId: null,
      });
    }

    const savedEntryIds: number[] = [];
    for (const [index, item] of draft.items.entries()) {
      const trace = resolved.decisionTrace[index];
      const created = await prisma.mealEntry.create({
        data: {
          intent: "log_meal",
          meal: { connect: { id: targetMealId } },
          rawText: text,
          item: getUserFacingItemLabel(item),
          amountGrams: item.amountGrams,
          kcal: item.kcal,
          proteinG: item.proteinG,
          carbsG: item.carbsG,
          fatG: item.fatG,
          source: item.source,
          confidence: trace?.confidence ?? draft.confidence,
          assumptions: Array.from(
            new Set([...item.assumptions, `Decision rationale: ${trace?.rationale ?? "N/A"}`])
          ).join("\n"),
          lookupSourceType: trace?.selectedSource === "internet" ? "openfoodfacts_de" : null,
          lookupLabel: trace?.lookupLabel ?? null,
          lookupUrl: trace?.lookupUrl ?? null,
          agentModel: commandModel,
          berlinDate: meal.berlinDate,
          berlinTime: meal.berlinTime,
          timezone: meal.timezone,
        },
        select: { id: true },
      });
      savedEntryIds.push(created.id);
    }

    const totals = await recalcMealTotals(targetMealId);
    return NextResponse.json({
      ok: true,
      ...berlinNow,
      action: "add_to_meal",
      assistantText:
        `Added ${draft.items.map((item) => getUserFacingItemLabel(item)).join(", ")} to meal #${targetMealId}. ` +
        `New meal total is ${totals.kcal} kcal.`,
      normalizedDraft: draft,
      mealSummary: formatNaturalSummary({ ...draft, items: draft.items }),
      decisionTrace: resolved.decisionTrace,
      savedEntryIds,
      activeMealId: targetMealId,
    });
  }

  const meal = hasMealModel()
    ? await prisma.meal.create({
        data: {
          rawText: draft.rawText,
          label: inferMealLabel(draft.rawText),
          kcal: mealSummary.totals.kcal,
          proteinG: mealSummary.totals.proteinG,
          carbsG: mealSummary.totals.carbsG,
          fatG: mealSummary.totals.fatG,
          confidence: draft.confidence,
          assumptions: draft.assumptions.join("\n"),
          berlinDate: berlinNow.berlinDate,
          berlinTime: berlinNow.berlinTime,
          timezone: berlinNow.timezone,
        },
        select: { id: true },
      })
    : null;

  const savedEntryIds: number[] = [];
  for (const [index, item] of draft.items.entries()) {
    const trace = resolved.decisionTrace[index];
    const created = await prisma.mealEntry.create({
      data: {
        intent: "log_meal",
        ...(meal?.id ? { meal: { connect: { id: meal.id } } } : {}),
        rawText: draft.rawText,
        item: getUserFacingItemLabel(item),
        amountGrams: item.amountGrams,
        kcal: item.kcal,
        proteinG: item.proteinG,
        carbsG: item.carbsG,
        fatG: item.fatG,
        source: item.source,
        confidence: trace?.confidence ?? draft.confidence,
        assumptions: Array.from(
          new Set([...item.assumptions, `Decision rationale: ${trace?.rationale ?? "N/A"}`])
        ).join("\n"),
        lookupSourceType: trace?.selectedSource === "internet" ? "openfoodfacts_de" : null,
        lookupLabel: trace?.lookupLabel ?? null,
        lookupUrl: trace?.lookupUrl ?? null,
        agentModel: commandModel,
        berlinDate: berlinNow.berlinDate,
        berlinTime: berlinNow.berlinTime,
        timezone: berlinNow.timezone,
      },
      select: { id: true },
    });
    savedEntryIds.push(created.id);
  }

  return NextResponse.json({
    ok: true,
    ...berlinNow,
    action: "log_meal",
    assistantText: mealSummary.text,
    normalizedDraft: draft,
    mealSummary,
    decisionTrace: resolved.decisionTrace,
    savedMealId: meal?.id ?? null,
    savedEntryIds,
    activeMealId: meal?.id ?? null,
  });
}
