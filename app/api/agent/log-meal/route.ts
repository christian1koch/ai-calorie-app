import { NextResponse } from "next/server";
import { enrichItemWithLookup } from "@/lib/nutrition-lookup";
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

function inferMealLabel(rawText: string): string {
  const lower = rawText.toLowerCase();
  if (lower.includes("breakfast")) return "Breakfast";
  if (lower.includes("lunch")) return "Lunch";
  if (lower.includes("dinner")) return "Dinner";
  if (lower.includes("snack")) return "Snack";
  return "Meal";
}

async function buildNormalizedDraft(
  rawText: string,
  items: AgentItemExtraction[],
  assumptions: string[],
  confidence: "low" | "medium" | "high"
): Promise<{ draft: MealDraftV2; lookupByItem: Array<{ itemName: string; sourceType?: string; label?: string }> }> {
  const baseItems = items.map(toMealItem);
  const enrichedItems: MealItemDraft[] = [];
  const lookupByItem: Array<{ itemName: string; sourceType?: string; label?: string }> = [];

  for (const baseItem of baseItems) {
    const normalizedItem = normalizeItemQuantity(baseItem);
    const { item: lookedUpItem, lookup } = await enrichItemWithLookup(normalizedItem);
    const finalizedItem = estimateCaloriesFromMacros(lookedUpItem);
    enrichedItems.push(finalizedItem);
    lookupByItem.push({
      itemName: finalizedItem.name,
      sourceType: lookup?.sourceType,
      label: lookup?.label,
    });
  }

  const draft: MealDraftV2 = {
    intent: "log_meal",
    rawText,
    items: enrichedItems,
    assumptions: Array.from(new Set([...assumptions, ...enrichedItems.flatMap((item) => item.assumptions)])),
    confidence,
  };

  return { draft, lookupByItem };
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
    where: { mealId },
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
    data: {
      kcal: totals.kcal,
      proteinG: totals.proteinG,
      carbsG: totals.carbsG,
      fatG: totals.fatG,
    },
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
  if (meals.length === 0) {
    return "You have no meals logged for today.";
  }
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
    return NextResponse.json({ ok: false, ...getBerlinNow(), error: "Missing OPENAI_API_KEY on server." }, { status: 500 });
  }

  const berlinNow = getBerlinNow();
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
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
                  "Use add_to_meal for requests like 'add this to this meal'. " +
                  "For food logging actions, return one item per food mention in items array. " +
                  "Preserve user-facing phrasing in displayName (e.g. '4 medium eggs', '100g ciabatta'). " +
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
  } catch (error) {
    logAgentError("Network or fetch failure while calling OpenAI.", { error, model });
    return NextResponse.json({ ok: false, ...berlinNow, error: "Agent request failed. See server logs for details." }, { status: 502 });
  }

  if (!response.ok) {
    let errorBody: unknown = null;
    try {
      errorBody = (await response.json()) as unknown;
    } catch {
      errorBody = await response.text();
    }
    logAgentError("OpenAI returned non-2xx status.", { status: response.status, model, errorBody });
    return NextResponse.json(
      { ok: false, ...berlinNow, error: `Agent request failed with status ${response.status}. See server logs for details.` },
      { status: 502 }
    );
  }

  const rawResponse = (await response.json()) as unknown;
  const outputText = extractOutputText(rawResponse);
  if (!outputText) {
    logAgentError("Agent response missing output text.", { model, rawResponse });
    return NextResponse.json(
      { ok: false, ...berlinNow, error: "Agent returned no text output. See server logs for details." },
      { status: 502 }
    );
  }

  let command: AgentCommand;
  try {
    command = JSON.parse(outputText) as AgentCommand;
  } catch {
    logAgentError("Agent output was not valid JSON.", { model, outputText });
    return NextResponse.json(
      { ok: false, ...berlinNow, error: "Agent output was not valid JSON. See server logs for details." },
      { status: 502 }
    );
  }

  if (command.action === "list_meals") {
    const meals = hasMealModel()
      ? await (
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
        })
      : [];
    if (hasMealModel()) {
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
      const deleted = await prisma.mealEntry.deleteMany({
        where: { berlinDate: berlinNow.berlinDate },
      });
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
      const deletedMeals = await prisma.meal.findMany({
        where: { berlinDate: berlinNow.berlinDate },
        select: { id: true },
      });
      if (deletedMeals.length === 0) {
        return NextResponse.json({
          ok: true,
          ...berlinNow,
          action: "delete_meal",
          assistantText: "No meals found for today.",
          activeMealId: null,
        });
      }

      const ids = deletedMeals.map((meal) => meal.id);
      await prisma.mealEntry.deleteMany({ where: { mealId: { in: ids } } });
      await prisma.meal.deleteMany({ where: { id: { in: ids } } });
      return NextResponse.json({
        ok: true,
        ...berlinNow,
        action: "delete_meal",
        assistantText: `Deleted ${ids.length} meal(s) from today.`,
        activeMealId: null,
      });
    }

    await prisma.mealEntry.deleteMany({ where: { mealId: targetMealId } });
    await (prisma as unknown as { meal: { delete: (args: unknown) => Promise<unknown> } }).meal.delete({
      where: { id: targetMealId },
    });

    return NextResponse.json({
      ok: true,
      ...berlinNow,
      action: "delete_meal",
      assistantText: `Deleted meal #${targetMealId}.`,
      deletedMealId: targetMealId,
      activeMealId: null,
    });
  }

  if (command.action === "add_to_meal") {
    if (!hasMealModel()) {
      const { draft, lookupByItem } = await buildNormalizedDraft(
        text,
        command.items,
        command.assumptions,
        command.confidence
      );
      const mealSummary = formatNaturalSummary(draft);
      const savedEntryIds: number[] = [];

      for (const item of draft.items) {
        const lookup = lookupByItem.find((value) => value.itemName === item.name);
        const created = await prisma.mealEntry.create({
          data: {
            intent: "log_meal",
            mealId: null,
            rawText: text,
            item: getUserFacingItemLabel(item),
            amountGrams: item.amountGrams,
            kcal: item.kcal,
            proteinG: item.proteinG,
            carbsG: item.carbsG,
            fatG: item.fatG,
            source: item.source,
            confidence: draft.confidence,
            assumptions: item.assumptions.join("\n"),
            lookupSourceType: lookup?.sourceType,
            lookupLabel: lookup?.label,
            agentModel: model,
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
        assistantText: `${mealSummary.text} I logged this as a new meal context.`,
        normalizedDraft: draft,
        mealSummary,
        savedMealId: null,
        savedEntryIds,
        activeMealId: null,
      });
    }
    const targetMealId = await resolveTargetMealId(command, payload.context?.activeMealId, berlinNow.berlinDate);
    if (!targetMealId) {
      return NextResponse.json({
        ok: true,
        ...berlinNow,
        action: "add_to_meal",
        assistantText: "I couldn't find which meal to add to. Say 'add this to meal #ID' or open a meal first.",
      });
    }
    if (command.items.length === 0) {
      return NextResponse.json({
        ok: true,
        ...berlinNow,
        action: "add_to_meal",
        assistantText: "I need at least one food item to add.",
      });
    }

    const meal = await (
      prisma as unknown as {
        meal: {
          findUnique: (args: unknown) => Promise<{
            id: number;
            berlinDate: string;
            berlinTime: string;
            timezone: string;
          } | null>;
        };
      }
    ).meal.findUnique({ where: { id: targetMealId } });
    if (!meal) {
      return NextResponse.json({
        ok: true,
        ...berlinNow,
        action: "add_to_meal",
        assistantText: "That meal no longer exists.",
        activeMealId: null,
      });
    }

    const { draft, lookupByItem } = await buildNormalizedDraft(text, command.items, command.assumptions, command.confidence);
    const savedEntryIds: number[] = [];

    for (const item of draft.items) {
      const lookup = lookupByItem.find((value) => value.itemName === item.name);
      const created = await prisma.mealEntry.create({
        data: {
          intent: "log_meal",
          mealId: targetMealId,
          rawText: text,
          item: getUserFacingItemLabel(item),
          amountGrams: item.amountGrams,
          kcal: item.kcal,
          proteinG: item.proteinG,
          carbsG: item.carbsG,
          fatG: item.fatG,
          source: item.source,
          confidence: draft.confidence,
          assumptions: item.assumptions.join("\n"),
          lookupSourceType: lookup?.sourceType,
          lookupLabel: lookup?.label,
          agentModel: model,
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
      assistantText: `Added ${draft.items.map((item) => getUserFacingItemLabel(item)).join(", ")} to meal #${targetMealId}. New meal total is ${totals.kcal} kcal.`,
      normalizedDraft: draft,
      savedEntryIds,
      activeMealId: targetMealId,
    });
  }

  if (command.items.length === 0) {
    return NextResponse.json({
      ok: true,
      ...berlinNow,
      action: "log_meal",
      assistantText: "I couldn't find any food items in that message.",
    });
  }

  const { draft, lookupByItem } = await buildNormalizedDraft(text, command.items, command.assumptions, command.confidence);
  const mealSummary = formatNaturalSummary(draft);

  const meal = hasMealModel()
    ? await (
        prisma as unknown as {
          meal: {
            create: (args: unknown) => Promise<{ id: number }>;
          };
        }
      ).meal.create({
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
  for (const item of draft.items) {
    const lookup = lookupByItem.find((value) => value.itemName === item.name);
    const created = await prisma.mealEntry.create({
      data: {
        intent: "log_meal",
        mealId: meal?.id ?? null,
        rawText: draft.rawText,
        item: getUserFacingItemLabel(item),
        amountGrams: item.amountGrams,
        kcal: item.kcal,
        proteinG: item.proteinG,
        carbsG: item.carbsG,
        fatG: item.fatG,
        source: item.source,
        confidence: draft.confidence,
        assumptions: item.assumptions.join("\n"),
        lookupSourceType: lookup?.sourceType,
        lookupLabel: lookup?.label,
        agentModel: model,
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
    savedMealId: meal?.id ?? null,
    savedEntryIds,
    activeMealId: meal?.id ?? null,
  });
}
