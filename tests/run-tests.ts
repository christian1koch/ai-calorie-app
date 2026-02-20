import assert from "node:assert/strict";
import { parseLogMeal } from "../lib/log-meal";
import { getOpenFoodFactsCandidates } from "../lib/nutrition-lookup";
import { getUserFacingItemLabel, normalizeItemQuantity } from "../lib/log-meal-items";
import { prisma } from "../lib/prisma";
import { GET as getDaySummary } from "../app/api/day-summary/route";
import { POST as postAgent } from "../app/api/agent/log-meal/route";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock() {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("api.openai.com/v1/responses")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const schemaName = body?.text?.format?.name;

      if (schemaName === "meal_command") {
        const userText = String(body?.input?.[1]?.content?.[0]?.text ?? "").toLowerCase();

        if (userText.includes("what are my meals") || userText.includes("list")) {
          return jsonResponse({
            output_text: JSON.stringify({
              action: "list_meals",
              targetMealId: null,
              targetReference: "none",
              items: [],
              assumptions: [],
              confidence: "high",
            }),
          });
        }

        if (userText.includes("delete")) {
          return jsonResponse({
            output_text: JSON.stringify({
              action: "delete_meal",
              targetMealId: null,
              targetReference: userText.includes("this") ? "this_meal" : "latest",
              items: [],
              assumptions: [],
              confidence: "high",
            }),
          });
        }

        if (userText.includes("add") && userText.includes("butter")) {
          return jsonResponse({
            output_text: JSON.stringify({
              action: "add_to_meal",
              targetMealId: null,
              targetReference: "this_meal",
              items: [
                {
                  name: "butter",
                  displayName: "5g butter",
                  quantity: 5,
                  unit: "g",
                  size: null,
                  amountGrams: 5,
                  kcal: null,
                  proteinG: null,
                  carbsG: null,
                  fatG: null,
                },
              ],
              assumptions: [],
              confidence: "high",
            }),
          });
        }

        if (userText.includes("override")) {
          return jsonResponse({
            output_text: JSON.stringify({
              action: "log_meal",
              targetMealId: null,
              targetReference: "none",
              items: [
                {
                  name: "protein bar",
                  displayName: "protein bar",
                  quantity: 1,
                  unit: "piece",
                  size: null,
                  amountGrams: null,
                  kcal: 210,
                  proteinG: 20,
                  carbsG: 10,
                  fatG: 8,
                },
              ],
              assumptions: [],
              confidence: "high",
            }),
          });
        }

        return jsonResponse({
          output_text: JSON.stringify({
            action: "log_meal",
            targetMealId: null,
            targetReference: "none",
            items: [
              {
                name: "eggs",
                displayName: "4 eggs",
                quantity: 4,
                unit: "eggs",
                size: "medium",
                amountGrams: null,
                kcal: null,
                proteinG: null,
                carbsG: null,
                fatG: null,
              },
              {
                name: "laugencroissant from rewe",
                displayName: "150g laugencroissant from rewe",
                quantity: 150,
                unit: "g",
                size: null,
                amountGrams: 150,
                kcal: null,
                proteinG: null,
                carbsG: null,
                fatG: null,
              },
            ],
            assumptions: [],
            confidence: "high",
          }),
        });
      }

      if (schemaName === "candidate_selection") {
        const payload = JSON.parse(String(body?.input?.[1]?.content?.[0]?.text ?? "{}")) as {
          item?: { name?: string };
          candidates?: Array<{ id: string }>;
        };
        const itemName = payload.item?.name?.toLowerCase() ?? "";
        const candidates = payload.candidates ?? [];

        if (itemName.includes("egg")) {
          const match = candidates.find((c) => c.id === "off_111") ?? candidates[0];
          return jsonResponse({
            output_text: JSON.stringify({
              decision: "select_candidate",
              selectedCandidateId: match?.id ?? null,
              confidence: "high",
              rationale: "Matched egg term and plausible macros for eggs.",
              estimated: { kcal: null, proteinG: null, carbsG: null, fatG: null },
              clarificationQuestion: null,
            }),
          });
        }

        if (itemName.includes("laugencroissant")) {
          const match = candidates.find((c) => c.id === "off_222") ?? candidates[0];
          return jsonResponse({
            output_text: JSON.stringify({
              decision: "select_candidate",
              selectedCandidateId: match?.id ?? null,
              confidence: "high",
              rationale: "Brand/type matches laugencroissant from Rewe.",
              estimated: { kcal: null, proteinG: null, carbsG: null, fatG: null },
              clarificationQuestion: null,
            }),
          });
        }

        if (itemName.includes("butter")) {
          const match = candidates.find((c) => c.id === "off_333") ?? candidates[0];
          return jsonResponse({
            output_text: JSON.stringify({
              decision: "select_candidate",
              selectedCandidateId: match?.id ?? null,
              confidence: "medium",
              rationale: "Best available butter candidate.",
              estimated: { kcal: null, proteinG: null, carbsG: null, fatG: null },
              clarificationQuestion: null,
            }),
          });
        }

        return jsonResponse({
          output_text: JSON.stringify({
            decision: "estimate",
            selectedCandidateId: null,
            confidence: "low",
            rationale: "No close candidate match.",
            estimated: { kcal: 100, proteinG: 0, carbsG: 0, fatG: 0 },
            clarificationQuestion: null,
          }),
        });
      }
    }

    if (url.includes("world.openfoodfacts.org/cgi/search.pl")) {
      const parsed = new URL(url);
      const searchTerms = (parsed.searchParams.get("search_terms") ?? "").toLowerCase();

      if (searchTerms.includes("egg")) {
        return jsonResponse({
          products: [
            {
              code: "111",
              product_name: "Fresh Eggs",
              brands: "Farm",
              nutriments: {
                "energy-kcal_100g": 140,
                proteins_100g: 12.5,
                carbohydrates_100g: 1.1,
                fat_100g: 9.5,
              },
            },
            {
              code: "999",
              product_name: "Butter Croissant",
              brands: "Bakery",
              nutriments: {
                "energy-kcal_100g": 470,
                proteins_100g: 7,
                carbohydrates_100g: 73,
                fat_100g: 16,
              },
            },
          ],
        });
      }

      if (searchTerms.includes("laugencroissant")) {
        return jsonResponse({
          products: [
            {
              code: "222",
              product_name: "Laugencroissant",
              brands: "Rewe",
              nutriments: {
                "energy-kcal_100g": 320,
                proteins_100g: 8,
                carbohydrates_100g: 45,
                fat_100g: 12,
              },
            },
          ],
        });
      }

      if (searchTerms.includes("butter")) {
        return jsonResponse({
          products: [
            {
              code: "333",
              product_name: "Butter",
              brands: "Kerrygold",
              nutriments: {
                "energy-kcal_100g": 717,
                proteins_100g: 0.9,
                carbohydrates_100g: 0.1,
                fat_100g: 81,
              },
            },
          ],
        });
      }

      return jsonResponse({ products: [] });
    }

    throw new Error(`Unhandled fetch URL in tests: ${url}`);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function resetDb() {
  await prisma.mealEntry.deleteMany();
  await prisma.meal.deleteMany();
}

