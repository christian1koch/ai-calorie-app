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
  note?: string;
};

export default function Home() {
  const [text, setText] = useState("I had 250g quark 220 kcal protein 30g carbs 8g fat 2g");
  const [result, setResult] = useState<ApiResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setResult(null);

    try {
      const response = await fetch("/api/log-meal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      });
      const data = (await response.json()) as ApiResult;
      setResult(data);
    } catch {
      setResult({ error: "Request failed." });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">AI Calorie Tracker (MVP)</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        First cycle: log meal intent parser draft (`log_meal`) with Berlin-local timestamp.
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-3">
        <label htmlFor="meal-input" className="text-sm font-medium">
          Meal text (English)
        </label>
        <Input
          id="meal-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="I had 200g skyr and an apple"
        />
        <Button type="submit" disabled={isLoading || text.trim().length === 0}>
          {isLoading ? "Parsing..." : "Parse log_meal draft"}
        </Button>
      </form>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Response</h2>
        <pre className="mt-3 overflow-x-auto rounded-md border p-4 text-xs leading-5">
          {JSON.stringify(result, null, 2)}
        </pre>
      </section>
    </main>
  );
}
