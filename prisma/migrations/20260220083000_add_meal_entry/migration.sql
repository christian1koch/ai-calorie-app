-- CreateTable
CREATE TABLE "MealEntry" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "intent" TEXT NOT NULL DEFAULT 'log_meal',
  "rawText" TEXT NOT NULL,
  "item" TEXT NOT NULL,
  "amountGrams" REAL,
  "kcal" REAL,
  "proteinG" REAL,
  "carbsG" REAL,
  "fatG" REAL,
  "source" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "assumptions" TEXT NOT NULL,
  "lookupSourceType" TEXT,
  "lookupLabel" TEXT,
  "agentModel" TEXT,
  "berlinDate" TEXT NOT NULL,
  "berlinTime" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "MealEntry_berlinDate_idx" ON "MealEntry"("berlinDate");
