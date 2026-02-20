import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type PatchEntryRequest = {
  item?: string;
  amountGrams?: number | null;
  kcal?: number | null;
  proteinG?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
  assumptions?: string[];
};

function asOptionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return value;
}

async function recalcMealTotals(mealId: number) {
  const entries = await prisma.mealEntry.findMany({
    where: { mealId },
    select: { kcal: true, proteinG: true, carbsG: true, fatG: true },
  });
  const totals = entries.reduce<{
    kcal: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
  }>(
    (accumulator, entry) => {
      accumulator.kcal += entry.kcal ?? 0;
      accumulator.proteinG += entry.proteinG ?? 0;
      accumulator.carbsG += entry.carbsG ?? 0;
      accumulator.fatG += entry.fatG ?? 0;
      return accumulator;
    },
    { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }
  );

  await prisma.meal.update({
    where: { id: mealId },
    data: totals,
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid entry id." }, { status: 400 });
  }

  let payload: PatchEntryRequest;
  try {
    payload = (await request.json()) as PatchEntryRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body for PATCH /api/entry/:id." },
      { status: 400 }
    );
  }

  const data: Record<string, unknown> = {};

  if (typeof payload.item === "string" && payload.item.trim().length > 0) {
    data.item = payload.item.trim();
  }

  const amountGrams = asOptionalNumber(payload.amountGrams);
  const kcal = asOptionalNumber(payload.kcal);
  const proteinG = asOptionalNumber(payload.proteinG);
  const carbsG = asOptionalNumber(payload.carbsG);
  const fatG = asOptionalNumber(payload.fatG);

  if (amountGrams !== undefined) data.amountGrams = amountGrams;
  if (kcal !== undefined) data.kcal = kcal;
  if (proteinG !== undefined) data.proteinG = proteinG;
  if (carbsG !== undefined) data.carbsG = carbsG;
  if (fatG !== undefined) data.fatG = fatG;
  if (Array.isArray(payload.assumptions)) {
    data.assumptions = payload.assumptions.join("\n");
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "No valid fields provided for update." },
      { status: 400 }
    );
  }

  data.source = "user";
  data.confidence = "high";

  try {
    const updated = await prisma.mealEntry.update({
      where: { id },
      data,
    });
    if (updated.mealId) {
      await recalcMealTotals(updated.mealId);
    }

    return NextResponse.json({
      ok: true,
      entry: {
        id: updated.id,
        item: updated.item,
        amountGrams: updated.amountGrams,
        kcal: updated.kcal,
        proteinG: updated.proteinG,
        carbsG: updated.carbsG,
        fatG: updated.fatG,
        source: updated.source,
        confidence: updated.confidence,
      },
    });
  } catch {
    return NextResponse.json({ error: "Entry not found." }, { status: 404 });
  }
}
