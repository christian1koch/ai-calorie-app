export type AgentAction = "log" | "patch" | "replace" | "delete" | "list" | "clarify";

export type AgentItemInput = {
  name: string;
  displayName?: string;
  amountGrams?: number | null;
  kcal?: number | null;
  proteinG?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
};

export type AgentIntent = {
  action: AgentAction;
  targetMealId: number | null;
  items: AgentItemInput[];
  deleteScope: "one" | "all" | "none";
  confidence: number;
  requiresInput: string | null;
  reason: string;
};

export type ResolvedItem = {
  name: string;
  displayName: string;
  amountGrams: number | null;
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  source: "user" | "lookup" | "estimated" | "mixed";
  confidence: number;
  assumptions: string[];
  provenance: {
    sourceType: string | null;
    label: string | null;
    url: string | null;
    rationale: string;
  };
};

export type AgentEnvelope = {
  ok: boolean;
  message: string;
  actions: Array<"log" | "patch" | "delete" | "list">;
  entities: {
    mealIds: number[];
    entryIds: number[];
  };
  confidence: {
    overall: number;
    items: Array<{ item: string; score: number }>;
  };
  requiresInput: string | null;
  data?: Record<string, unknown>;
};

export type AgentRequest = {
  text: string;
  sessionId: string;
  activeMealId: number | null;
  history: Array<{ role: "user" | "assistant"; text: string }>;
};

export type AgentRunResult = {
  envelope: AgentEnvelope;
  activeMealId: number | null;
  action: "log_meal" | "list_meals" | "delete_meal" | "add_to_meal" | "update_meal";
  legacyAssistantText: string;
  normalizedDraft?: {
    intent: "log_meal";
    rawText: string;
    items: Array<{
      name: string;
      displayName?: string;
      amountGrams?: number;
      kcal?: number;
      proteinG?: number;
      carbsG?: number;
      fatG?: number;
      assumptions: string[];
      source: string;
    }>;
    assumptions: string[];
    confidence: "low" | "medium" | "high";
  };
  mealSummary?: {
    text: string;
    totals: {
      kcal: number;
      proteinG: number;
      carbsG: number;
      fatG: number;
    };
  };
  meals?: Array<{ id: number; label: string; berlinTime: string; kcal: number | null }>;
  savedMealId?: number | null;
  savedEntryIds?: number[];
};