async function testDeterministicMath() {
  const draft = parseLogMeal("I had tofu protein 10g carbs 20g fat 10g");
  assert.equal(draft.kcal, 210);
  assert.equal(draft.source, "estimated");
}

async function testEggQuantityConversion() {
  const converted = normalizeItemQuantity({
    name: "eggs",
    quantity: 4,
    unit: "eggs",
    size: "medium",
    assumptions: [],
    source: "agent",
  });

  assert.equal(converted.amountGrams, 200);
  assert.equal(
    converted.assumptions.includes("Converted 4 medium egg(s) to 200g (50g each)."),
    true
  );
  assert.equal(getUserFacingItemLabel(converted), "4 eggs");
}

async function testOpenFoodFactsCandidateUrls() {
  const candidates = await getOpenFoodFactsCandidates("egg", 5);
  assert.ok(candidates.length >= 1);
  assert.ok(candidates[0].url.startsWith("https://world.openfoodfacts.org/product/"));
}

async function testRouteSelectionAndCommands() {
  await resetDb();
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL_COMMAND = "gpt-4.1";
  process.env.OPENAI_MODEL_REVIEW = "gpt-4.1";

  const logResponse = await postAgent(
    new Request("http://localhost:3000/api/agent/log-meal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Add new meal 4 eggs and 150g of laugencroissant from rewe" }),
    })
  );

  assert.equal(logResponse.status, 200);
  const logBody = (await logResponse.json()) as {
    ok: boolean;
    action: string;
    decisionTrace?: Array<{
      itemName: string;
      selectedSource: string;
      confidence: string;
      rationale: string;
      lookupUrl?: string;
    }>;
    normalizedDraft?: { items?: Array<{ kcal?: number; name?: string }> };
    activeMealId?: number | null;
  };

  assert.equal(logBody.ok, true);
  assert.equal(logBody.action, "log_meal");
  assert.equal(logBody.decisionTrace?.length, 2);
  assert.equal(typeof logBody.decisionTrace?.[0]?.rationale, "string");
  assert.equal(typeof logBody.decisionTrace?.[0]?.confidence, "string");

  const eggItem = logBody.normalizedDraft?.items?.find((value) => value.name === "eggs");
  assert.ok((eggItem?.kcal ?? 0) > 0);
  assert.ok((eggItem?.kcal ?? 0) < 500);

  const activeMealId = logBody.activeMealId;
  assert.ok(typeof activeMealId === "number");

  const addResponse = await postAgent(
    new Request("http://localhost:3000/api/agent/log-meal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "add 5g butter to this meal", context: { activeMealId } }),
    })
  );
  const addBody = (await addResponse.json()) as { ok: boolean; action: string };
  assert.equal(addBody.ok, true);
  assert.equal(addBody.action, "add_to_meal");

  const listResponse = await postAgent(
    new Request("http://localhost:3000/api/agent/log-meal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "what are my meals" }),
    })
  );
  const listBody = (await listResponse.json()) as {
    ok: boolean;
    action: string;
    meals?: Array<{ id: number }>;
  };
  assert.equal(listBody.ok, true);
  assert.equal(listBody.action, "list_meals");
  assert.ok((listBody.meals?.length ?? 0) >= 1);

  const deleteResponse = await postAgent(
    new Request("http://localhost:3000/api/agent/log-meal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "delete this meal", context: { activeMealId } }),
    })
  );
  const deleteBody = (await deleteResponse.json()) as { ok: boolean; action: string };
  assert.equal(deleteBody.ok, true);
  assert.equal(deleteBody.action, "delete_meal");
}

