import { NextResponse } from "next/server";
import { MealDraft, parseLogMeal } from "@/lib/log-meal";
import { enrichDraftWithLookup } from "@/lib/nutrition-lookup";
import { prisma } from "@/lib/prisma";
import { getBerlinNow } from "@/lib/berlin-time";

type LogMealRequest = {
  text?: string;
};

type AgentExtraction = {
  intent: "log_meal";
  item?: string;
  amountGrams?: number;
  kcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  assumptions?: string[];
  confidence?: "low" | "medium" | "high";
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

function mergeAgentIntoDraft(text: string, fallback: MealDraft, agent: AgentExtraction): MealDraft {
  const merged: MealDraft = {
    ...fallback,
    rawText: text,
    item: agent.item?.trim() || fallback.item,
    amountGrams: agent.amountGrams ?? fallback.amountGrams,
    kcal: agent.kcal ?? fallback.kcal,
    proteinG: agent.proteinG ?? fallback.proteinG,
    carbsG: agent.carbsG ?? fallback.carbsG,
    fatG: agent.fatG ?? fallback.fatG,
    confidence: agent.confidence ?? fallback.confidence,
    assumptions: [
      ...fallback.assumptions,
      ...(agent.assumptions ?? []),
      "Agent extraction applied, then normalized with deterministic fallback rules.",
    ],
    source: "agent",
  };

  merged.assumptions = Array.from(new Set(merged.assumptions));
  return merged;
}

function logAgentError(message: string, details: unknown) {
  console.error(`[agent/log-meal] ${message}`, details);
}

export async function POST(request: Request) {
  let payload: LogMealRequest;

  try {
    payload = (await request.json()) as LogMealRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body. Send { \"text\": \"...\" }" },
      { status: 400 }
    );
  }

  const text = payload.text?.trim();
  if (!text) {
    return NextResponse.json(
      { error: "Missing text. Send a meal description in English." },
      { status: 400 }
    );
  }

  const deterministicDraft = parseLogMeal(text);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        ...getBerlinNow(),
        error: "Missing OPENAI_API_KEY on server.",
        deterministicDraft,
      },
      { status: 500 }
    );
  }

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
                text: "Extract meal logging fields for intent log_meal. Language of user input is English. Nutrition context is Germany. If uncertain, leave fields null and add assumptions.",
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
            name: "log_meal_extraction",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                intent: { type: "string", enum: ["log_meal"] },
                item: { type: ["string", "null"] },
                amountGrams: { type: ["number", "null"] },
                kcal: { type: ["number", "null"] },
                proteinG: { type: ["number", "null"] },
                carbsG: { type: ["number", "null"] },
                fatG: { type: ["number", "null"] },
                assumptions: {
                  type: "array",
                  items: { type: "string" },
                },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
              },
              required: [
                "intent",
                "item",
                "amountGrams",
                "kcal",
                "proteinG",
                "carbsG",
                "fatG",
                "assumptions",
                "confidence",
              ],
            },
          },
        },
      }),
    });
  } catch (error) {
    logAgentError("Network or fetch failure while calling OpenAI.", { error, model });
    return NextResponse.json(
      {
        ok: false,
        ...getBerlinNow(),
        error: "Agent request failed. See server logs for details.",
        deterministicDraft,
      },
      { status: 502 }
    );
  }

  if (!response.ok) {
    let errorBody: unknown = null;
    try {
      errorBody = (await response.json()) as unknown;
    } catch {
      errorBody = await response.text();
    }
    logAgentError("OpenAI returned non-2xx status.", {
      status: response.status,
      model,
      errorBody,
    });
    return NextResponse.json(
      {
        ok: false,
        ...getBerlinNow(),
        error: `Agent request failed with status ${response.status}. See server logs for details.`,
        deterministicDraft,
      },
      { status: 502 }
    );
  }

  const rawResponse = (await response.json()) as unknown;
  const outputText = extractOutputText(rawResponse);
  if (!outputText) {
    logAgentError("Agent response missing output text.", { model, rawResponse });
    return NextResponse.json(
      {
        ok: false,
        ...getBerlinNow(),
        error: "Agent returned no text output. See server logs for details.",
        deterministicDraft,
      },
      { status: 502 }
    );
  }

  let agentExtraction: AgentExtraction;
  try {
    agentExtraction = JSON.parse(outputText) as AgentExtraction;
  } catch {
    logAgentError("Agent output was not valid JSON.", { model, outputText });
    return NextResponse.json(
      {
        ok: false,
        ...getBerlinNow(),
        error: "Agent output was not valid JSON. See server logs for details.",
        deterministicDraft,
      },
      { status: 502 }
    );
  }

  if (agentExtraction.intent !== "log_meal") {
    logAgentError("Agent returned unexpected intent.", { model, agentExtraction });
    return NextResponse.json(
      {
        ok: false,
        ...getBerlinNow(),
        error: "Agent returned unexpected intent. See server logs for details.",
        deterministicDraft,
      },
      { status: 502 }
    );
  }

  const normalizedDraft = mergeAgentIntoDraft(text, deterministicDraft, agentExtraction);
  const { draft: lookedUpDraft, lookup } = await enrichDraftWithLookup(normalizedDraft);
  const berlinNow = getBerlinNow();

  let savedEntryId: number | null = null;
  try {
    const saved = await prisma.mealEntry.create({
      data: {
        intent: "log_meal",
        rawText: lookedUpDraft.rawText,
        item: lookedUpDraft.item,
        amountGrams: lookedUpDraft.amountGrams,
        kcal: lookedUpDraft.kcal,
        proteinG: lookedUpDraft.proteinG,
        carbsG: lookedUpDraft.carbsG,
        fatG: lookedUpDraft.fatG,
        source: lookedUpDraft.source,
        confidence: lookedUpDraft.confidence,
        assumptions: lookedUpDraft.assumptions.join("\n"),
        lookupSourceType: lookup?.sourceType,
        lookupLabel: lookup?.label,
        agentModel: model,
        berlinDate: berlinNow.berlinDate,
        berlinTime: berlinNow.berlinTime,
        timezone: berlinNow.timezone,
      },
      select: {
        id: true,
      },
    });
    savedEntryId = saved.id;
  } catch (error) {
    logAgentError("Failed to save meal entry.", { error });
    return NextResponse.json(
      {
        ok: false,
        ...berlinNow,
        error: "Meal parsed but failed to persist. See server logs for details.",
        normalizedDraft: lookedUpDraft,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    ...berlinNow,
    model,
    normalizedDraft: lookedUpDraft,
    agentExtraction,
    lookup,
    savedEntryId,
    note: "MVP slice: live agent extraction + deterministic normalization.",
  });
}
