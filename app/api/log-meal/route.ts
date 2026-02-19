import { NextResponse } from "next/server";
import { parseLogMeal } from "@/lib/log-meal";

type LogMealRequest = {
  text?: string;
};

function berlinNow() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    berlinDate: `${map.year}-${map.month}-${map.day}`,
    berlinTime: `${map.hour}:${map.minute}:${map.second}`,
    timezone: "Europe/Berlin",
  };
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

  const parsed = parseLogMeal(text);

  return NextResponse.json({
    ok: true,
    ...berlinNow(),
    entryDraft: parsed,
    note: "MVP slice: parse-only draft. No nutrition lookup or persistence yet.",
  });
}