async function testUserOverrideWins() {
  process.env.OPENAI_API_KEY = "test-key";

  const response = await postAgent(
    new Request("http://localhost:3000/api/agent/log-meal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "override values for protein bar" }),
    })
  );
  const body = (await response.json()) as {
    ok: boolean;
    normalizedDraft?: {
      items?: Array<{
        kcal?: number;
        proteinG?: number;
        carbsG?: number;
        fatG?: number;
      }>;
    };
  };

  const item = body.normalizedDraft?.items?.[0];
  assert.equal(body.ok, true);
  assert.equal(item?.kcal, 210);
  assert.equal(item?.proteinG, 20);
  assert.equal(item?.carbsG, 10);
  assert.equal(item?.fatG, 8);
}

async function testDaySummaryTransparency() {
  await resetDb();

  const meal = await prisma.meal.create({
    data: {
      rawText: "test meal",
      label: "Meal",
      kcal: 280,
      proteinG: 25,
      carbsG: 2,
      fatG: 20,
      confidence: "high",
      assumptions: "",
      berlinDate: "2026-02-20",
      berlinTime: "08:00:00",
      timezone: "Europe/Berlin",
    },
  });

  await prisma.mealEntry.create({
    data: {
      intent: "log_meal",
      meal: { connect: { id: meal.id } },
      rawText: "4 eggs",
      item: "4 eggs",
      amountGrams: 200,
      kcal: 280,
      proteinG: 25,
      carbsG: 2,
      fatG: 20,
      source: "lookup",
      confidence: "high",
      assumptions: "Decision rationale: matched egg",
      lookupSourceType: "openfoodfacts_de",
      lookupLabel: "OpenFoodFacts Germany",
      lookupUrl: "https://world.openfoodfacts.org/product/111",
      agentModel: "gpt-4.1",
      berlinDate: "2026-02-20",
      berlinTime: "08:00:00",
      timezone: "Europe/Berlin",
    },
  });

  const response = await getDaySummary(
    new Request("http://localhost:3000/api/day-summary?date=2026-02-20")
  );
  const body = (await response.json()) as {
    ok: boolean;
    meals: Array<{
      foods: Array<{
        source: string;
        lookupLabel: string | null;
        lookupUrl: string | null;
        confidence: string;
      }>;
    }>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.meals.length, 1);
  assert.equal(body.meals[0].foods.length, 1);
  const food = body.meals[0].foods[0];
  assert.equal(food.source, "lookup");
  assert.equal(food.lookupLabel, "OpenFoodFacts Germany");
  assert.ok((food.lookupUrl ?? "").startsWith("https://world.openfoodfacts.org/product/"));
  assert.ok(!(food.lookupUrl ?? "").includes("json=1"));
  assert.equal(food.confidence, "high");
}

async function run() {
  const restoreFetch = installFetchMock();
  try {
    await testDeterministicMath();
    await testEggQuantityConversion();
    await testOpenFoodFactsCandidateUrls();
    await testRouteSelectionAndCommands();
    await testUserOverrideWins();
    await testDaySummaryTransparency();

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
