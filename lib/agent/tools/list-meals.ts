import { prisma } from "@/lib/prisma";

export async function listMeals(berlinDate: string) {
  const mealDelegate = (prisma as unknown as {
    meal?: {
      findMany: (args: unknown) => Promise<Array<{ id: number; label: string; berlinTime: string; kcal: number | null }>>;
    };
  }).meal;

  if (!mealDelegate) {
    return [] as Array<{ id: number; label: string; berlinTime: string; kcal: number | null }>;
  }

  return mealDelegate.findMany({
    where: { berlinDate },
    orderBy: [{ berlinTime: "desc" }, { id: "desc" }],
    select: { id: true, label: true, berlinTime: true, kcal: true },
    take: 30,
  });
}
