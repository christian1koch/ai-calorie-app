-- CreateTable
CREATE TABLE "ConsumedProduct" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL,
  "aliases" TEXT NOT NULL DEFAULT '',
  "searchText" TEXT NOT NULL,
  "kcalPer100g" REAL NOT NULL,
  "proteinPer100g" REAL NOT NULL,
  "carbsPer100g" REAL NOT NULL,
  "fatPer100g" REAL NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsumedProduct_name_key" ON "ConsumedProduct"("name");

-- CreateIndex
CREATE INDEX "ConsumedProduct_searchText_idx" ON "ConsumedProduct"("searchText");
