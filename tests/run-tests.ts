import assert from "node:assert/strict";
import { prisma } from "../lib/prisma";
import { getBerlinNow } from "../lib/berlin-time";
import { POST as postAgent } from "../app/api/agent/log-meal/route";
import { GET as getDaySummary } from "../app/api/day-summary/route";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock() {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("world.openfoodfacts.org/cgi/search.pl")) {
      const parsed = new URL(url);
      const q = decodeURIComponent(parsed.searchParams.get("search_terms") ?? "").toLowerCase();

      if (q.includes("rice")) {
        return jsonResponse({
          products: [
            {
              code: "rice1",
              product_name: "Cooked Rice",
              brands: "Generic",
              nutriments: {
                "energy-kcal_100g": 131,
                proteins_100g: 2.7,
                carbohydrates_100g: 28,
                fat_100g: 0.3,
              },
            },
          ],
        });
      }

      if (q.includes("chicken")) {
        return jsonResponse({
          products: [
            {
              code: "chicken1",
              product_name: "Chicken Breast",
              brands: "Generic",
              nutriments: {
                "energy-kcal_100g": 165,
                proteins_100g: 31,
                carbohydrates_100g: 0,
                fat_100g: 3.6,
              },
            },
          ],
        });
      }

      if (q.includes("skyr")) {
        return jsonResponse({
          products: [
            {
              code: "skyr1",
              product_name: "Skyr Natural",
              brands: "Milbona",
              nutriments: {
                "energy-kcal_100g": 62,
                proteins_100g: 11,
                carbohydrates_100g: 4,
                fat_100g: 0.2,
              },
            },
          ],
        });
      }

      return jsonResponse({ products: [] });
    }

    if (url.includes("duckduckgo.com/html/")) {
      return new Response("<html><body>no results</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.includes("api.openai.com/v1/responses")) {
      return jsonResponse({ output_text: "{}" }, 500);
    }

    throw new Error(`Unhandled fetch URL in tests: ${url}`);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function resetDb() {
  await prisma.entryRevision.deleteMany();
  await prisma.mealAction.deleteMany();
  await prisma.conversationSession.deleteMany();
  await prisma.mealEntry.deleteMany();
  await prisma.meal.deleteMany();
}

async function post(text: string, context?: { activeMealId?: number | null; sessionId?: string }) {
  const response = await postAgent(
    new Request("http://localhost:3000/api/agent/log-meal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, context }),
    })
  );
  return response.json();
}

async function testAmbiguousButLoggable() {
  await resetDb();
  const body = (await post("I had 200g chicken")) as {
    ok: boolean;
    message: string;
    confidence: { overall: number };
    actions: string[];
  };

  assert.equal(body.ok, true);
  assert.equal(body.actions.includes("log"), true);
  assert.equal(/^Logged/.test(body.message), true);
  assert.equal(body.confidence.overall > 0.4, true);
}

async function testTrulyAmbiguousAsksFollowUp() {
  await resetDb();
  const body = (await post("I ate something tasty")) as {
    requiresInput?: string | null;
    actions?: string[];
  };

  assert.equal(typeof body.requiresInput, "string");
  assert.equal((body.actions ?? []).length, 0);
}

async function testPatchTargetedItems() {
  await resetDb();
  const create = (await post("I had 200g chicken and 100g rice")) as {
    activeMealId?: number | null;
    ok: boolean;
  };
  assert.equal(create.ok, true);

  const activeMealId = create.activeMealId ?? null;
  assert.ok(typeof activeMealId === "number");

  const patch = (await post("actually change rice to 150g rice", { activeMealId })) as {
    action: string;
    actions: string[];
  };
  assert.equal(patch.action, "update_meal");
  assert.equal(patch.actions.includes("patch"), true);

  const entries = await prisma.mealEntry.findMany({
    where: { mealId: activeMealId as number, deletedAt: null },
    select: { item: true },
  });
  assert.equal(entries.length >= 2, true);
}

async function testExplicitReplaceMeal() {
  await resetDb();
  const create = (await post("I had 200g chicken and 100g rice")) as {
    activeMealId?: number | null;
    ok: boolean;
  };
  assert.equal(create.ok, true);
  const activeMealId = create.activeMealId as number;

  const replace = (await post(`replace meal #${activeMealId} with 100g skyr`)) as {
    action: string;
    message: string;
  };
  assert.equal(replace.action, "update_meal");
  assert.equal(replace.message.includes("Replaced meal"), true);

  const entries = await prisma.mealEntry.findMany({
    where: { mealId: activeMealId, deletedAt: null },
    select: { item: true },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].item.toLowerCase().includes("skyr"), true);
}

async function testDeleteNeedsScope() {
  await resetDb();
  await post("meal one was 200g chicken", { sessionId: "s-1" });

  const body = (await post("delete", { sessionId: "s-1" })) as {
    requiresInput?: string | null;
    actions?: string[];
  };

  assert.equal(typeof body.requiresInput, "string");
  assert.equal((body.actions ?? []).length, 0);
}

async function testDaySummaryHasLineageAndProvenance() {
  await resetDb();
  await post("I had 200g chicken");

  const now = getBerlinNow();
  const response = await getDaySummary(
    new Request(`http://localhost:3000/api/day-summary?date=${now.berlinDate}`)
  );
  const body = (await response.json()) as {
    meals: Array<{
      foods: Array<{
        lineage?: string;
        provenance?: {
          sourceType?: string | null;
          label?: string | null;
          url?: string | null;
        };
      }>;
    }>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.meals.length >= 1, true);
  const food = body.meals[0].foods[0];
  assert.equal(typeof food.lineage, "string");
  assert.equal(typeof food.provenance, "object");
}

async function run() {
  const restoreFetch = installFetchMock();
  process.env.OPENAI_API_KEY = "";
  process.env.AGENT_V2_ENABLED = "true";
  try {
    await testAmbiguousButLoggable();
    await testTrulyAmbiguousAsksFollowUp();
    await testPatchTargetedItems();
    await testExplicitReplaceMeal();
    await testDeleteNeedsScope();
    await testDaySummaryHasLineageAndProvenance();
    console.log("All tests passed.");
  } finally {
    restoreFetch();
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
