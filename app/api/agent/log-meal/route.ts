import { NextResponse } from "next/server";
import { getBerlinNow } from "@/lib/berlin-time";
import { parseLogMeal } from "@/lib/log-meal";
import { prisma } from "@/lib/prisma";
import { runAgent } from "@/lib/agent/runtime";
import { ensureAgentV2Schema } from "@/lib/db-compat";

type LogMealRequest = {
  text?: string;
  context?: {
    activeMealId?: number | null;
    sessionId?: string;
  };
  history?: Array<{
    role: "user" | "assistant";
    text: string;
  }>;
};

function isV2Enabled() {
  const raw = (process.env.AGENT_V2_ENABLED ?? "true").toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function isShadowEnabled() {
  const raw = (process.env.AGENT_V2_SHADOW ?? "false").toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

async function runLegacyFallback(payload: LogMealRequest, text: string) {
  const berlinNow = getBerlinNow();
  const parsed = parseLogMeal(text);

  const created = await prisma.mealEntry.create({
    data: {
      intent: parsed.intent,
      rawText: parsed.rawText,
      item: parsed.item,
      amountGrams: parsed.amountGrams,
      kcal: parsed.kcal,
      proteinG: parsed.proteinG,
      carbsG: parsed.carbsG,
      fatG: parsed.fatG,
      source: parsed.source,
      confidence: parsed.confidence,
      confidenceScore: parsed.confidence === "high" ? 0.9 : parsed.confidence === "medium" ? 0.65 : 0.35,
      assumptions: parsed.assumptions.join("\n"),
      assumptionsJson: JSON.stringify(parsed.assumptions),
      provenanceJson: JSON.stringify({ source: parsed.source }),
      berlinDate: berlinNow.berlinDate,
      berlinTime: berlinNow.berlinTime,
      timezone: berlinNow.timezone,
    },
    select: { id: true },
  });

  return NextResponse.json({
    ok: true,
    ...berlinNow,
    action: "log_meal",
    assistantText: `Logged ${parsed.item}.`,
    message: `Logged ${parsed.item}.`,
    actions: ["log"],
    entities: { mealIds: [], entryIds: [created.id] },
    confidence: {
      overall: parsed.confidence === "high" ? 0.9 : parsed.confidence === "medium" ? 0.65 : 0.35,
      items: [{ item: parsed.item, score: parsed.confidence === "high" ? 0.9 : parsed.confidence === "medium" ? 0.65 : 0.35 }],
    },
    requiresInput: null,
    normalizedDraft: {
      intent: "log_meal",
      rawText: parsed.rawText,
      items: [
        {
          name: parsed.item,
          amountGrams: parsed.amountGrams,
          kcal: parsed.kcal,
          proteinG: parsed.proteinG,
          carbsG: parsed.carbsG,
          fatG: parsed.fatG,
          assumptions: parsed.assumptions,
          source: parsed.source,
        },
      ],
      assumptions: parsed.assumptions,
      confidence: parsed.confidence,
    },
    savedEntryIds: [created.id],
    activeMealId: payload.context?.activeMealId ?? null,
  });
}

export async function POST(request: Request) {
  await ensureAgentV2Schema();

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

  const sessionId =
    payload.context?.sessionId ??
    request.headers.get("x-session-id") ??
    "default";

  if (!isV2Enabled()) {
    if (isShadowEnabled()) {
      runAgent({
        text,
        sessionId,
        activeMealId: payload.context?.activeMealId ?? null,
        history: payload.history ?? [],
      })
        .then((result) => {
          console.info("[agent-v2-shadow]", {
            sessionId,
            text,
            actions: result.envelope.actions,
            confidence: result.envelope.confidence,
          });
        })
        .catch((error) => {
          console.error("[agent-v2-shadow] failed", error);
        });
    }

    return runLegacyFallback(payload, text);
  }

  try {
    const berlinNow = getBerlinNow();
    const result = await runAgent({
      text,
      sessionId,
      activeMealId: payload.context?.activeMealId ?? null,
      history: payload.history ?? [],
    });

    return NextResponse.json({
      ok: true,
      ...berlinNow,
      action: result.action,
      assistantText: result.legacyAssistantText,
      message: result.envelope.message,
      actions: result.envelope.actions,
      entities: result.envelope.entities,
      confidence: result.envelope.confidence,
      requiresInput: result.envelope.requiresInput,
      data: result.envelope.data ?? null,
      normalizedDraft: result.normalizedDraft,
      mealSummary: result.mealSummary,
      meals: result.meals,
      savedMealId: result.savedMealId,
      savedEntryIds: result.savedEntryIds,
      activeMealId: result.activeMealId,
    });
  } catch (error) {
    console.error("[agent-v2] route failure", error);
    return NextResponse.json(
      {
        ok: false,
        ...getBerlinNow(),
        error: "Agent runtime failed.",
      },
      { status: 502 }
    );
  }
}
