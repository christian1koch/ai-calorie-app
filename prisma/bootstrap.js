const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const products = [
  {
    name: "Milbona Skyr Natur",
    aliases: "skyr,milbona skyr,natur skyr",
    searchText: "milbona skyr natur skyr",
    kcalPer100g: 62,
    proteinPer100g: 11,
    carbsPer100g: 3.9,
    fatPer100g: 0.2,
  },
  {
    name: "Magerquark",
    aliases: "quark,magerquark",
    searchText: "magerquark quark",
    kcalPer100g: 67,
    proteinPer100g: 12,
    carbsPer100g: 4,
    fatPer100g: 0.2,
  },
  {
    name: "Haferflocken",
    aliases: "oats,haferflocken",
    searchText: "haferflocken oats oatmeal",
    kcalPer100g: 372,
    proteinPer100g: 13.5,
    carbsPer100g: 58.7,
    fatPer100g: 7,
  },
];

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ConsumedProduct" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "aliases" TEXT NOT NULL DEFAULT '',
      "searchText" TEXT NOT NULL,
      "kcalPer100g" REAL NOT NULL,
      "proteinPer100g" REAL NOT NULL,
      "carbsPer100g" REAL NOT NULL,
      "fatPer100g" REAL NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "ConsumedProduct_name_key" ON "ConsumedProduct"("name");'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "ConsumedProduct_searchText_idx" ON "ConsumedProduct"("searchText");'
  );

  for (const product of products) {
    await prisma.consumedProduct.upsert({
      where: { name: product.name },
      update: product,
      create: product,
    });
  }
}

main()
  .catch((error) => {
    console.error("Prisma bootstrap failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
