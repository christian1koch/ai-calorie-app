import { getBerlinNow } from "@/lib/berlin-time";
import { prisma } from "@/lib/prisma";
import { createMeal, aggregateTotals } from "@/lib/agent/tools/create-meal";
import { deleteMeal } from "@/lib/agent/tools/delete-meal";
import { findFoodCandidates } from "@/lib/agent/tools/find-food-candidates";
import { listMeals } from "@/lib/agent/tools/list-meals";
import { patchMealEntries } from "@/lib/agent/tools/patch-meal-entries";
import type { AgentIntent, AgentRequest, AgentRunResult, ResolvedItem } from "@/lib/agent/types";

function extractOutputText(responseBody: unknown): string | null {
  if (!responseBody || typeof responseBody !== "object") return null;
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

function confidenceLabel(score: number): "low" | "medium" | "high" {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}

function parseMealIdFromText(text: string): number | null {
  const directHash = text.match(/#(\d+)/);
  if (directHash?.[1]) return Number(directHash[1]);
  const phrase = text.toLowerCase().match(/\bmeal\s+(\d+)\b/);
  if (phrase?.[1]) return Number(phrase[1]);
  return null;
}

function normalizeHistory(history: AgentRequest["history"]) {
  return (history ?? []).filter((h) => typeof h.text === "string" && h.text.trim().length > 0).slice(-8);
}

function heuristicIntent(text: string): AgentIntent {
  const lower = text.toLowerCase().trim();
  const id = parseMealIdFromText(text);
  const isDelete = /(delete|remove|erase|clear)/.test(lower);
  const isList = /(list|show|what are my meals|my meals)/.test(lower);
  const isReplace = /(replace|instead|meal\s+\w+\s+was)/.test(lower);
  const isPatch = /(change|update|actually|correct)/.test(lower);

  const items: AgentIntent["items"] = [];
  const gramsPattern = /(\d+(?:\.\d+)?)\s?g\s+(.+?)(?=(?:\s+and\s+)|(?:,\s*)|(?:\s*\+\s*)|$)/gi;
  for (const match of lower.matchAll(gramsPattern)) {
    const grams = Number(match[1]);
    const name = (match[2] ?? "").trim();
    if (!name || !Number.isFinite(grams)) continue;
    items.push({ name, displayName: `${grams}g ${name}`, amountGrams: grams });
  }

  if (items.length === 0 && !isDelete && !isList) {
    const fallbackName = lower
      .replace(/\b(i|ate|had|for|breakfast|lunch|dinner|snack|and|with|the|a|an|to|please)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (fallbackName.length > 1) {
      items.push({ name: fallbackName.slice(0, 64), displayName: fallbackName.slice(0, 64) });
    }
  }

  if (isList) {
    return {
      action: "list",
      targetMealId: id,
      items: [],
      deleteScope: "none",
      confidence: 0.7,
      requiresInput: null,
      reason: "Heuristic list intent",
    };
  }

  if (isDelete) {
    return {
      action: "delete",
      targetMealId: id,
      items: [],
      deleteScope: /(all|today|everything|meals)/.test(lower) ? "all" : "one",
      confidence: 0.7,
      requiresInput: null,
      reason: "Heuristic delete intent",
    };
  }

  if (isReplace) {
    return {
      action: "replace",
      targetMealId: id,
      items,
      deleteScope: "none",
      confidence: 0.65,
      requiresInput: items.length ? null : "Tell me what the replacement meal should include.",
      reason: "Heuristic replace intent",
    };
  }

  if (isPatch) {
    return {
      action: "patch",
      targetMealId: id,
      items,
      deleteScope: "none",
      confidence: 0.65,
      requiresInput: items.length ? null : "Tell me what you want to change in the meal.",
      reason: "Heuristic patch intent",
    };
  }

  return {
    action: "log",
    targetMealId: id,
    items,
    deleteScope: "none",
    confidence: 0.75,
    requiresInput: items.length ? null : "I can log this once you tell me at least one food item.",
    reason: "Heuristic log intent",
  };
}

async function parseIntentWithModel(request: AgentRequest, model: string, apiKey: string): Promise<AgentIntent> {
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
                "You are a conversational calorie tracker planner. Extract user intent and food items. " +
                "Prefer best-effort logging. Ask follow-up only when no defensible action is possible.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                text: request.text,
                activeMealId: request.activeMealId,
                history: normalizeHistory(request.history),
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "agent_intent",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", enum: ["log", "patch", "replace", "delete", "list", "clarify"] },
              targetMealId: { type: ["number", "null"] },
              deleteScope: { type: "string", enum: ["one", "all", "none"] },
              confidence: { type: "number" },
              reason: { type: "string" },
              requiresInput: { type: ["string", "null"] },
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    displayName: { type: ["string", "null"] },
                    amountGrams: { type: ["number", "null"] },
                    kcal: { type: ["number", "null"] },
                    proteinG: { type: ["number", "null"] },
                    carbsG: { type: ["number", "null"] },
                    fatG: { type: ["number", "null"] },
                  },
                  required: ["name", "displayName", "amountGrams", "kcal", "proteinG", "carbsG", "fatG"],
                },
              },
            },
            required: ["action", "targetMealId", "deleteScope", "confidence", "reason", "requiresInput", "items"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Intent parse failed with ${response.status}`);
  }

  const json = (await response.json()) as unknown;
  const output = extractOutputText(json);
  if (!output) {
    throw new Error("Missing intent parse output.");
  }

  const parsed = JSON.parse(output) as AgentIntent;
  parsed.items = (parsed.items ?? []).map((item) => ({
    name: item.name,
    displayName: item.displayName ?? undefined,
    amountGrams: item.amountGrams ?? null,
    kcal: item.kcal ?? null,
    proteinG: item.proteinG ?? null,
    carbsG: item.carbsG ?? null,
    fatG: item.fatG ?? null,
  }));
  return parsed;
}

async function resolveTargetMealId(
  intent: AgentIntent,
  request: AgentRequest,
  berlinDate: string,
  opts?: { allowLatestFallback?: boolean }
): Promise<number | null> {
  if (intent.targetMealId && Number.isInteger(intent.targetMealId)) {
    return intent.targetMealId;
  }

  const fromText = parseMealIdFromText(request.text);
  if (fromText) return fromText;
  if (request.activeMealId) return request.activeMealId;

  if (!opts?.allowLatestFallback) {
    return null;
  }

  const latest = await (prisma as unknown as {
    meal?: { findFirst: (args: unknown) => Promise<{ id: number } | null> };
  }).meal?.findFirst({
    where: { berlinDate },
    orderBy: [{ berlinTime: "desc" }, { id: "desc" }],
    select: { id: true },
  });

  return latest?.id ?? null;
}

async function upsertSession(sessionId: string, activeMealId: number | null, intent: string) {
  const delegate = (prisma as unknown as {
    conversationSession?: {
      upsert: (args: unknown) => Promise<unknown>;
    };
  }).conversationSession;

  if (!delegate) return;

  await delegate.upsert({
    where: { sessionId },
    create: {
      sessionId,
      activeMealId,
      lastIntent: intent,
      metadataJson: "{}",
    },
    update: {
      activeMealId,
      lastIntent: intent,
    },
  });
}

async function logAction(args: {
  sessionId: string;
  mealId: number | null;
  actionType: string;
  status: string;
  rawText: string;
  resolvedIntent: string;
  reason?: string;
  entryIds?: number[];
}) {
  const delegate = (prisma as unknown as {
    mealAction?: {
      create: (args: unknown) => Promise<unknown>;
    };
  }).mealAction;

  if (!delegate) return;

  await delegate.create({
    data: {
      sessionId: args.sessionId,
      mealId: args.mealId,
      actionType: args.actionType,
      status: args.status,
      rawText: args.rawText,
      resolvedIntent: args.resolvedIntent,
      reason: args.reason,
      entryIdsJson: JSON.stringify(args.entryIds ?? []),
    },
  });
}

function summarizeResolvedItems(items: ResolvedItem[]) {
  const totals = aggregateTotals(items);
  const text =
    items.length === 0
      ? "No food items were logged."
      : `Logged ${items.map((item) => `${item.displayName} (${item.kcal ?? "?"} kcal)`).join(" + ")}. Total: ${totals.kcal} kcal.`;
  return { text, totals };
}

export async function runAgent(request: AgentRequest): Promise<AgentRunResult> {
  const berlinNow = getBerlinNow();
  const commandModel = process.env.OPENAI_MODEL_COMMAND ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const apiKey = process.env.OPENAI_API_KEY;

  let intent = heuristicIntent(request.text);
  if (apiKey) {
    try {
      intent = await parseIntentWithModel(request, commandModel, apiKey);
    } catch (error) {
      console.error("[agent-v2] intent parse failed; falling back to heuristic", error);
    }
  }

  if (intent.action === "clarify" || intent.requiresInput) {
    await upsertSession(request.sessionId, request.activeMealId, "clarify");
    await logAction({
      sessionId: request.sessionId,
      mealId: request.activeMealId,
      actionType: "clarify",
      status: "requires_input",
      rawText: request.text,
      resolvedIntent: intent.action,
      reason: intent.requiresInput ?? intent.reason,
    });

    return {
      action: "log_meal",
      activeMealId: request.activeMealId,
      legacyAssistantText: intent.requiresInput ?? "Can you share a bit more detail?",
      envelope: {
        ok: true,
        message: intent.requiresInput ?? "Can you share a bit more detail?",
        actions: [],
        entities: { mealIds: [], entryIds: [] },
        confidence: { overall: Math.max(0.25, intent.confidence), items: [] },
        requiresInput: intent.requiresInput ?? "Can you share a bit more detail?",
      },
    };
  }

  if (intent.action === "list") {
    const meals = await listMeals(berlinNow.berlinDate);
    const message =
      meals.length === 0
        ? "You have no meals logged for today."
        : `Here are your meals for today:\n${meals.map((meal) => `#${meal.id} ${meal.label} at ${meal.berlinTime} (${meal.kcal ?? "-"} kcal)`).join("\n")}`;

    const activeMealId = meals[0]?.id ?? request.activeMealId;
    await upsertSession(request.sessionId, activeMealId ?? null, "list");
    await logAction({
      sessionId: request.sessionId,
      mealId: activeMealId ?? null,
      actionType: "list",
      status: "ok",
      rawText: request.text,
      resolvedIntent: "list",
    });

    return {
      action: "list_meals",
      activeMealId: activeMealId ?? null,
      legacyAssistantText: message,
      meals,
      envelope: {
        ok: true,
        message,
        actions: ["list"],
        entities: { mealIds: meals.map((m) => m.id), entryIds: [] },
        confidence: { overall: Math.max(0.5, intent.confidence), items: [] },
        requiresInput: null,
      },
    };
  }

  if (intent.action === "delete") {
    const explicitDelete = /(delete|remove|erase|clear)/.test(request.text.toLowerCase());
    if (!explicitDelete) {
      return {
        action: "delete_meal",
        activeMealId: request.activeMealId,
        legacyAssistantText: "Do you want to delete a meal? Please say delete and specify the target.",
        envelope: {
          ok: true,
          message: "Do you want to delete a meal? Please say delete and specify the target.",
          actions: [],
          entities: { mealIds: [], entryIds: [] },
          confidence: { overall: 0.5, items: [] },
          requiresInput: "Please confirm delete and specify 'this meal', '#ID', or 'all meals today'.",
        },
      };
    }

    const targetMealId = await resolveTargetMealId(intent, request, berlinNow.berlinDate, {
      allowLatestFallback: false,
    });
    const explicitMealRef = parseMealIdFromText(request.text);
    if (intent.deleteScope === "one" && !explicitMealRef && !request.activeMealId && !targetMealId) {
      return {
        action: "delete_meal",
        activeMealId: request.activeMealId,
        legacyAssistantText: "Please specify which meal to delete (for example: delete meal #3 or delete this meal).",
        envelope: {
          ok: true,
          message: "Please specify which meal to delete (for example: delete meal #3 or delete this meal).",
          actions: [],
          entities: { mealIds: [], entryIds: [] },
          confidence: { overall: 0.5, items: [] },
          requiresInput: "Specify the meal id or say 'delete all meals today'.",
        },
      };
    }
    const deleted = await deleteMeal({
      mealId: targetMealId,
      berlinDate: berlinNow.berlinDate,
      deleteAll: intent.deleteScope === "all",
    });

    const message =
      deleted.mealIds.length === 0
        ? "No meals matched your delete request."
        : intent.deleteScope === "all"
          ? `Deleted ${deleted.mealIds.length} meal(s) for today.`
          : `Deleted meal #${deleted.mealIds[0]}.`;

    const activeMealId = deleted.mealIds.length > 0 ? null : request.activeMealId;
    await upsertSession(request.sessionId, activeMealId ?? null, "delete");
    await logAction({
      sessionId: request.sessionId,
      mealId: targetMealId,
      actionType: "delete",
      status: deleted.mealIds.length > 0 ? "ok" : "noop",
      rawText: request.text,
      resolvedIntent: "delete",
    });

    return {
      action: "delete_meal",
      activeMealId: activeMealId ?? null,
      legacyAssistantText: message,
      envelope: {
        ok: true,
        message,
        actions: ["delete"],
        entities: { mealIds: deleted.mealIds, entryIds: [] },
        confidence: { overall: Math.max(0.5, intent.confidence), items: [] },
        requiresInput: null,
      },
    };
  }

  const resolvedItems: ResolvedItem[] = [];
  for (const item of intent.items) {
    const resolved = await findFoodCandidates(item);
    resolvedItems.push(resolved);
  }

  const lowConfidenceMissing = resolvedItems.find((item) => item.confidence < 0.3 && item.kcal === null);
  if (lowConfidenceMissing) {
    return {
      action: "log_meal",
      activeMealId: request.activeMealId,
      legacyAssistantText: `I could not confidently resolve ${lowConfidenceMissing.displayName}. Can you share brand or package details?`,
      envelope: {
        ok: true,
        message: `I could not confidently resolve ${lowConfidenceMissing.displayName}. Can you share brand or package details?`,
        actions: [],
        entities: { mealIds: [], entryIds: [] },
        confidence: {
          overall: 0.3,
          items: resolvedItems.map((item) => ({ item: item.displayName, score: item.confidence })),
        },
        requiresInput: `Please share brand/package details for ${lowConfidenceMissing.displayName}.`,
      },
    };
  }

  const baseConfidence = resolvedItems.length
    ? resolvedItems.reduce((acc, item) => acc + item.confidence, 0) / resolvedItems.length
    : Math.max(0.5, intent.confidence);

  if (intent.action === "patch" || intent.action === "replace") {
    const mealId = await resolveTargetMealId(intent, request, berlinNow.berlinDate, {
      allowLatestFallback: true,
    });
    if (!mealId) {
      return {
        action: "update_meal",
        activeMealId: request.activeMealId,
        legacyAssistantText: "I couldn't find which meal to update. Please reference the meal ID or open a meal first.",
        envelope: {
          ok: true,
          message: "I couldn't find which meal to update. Please reference the meal ID or open a meal first.",
          actions: [],
          entities: { mealIds: [], entryIds: [] },
          confidence: { overall: Math.max(0.4, baseConfidence), items: [] },
          requiresInput: "Tell me which meal to update, e.g. 'update meal #12'.",
        },
      };
    }

    const patched = await patchMealEntries({
      mealId,
      items: resolvedItems,
      rawText: request.text,
      commandModel,
      replace: intent.action === "replace",
    });
    const summary = summarizeResolvedItems(resolvedItems);
    const message =
      intent.action === "replace"
        ? `Replaced meal #${mealId}. New total is ${patched.totals.kcal} kcal.`
        : `Updated ${resolvedItems.map((item) => item.displayName).join(", ")} in meal #${mealId}. Other items were kept. New total is ${patched.totals.kcal} kcal.`;

    await upsertSession(request.sessionId, mealId, intent.action);
    await logAction({
      sessionId: request.sessionId,
      mealId,
      actionType: intent.action,
      status: "ok",
      rawText: request.text,
      resolvedIntent: intent.action,
      entryIds: patched.entryIds,
    });

    return {
      action: "update_meal",
      activeMealId: mealId,
      legacyAssistantText: message,
      savedEntryIds: patched.entryIds,
      envelope: {
        ok: true,
        message,
        actions: ["patch"],
        entities: { mealIds: [mealId], entryIds: patched.entryIds },
        confidence: {
          overall: baseConfidence,
          items: resolvedItems.map((item) => ({ item: item.displayName, score: item.confidence })),
        },
        requiresInput: null,
      },
      normalizedDraft: {
        intent: "log_meal",
        rawText: request.text,
        items: resolvedItems.map((item) => ({
          name: item.name,
          displayName: item.displayName,
          amountGrams: item.amountGrams ?? undefined,
          kcal: item.kcal ?? undefined,
          proteinG: item.proteinG ?? undefined,
          carbsG: item.carbsG ?? undefined,
          fatG: item.fatG ?? undefined,
          assumptions: item.assumptions,
          source: item.source,
        })),
        assumptions: resolvedItems.flatMap((item) => item.assumptions),
        confidence: confidenceLabel(baseConfidence),
      },
      mealSummary: summary,
    };
  }

  const created = await createMeal({
    rawText: request.text,
    berlinDate: berlinNow.berlinDate,
    berlinTime: berlinNow.berlinTime,
    timezone: berlinNow.timezone,
    commandModel,
    items: resolvedItems,
    assumptions: resolvedItems.flatMap((item) => item.assumptions),
    confidence: baseConfidence,
  });

  const summary = summarizeResolvedItems(resolvedItems);
  await upsertSession(request.sessionId, created.mealId, "log");
  await logAction({
    sessionId: request.sessionId,
    mealId: created.mealId,
    actionType: "log",
    status: "ok",
    rawText: request.text,
    resolvedIntent: "log",
    entryIds: created.entryIds,
  });

  return {
    action: "log_meal",
    activeMealId: created.mealId,
    legacyAssistantText: summary.text,
    savedMealId: created.mealId,
    savedEntryIds: created.entryIds,
    normalizedDraft: {
      intent: "log_meal",
      rawText: request.text,
      items: resolvedItems.map((item) => ({
        name: item.name,
        displayName: item.displayName,
        amountGrams: item.amountGrams ?? undefined,
        kcal: item.kcal ?? undefined,
        proteinG: item.proteinG ?? undefined,
        carbsG: item.carbsG ?? undefined,
        fatG: item.fatG ?? undefined,
        assumptions: item.assumptions,
        source: item.source,
      })),
      assumptions: resolvedItems.flatMap((item) => item.assumptions),
      confidence: confidenceLabel(baseConfidence),
    },
    mealSummary: summary,
    envelope: {
      ok: true,
      message: summary.text,
      actions: ["log"],
      entities: { mealIds: created.mealId ? [created.mealId] : [], entryIds: created.entryIds },
      confidence: {
        overall: baseConfidence,
        items: resolvedItems.map((item) => ({ item: item.displayName, score: item.confidence })),
      },
      requiresInput: null,
    },
  };
}
