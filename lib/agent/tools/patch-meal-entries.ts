import { ResolvedItem } from "@/lib/agent/types";
import { prisma } from "@/lib/prisma";
import { aggregateTotals } from "@/lib/agent/tools/create-meal";

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 1);
}

function overlapScore(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / aTokens.size;
}

export async function patchMealEntries(args: {
  mealId: number;
  items: ResolvedItem[];
  rawText: string;
  commandModel: string;
  replace: boolean;
}) {
  const existing = await prisma.mealEntry.findMany({
    where: { meal: { is: { id: args.mealId } }, deletedAt: null },
    select: {
      id: true,
      item: true,
      amountGrams: true,
      kcal: true,
      proteinG: true,
      carbsG: true,
      fatG: true,
      source: true,
      confidence: true,
      confidenceScore: true,
      assumptions: true,
      assumptionsJson: true,
      provenanceJson: true,
    },
    orderBy: [{ id: "asc" }],
  });

  const touchedIds: number[] = [];

  if (args.replace) {
    await prisma.mealEntry.updateMany({
      where: { meal: { is: { id: args.mealId } }, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    for (const item of args.items) {
      const created = await prisma.mealEntry.create({
        data: {
          intent: "log_meal",
          meal: { connect: { id: args.mealId } },
          rawText: args.rawText,
          item: item.displayName,
          amountGrams: item.amountGrams,
          kcal: item.kcal,
          proteinG: item.proteinG,
          carbsG: item.carbsG,
          fatG: item.fatG,
          source: item.source,
          confidence: item.confidence >= 0.8 ? "high" : item.confidence >= 0.5 ? "medium" : "low",
          confidenceScore: item.confidence,
          assumptions: item.assumptions.join("\n"),
          assumptionsJson: JSON.stringify(item.assumptions),
          provenanceJson: JSON.stringify(item.provenance),
          lookupSourceType: item.provenance.sourceType,
          lookupLabel: item.provenance.label,
          lookupUrl: item.provenance.url,
          agentModel: args.commandModel,
          berlinDate: new Date().toISOString().slice(0, 10),
          berlinTime: new Date().toISOString().slice(11, 19),
          timezone: "Europe/Berlin",
        },
        select: { id: true },
      });
      touchedIds.push(created.id);
    }
  } else {
    for (const item of args.items) {
      let best = null as null | (typeof existing)[number];
      let bestScore = 0;
      for (const entry of existing) {
        const score = overlapScore(item.name, entry.item);
        if (score > bestScore) {
          best = entry;
          bestScore = score;
        }
      }

      if (best && bestScore >= 0.34) {
        const beforeJson = JSON.stringify(best);
        const updated = await prisma.mealEntry.update({
          where: { id: best.id },
          data: {
            rawText: args.rawText,
            item: item.displayName,
            amountGrams: item.amountGrams,
            kcal: item.kcal,
            proteinG: item.proteinG,
            carbsG: item.carbsG,
            fatG: item.fatG,
            source: item.source,
            confidence: item.confidence >= 0.8 ? "high" : item.confidence >= 0.5 ? "medium" : "low",
            confidenceScore: item.confidence,
            assumptions: item.assumptions.join("\n"),
            assumptionsJson: JSON.stringify(item.assumptions),
            provenanceJson: JSON.stringify(item.provenance),
            lookupSourceType: item.provenance.sourceType,
            lookupLabel: item.provenance.label,
            lookupUrl: item.provenance.url,
            agentModel: args.commandModel,
          },
        });

        await (prisma as unknown as { entryRevision?: { create: (args: unknown) => Promise<unknown> } }).entryRevision?.create({
          data: {
            entryId: best.id,
            actor: "agent",
            reason: "Patch item from conversational correction",
            beforeJson,
            afterJson: JSON.stringify(updated),
          },
        });

        touchedIds.push(best.id);
        continue;
      }

      const created = await prisma.mealEntry.create({
        data: {
          intent: "log_meal",
          meal: { connect: { id: args.mealId } },
          rawText: args.rawText,
          item: item.displayName,
          amountGrams: item.amountGrams,
          kcal: item.kcal,
          proteinG: item.proteinG,
          carbsG: item.carbsG,
          fatG: item.fatG,
          source: item.source,
          confidence: item.confidence >= 0.8 ? "high" : item.confidence >= 0.5 ? "medium" : "low",
          confidenceScore: item.confidence,
          assumptions: item.assumptions.join("\n"),
          assumptionsJson: JSON.stringify(item.assumptions),
          provenanceJson: JSON.stringify(item.provenance),
          lookupSourceType: item.provenance.sourceType,
          lookupLabel: item.provenance.label,
          lookupUrl: item.provenance.url,
          agentModel: args.commandModel,
          berlinDate: new Date().toISOString().slice(0, 10),
          berlinTime: new Date().toISOString().slice(11, 19),
          timezone: "Europe/Berlin",
        },
        select: { id: true },
      });
      touchedIds.push(created.id);
    }
  }

  const allEntries = await prisma.mealEntry.findMany({
    where: { meal: { is: { id: args.mealId } }, deletedAt: null },
    select: {
      kcal: true,
      proteinG: true,
      carbsG: true,
      fatG: true,
    },
  });

  const totals = aggregateTotals(
    allEntries.map((entry) => ({
      name: "",
      displayName: "",
      amountGrams: null,
      kcal: entry.kcal,
      proteinG: entry.proteinG,
      carbsG: entry.carbsG,
      fatG: entry.fatG,
      source: "mixed",
      confidence: 1,
      assumptions: [],
      provenance: { sourceType: null, label: null, url: null, rationale: "aggregate" },
    }))
  );

  await (prisma as unknown as { meal?: { update: (args: unknown) => Promise<unknown> } }).meal?.update({
    where: { id: args.mealId },
    data: totals,
  });

  return {
    entryIds: touchedIds,
    totals,
  };
}
