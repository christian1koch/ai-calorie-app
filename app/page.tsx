"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ApiResult = {
  ok?: boolean;
  error?: string;
  berlinDate?: string;
  berlinTime?: string;
  timezone?: string;
  entryDraft?: unknown;
  normalizedDraft?: unknown;
  deterministicDraft?: unknown;
  agentExtraction?: unknown;
  model?: string;
  savedEntryId?: number;
  note?: string;
};

type SummaryEntry = {
  id: number;
  item: string;
  amountGrams: number | null;
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  berlinTime: string;
  source: string;
  confidence: string;
};

type DaySummaryResult = {
  ok?: boolean;
  error?: string;
  date?: string;
  entryCount?: number;
  totals?: {
    kcal: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
  };
  entries?: SummaryEntry[];
};

type EntryEditState = {
  item: string;
  amountGrams: string;
  kcal: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
};

function berlinDateToday(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Europe/Berlin",
  });
}

function toStringValue(value: number | null): string {
  return value === null ? "" : String(value);
}

function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function Home() {
  const [text, setText] = useState("I had 250g quark 220 kcal protein 30g carbs 8g fat 2g");
  const [parserResult, setParserResult] = useState<ApiResult | null>(null);
  const [agentResult, setAgentResult] = useState<ApiResult | null>(null);
  const [isParserLoading, setIsParserLoading] = useState(false);
  const [isAgentLoading, setIsAgentLoading] = useState(false);
  const [summaryDate, setSummaryDate] = useState(berlinDateToday);
  const [summaryResult, setSummaryResult] = useState<DaySummaryResult | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [entryEdit, setEntryEdit] = useState<Record<number, EntryEditState>>({});
  const [isSavingById, setIsSavingById] = useState<Record<number, boolean>>({});

  async function loadDaySummary(date: string) {
    setIsSummaryLoading(true);
    try {
      const response = await fetch(`/api/day-summary?date=${date}`);
      const data = (await response.json()) as DaySummaryResult;
      setSummaryResult(data);
    } catch {
      setSummaryResult({ error: "Failed to load day summary." });
    } finally {
      setIsSummaryLoading(false);
    }
  }

  async function onParserSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsParserLoading(true);
    setParserResult(null);

    try {
      const response = await fetch("/api/log-meal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      });
      const data = (await response.json()) as ApiResult;
      setParserResult(data);
    } catch {
      setParserResult({ error: "Request failed." });
    } finally {
      setIsParserLoading(false);
    }
  }

  async function onAgentSubmit() {
    setIsAgentLoading(true);
    setAgentResult(null);

    try {
      const response = await fetch("/api/agent/log-meal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      });
      const data = (await response.json()) as ApiResult;
      setAgentResult(data);
      if (data.ok) {
        const refreshDate = data.berlinDate ?? summaryDate;
        setSummaryDate(refreshDate);
        await loadDaySummary(refreshDate);
      }
    } catch {
      setAgentResult({ error: "Request failed." });
    } finally {
      setIsAgentLoading(false);
    }
  }

  async function onSummarySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadDaySummary(summaryDate);
  }

  function startEdit(entry: SummaryEntry) {
    setEntryEdit((prev) => ({
      ...prev,
      [entry.id]: {
        item: entry.item,
        amountGrams: toStringValue(entry.amountGrams),
        kcal: toStringValue(entry.kcal),
        proteinG: toStringValue(entry.proteinG),
        carbsG: toStringValue(entry.carbsG),
        fatG: toStringValue(entry.fatG),
      },
    }));
  }

  async function saveEdit(entryId: number) {
    const current = entryEdit[entryId];
    if (!current) {
      return;
    }

    setIsSavingById((prev) => ({ ...prev, [entryId]: true }));

    try {
      const response = await fetch(`/api/entry/${entryId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          item: current.item,
          amountGrams: toNumberOrNull(current.amountGrams),
          kcal: toNumberOrNull(current.kcal),
          proteinG: toNumberOrNull(current.proteinG),
          carbsG: toNumberOrNull(current.carbsG),
          fatG: toNumberOrNull(current.fatG),
        }),
      });

      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setAgentResult({ error: data.error ?? "Failed to update entry." });
        return;
      }

      await loadDaySummary(summaryDate);
    } catch {
      setAgentResult({ error: "Failed to update entry." });
    } finally {
      setIsSavingById((prev) => ({ ...prev, [entryId]: false }));
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">AI Calorie Tracker (MVP)</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Test both deterministic parsing and live agent extraction for intent `log_meal`.
      </p>

      <form onSubmit={onParserSubmit} className="mt-8 space-y-3">
        <label htmlFor="meal-input" className="text-sm font-medium">
          Meal text (English)
        </label>
        <Input
          id="meal-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="I had 200g skyr and an apple"
        />
        <div className="flex gap-3">
          <Button type="submit" disabled={isParserLoading || text.trim().length === 0}>
            {isParserLoading ? "Parsing..." : "Deterministic parse"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onAgentSubmit}
            disabled={isAgentLoading || text.trim().length === 0}
          >
            {isAgentLoading ? "Calling agent..." : "Agent parse"}
          </Button>
        </div>
      </form>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Deterministic Response</h2>
        <pre className="mt-3 overflow-x-auto rounded-md border p-4 text-xs leading-5">
          {JSON.stringify(parserResult, null, 2)}
        </pre>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Agent Response</h2>
        <pre className="mt-3 overflow-x-auto rounded-md border p-4 text-xs leading-5">
          {JSON.stringify(agentResult, null, 2)}
        </pre>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Day Summary</h2>
        <form onSubmit={onSummarySubmit} className="mt-3 flex items-center gap-3">
          <Input
            type="date"
            value={summaryDate}
            onChange={(event) => setSummaryDate(event.target.value)}
            className="max-w-xs"
          />
          <Button type="submit" variant="outline" disabled={isSummaryLoading}>
            {isSummaryLoading ? "Loading..." : "Load summary"}
          </Button>
        </form>

        <pre className="mt-3 overflow-x-auto rounded-md border p-4 text-xs leading-5">
          {JSON.stringify(summaryResult, null, 2)}
        </pre>

        {summaryResult?.entries && summaryResult.entries.length > 0 ? (
          <div className="mt-4 space-y-3">
            {summaryResult.entries.map((entry) => {
              const edit = entryEdit[entry.id];
              return (
                <div key={entry.id} className="rounded-md border p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-medium">
                      #{entry.id} at {entry.berlinTime}
                    </div>
                    {!edit ? (
                      <Button type="button" size="sm" onClick={() => startEdit(entry)}>
                        Edit
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => saveEdit(entry.id)}
                        disabled={isSavingById[entry.id]}
                      >
                        {isSavingById[entry.id] ? "Saving..." : "Save"}
                      </Button>
                    )}
                  </div>

                  {edit ? (
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
                      <Input
                        value={edit.item}
                        onChange={(event) =>
                          setEntryEdit((prev) => ({
                            ...prev,
                            [entry.id]: { ...edit, item: event.target.value },
                          }))
                        }
                        placeholder="item"
                      />
                      <Input
                        value={edit.amountGrams}
                        onChange={(event) =>
                          setEntryEdit((prev) => ({
                            ...prev,
                            [entry.id]: { ...edit, amountGrams: event.target.value },
                          }))
                        }
                        placeholder="grams"
                      />
                      <Input
                        value={edit.kcal}
                        onChange={(event) =>
                          setEntryEdit((prev) => ({
                            ...prev,
                            [entry.id]: { ...edit, kcal: event.target.value },
                          }))
                        }
                        placeholder="kcal"
                      />
                      <Input
                        value={edit.proteinG}
                        onChange={(event) =>
                          setEntryEdit((prev) => ({
                            ...prev,
                            [entry.id]: { ...edit, proteinG: event.target.value },
                          }))
                        }
                        placeholder="protein"
                      />
                      <Input
                        value={edit.carbsG}
                        onChange={(event) =>
                          setEntryEdit((prev) => ({
                            ...prev,
                            [entry.id]: { ...edit, carbsG: event.target.value },
                          }))
                        }
                        placeholder="carbs"
                      />
                      <Input
                        value={edit.fatG}
                        onChange={(event) =>
                          setEntryEdit((prev) => ({
                            ...prev,
                            [entry.id]: { ...edit, fatG: event.target.value },
                          }))
                        }
                        placeholder="fat"
                      />
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {entry.item} | {entry.amountGrams ?? "-"}g | {entry.kcal ?? "-"} kcal | P{" "}
                      {entry.proteinG ?? "-"} C {entry.carbsG ?? "-"} F {entry.fatG ?? "-"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
    </main>
  );
}
