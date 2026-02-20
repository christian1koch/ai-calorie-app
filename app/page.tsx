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
  note?: string;
};

export default function Home() {
  const [text, setText] = useState("I had 250g quark 220 kcal protein 30g carbs 8g fat 2g");
  const [parserResult, setParserResult] = useState<ApiResult | null>(null);
  const [agentResult, setAgentResult] = useState<ApiResult | null>(null);
  const [isParserLoading, setIsParserLoading] = useState(false);
  const [isAgentLoading, setIsAgentLoading] = useState(false);

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
    } catch {
      setAgentResult({ error: "Request failed." });
    } finally {
      setIsAgentLoading(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
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
    </main>
  );
}
