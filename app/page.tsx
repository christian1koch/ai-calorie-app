"use client";

import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type AgentResponse = {
  ok?: boolean;
  error?: string;
  berlinDate?: string;
  berlinTime?: string;
  action?: "log_meal" | "list_meals" | "delete_meal" | "add_to_meal";
  assistantText?: string;
  activeMealId?: number | null;
  normalizedDraft?: {
    items?: Array<{
      name: string;
      amountGrams?: number;
      kcal?: number;
      proteinG?: number;
      carbsG?: number;
      fatG?: number;
    }>;
  };
  mealSummary?: {
    text?: string;
    totals?: {
      kcal: number;
      proteinG: number;
      carbsG: number;
      fatG: number;
    };
  };
  meals?: Array<{ id: number; label: string; berlinTime: string; kcal: number | null }>;
  savedEntryIds?: number[];
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
  error?: string;
  totals?: {
    kcal: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
  };
  meals?: Array<{
    id: number;
    label: string;
    berlinTime: string;
    totals: {
      kcal: number | null;
      proteinG: number | null;
      carbsG: number | null;
      fatG: number | null;
    };
    foods: Array<{
      id: number;
      item: string;
      amountGrams: number | null;
      kcal: number | null;
      source: string;
      confidence: string;
      lookupSourceType: string | null;
      lookupLabel: string | null;
      lookupUrl: string | null;
    }>;
  }>;
  entries?: SummaryEntry[];
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

function berlinDateToday(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Europe/Berlin",
  });
}

function makeAssistantText(response: AgentResponse): string {
  if (!response.ok) {
    return "I couldn't log that meal right now. Please try again.";
  }

  if (response.assistantText) {
    return response.assistantText;
  }

  if (response.mealSummary?.text) {
    return response.mealSummary.text;
  }

  const items = response.normalizedDraft?.items ?? [];
  if (items.length === 0) {
    return "Meal logged.";
  }

  return `Logged ${items.map((item) => item.name).join(" + ")}.`;
}

function sourceBadgeLabel(food: {
  source: string;
  lookupSourceType: string | null;
}): string {
  if (food.lookupSourceType === "openfoodfacts_de") return "Internet";
  if (food.lookupSourceType === "consumed_products") return "DB";
  if (food.source === "estimated") return "Estimated";
  if (food.source === "user") return "User";
  return "Mixed";
}

export default function Home() {
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Tell me what you ate in plain English, and I’ll log it.",
    },
  ]);
  const [isAgentLoading, setIsAgentLoading] = useState(false);
  const [summaryDate, setSummaryDate] = useState(berlinDateToday);
  const [summaryResult, setSummaryResult] = useState<DaySummaryResult | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [showMeals, setShowMeals] = useState(false);
  const [activeMealId, setActiveMealId] = useState<number | null>(null);

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

  useEffect(() => {
    loadDaySummary(summaryDate);
  }, [summaryDate]);

  async function onSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim()) return;

    const userText = text.trim();
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      text: userText,
    };

    setMessages((prev) => [...prev, userMessage]);
    setText("");
    setIsAgentLoading(true);

    try {
      const response = await fetch("/api/agent/log-meal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: userText, context: { activeMealId } }),
      });
      const data = (await response.json()) as AgentResponse;
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        text: data.error ?? makeAssistantText(data),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      if (data.activeMealId !== undefined) {
        setActiveMealId(data.activeMealId);
      }
      if (data.ok) {
        const refreshDate = data.berlinDate ?? summaryDate;
        setSummaryDate(refreshDate);
        await loadDaySummary(refreshDate);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: "I couldn't reach the server. Please try again.",
        },
      ]);
    } finally {
      setIsAgentLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40 px-4 py-6 md:px-8">
      <div className="mx-auto grid w-full max-w-6xl gap-6 md:grid-cols-[1.6fr_1fr]">
        <section className="rounded-xl border bg-card p-4 shadow-sm md:p-6">
          <div className="mb-4">
            <h1 className="text-2xl font-semibold tracking-tight">Calorie Agent</h1>
            <p className="text-sm text-muted-foreground">
              Chat naturally. I’ll log meals and keep your daily totals updated.
            </p>
          </div>

          <div className="h-[52vh] overflow-y-auto rounded-lg border bg-muted/40 p-3">
            <div className="space-y-3">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    message.role === "user"
                      ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                      : "mr-auto max-w-[85%] rounded-lg bg-card px-3 py-2 text-sm text-card-foreground shadow-sm"
                  }
                >
                  {message.text}
                </div>
              ))}
              {isAgentLoading ? (
                <div className="mr-auto max-w-[85%] rounded-lg bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">
                  Thinking...
                </div>
              ) : null}
            </div>
          </div>

          <form onSubmit={onSendMessage} className="mt-4 flex gap-2">
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="I had chicken and rice for lunch..."
            />
            <Button type="submit" disabled={isAgentLoading || text.trim().length === 0}>
              Send
            </Button>
          </form>
        </section>

        <aside className="space-y-4">
          <section className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="text-xs uppercase text-muted-foreground">Today ({summaryDate})</div>
            <div className="mt-2 text-4xl font-semibold leading-none">
              {summaryResult?.totals?.kcal ?? 0}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">kcal total</div>

            <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-md border p-2">
                <div className="text-muted-foreground">Protein</div>
                <div className="font-medium">{summaryResult?.totals?.proteinG ?? 0}g</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-muted-foreground">Carbs</div>
                <div className="font-medium">{summaryResult?.totals?.carbsG ?? 0}g</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-muted-foreground">Fat</div>
                <div className="font-medium">{summaryResult?.totals?.fatG ?? 0}g</div>
              </div>
            </div>

            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowMeals((prev) => !prev)}
                className="w-full"
              >
                {showMeals ? "Hide meals" : "Show meals"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => loadDaySummary(summaryDate)}
                disabled={isSummaryLoading}
              >
                Refresh
              </Button>
            </div>
          </section>

          {showMeals ? (
            <section className="rounded-xl border bg-card p-4 shadow-sm">
              <h2 className="text-sm font-semibold">Meals</h2>
              <div className="mt-3 space-y-2">
                {summaryResult?.meals && summaryResult.meals.length > 0 ? (
                  summaryResult.meals.map((meal) => (
                    <div key={meal.id} className="rounded-md border p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">
                          {meal.label} ({meal.berlinTime})
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {meal.totals.kcal ?? "-"} kcal
                        </div>
                      </div>
                      <div className="mt-2 space-y-1">
                        {meal.foods.map((food) => (
                          <div key={food.id} className="rounded border p-2 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-medium text-foreground">
                                {food.item} | {food.amountGrams ?? "-"}g | {food.kcal ?? "-"} kcal
                              </div>
                              <span className="rounded bg-muted px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                                {sourceBadgeLabel(food)}
                              </span>
                            </div>
                            <div className="mt-1 text-muted-foreground">
                              {food.lookupLabel
                                ? `Source: ${food.lookupLabel}`
                                : food.source === "estimated"
                                  ? "Source: Estimated from macros."
                                  : "Source: User-provided values."}
                              {food.lookupUrl ? (
                                <>
                                  {" "}
                                  <a
                                    href={food.lookupUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline"
                                  >
                                    link
                                  </a>
                                </>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-muted-foreground">No meals logged for this day yet.</div>
                )}
              </div>
            </section>
          ) : null}

          <section className="rounded-xl border bg-card p-4 text-xs text-muted-foreground shadow-sm">
            Need debugging details? Open <a href="/debug" className="underline">/debug</a>.
          </section>
        </aside>
      </div>
    </main>
  );
}
