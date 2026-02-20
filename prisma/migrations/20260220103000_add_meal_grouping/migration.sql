-- CreateTable
CREATE TABLE "Meal" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "rawText" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "kcal" REAL,
  "proteinG" REAL,
  "carbsG" REAL,
  "fatG" REAL,
  "confidence" TEXT NOT NULL,
  "assumptions" TEXT NOT NULL,
  "berlinDate" TEXT NOT NULL,
  "berlinTime" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Meal_berlinDate_idx" ON "Meal"("berlinDate");

-- AlterTable
ALTER TABLE "MealEntry" ADD COLUMN "mealId" INTEGER;

-- CreateIndex
CREATE INDEX "MealEntry_mealId_idx" ON "MealEntry"("mealId");
