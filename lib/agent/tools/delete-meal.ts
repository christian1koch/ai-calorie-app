import { prisma } from "@/lib/prisma";

export async function deleteMeal(args: { mealId: number | null; berlinDate: string; deleteAll: boolean }) {
  const mealDelegate = (prisma as unknown as {
    meal?: {
      findMany: (args: unknown) => Promise<Array<{ id: number }>>;
      updateMany: (args: unknown) => Promise<unknown>;
    };
  }).meal;

  if (!mealDelegate) {
    return { mealIds: [] as number[] };
  }

  if (args.deleteAll) {
    const meals = await mealDelegate.findMany({ where: { berlinDate: args.berlinDate }, select: { id: true } });
    if (meals.length === 0) return { mealIds: [] as number[] };
    const ids = meals.map((m) => m.id);
    await prisma.mealEntry.updateMany({ where: { mealId: { in: ids }, deletedAt: null }, data: { deletedAt: new Date() } });
    await mealDelegate.updateMany({ where: { id: { in: ids } }, data: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 } });
    return { mealIds: ids };
  }

  if (!args.mealId) {
    return { mealIds: [] as number[] };
  }

  await prisma.mealEntry.updateMany({ where: { mealId: args.mealId, deletedAt: null }, data: { deletedAt: new Date() } });
  await mealDelegate.updateMany({ where: { id: args.mealId }, data: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 } });

  return { mealIds: [args.mealId] };
}
