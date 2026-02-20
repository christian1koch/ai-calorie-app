-- Add V2 metadata and soft-delete columns to MealEntry.
ALTER TABLE "MealEntry" ADD COLUMN "assumptionsJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "MealEntry" ADD COLUMN "provenanceJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "MealEntry" ADD COLUMN "confidenceScore" REAL;
ALTER TABLE "MealEntry" ADD COLUMN "deletedAt" DATETIME;

-- Backfill structured assumptions from legacy newline-separated assumptions text.
UPDATE "MealEntry"
SET "assumptionsJson" =
  CASE
    WHEN trim(COALESCE("assumptions", '')) = '' THEN '[]'
    ELSE '["' || replace(replace(replace("assumptions", '"', '\\"'), char(13), ''), char(10), '","') || '"]'
  END;

-- Backfill provenance from existing lookup columns.
UPDATE "MealEntry"
SET "provenanceJson" = json_object(
  'sourceType', COALESCE("lookupSourceType", ''),
  'label', COALESCE("lookupLabel", ''),
  'url', COALESCE("lookupUrl", ''),
  'source', COALESCE("source", '')
);

-- Backfill numeric confidence score from legacy confidence enum text.
UPDATE "MealEntry"
SET "confidenceScore" =
  CASE lower(COALESCE("confidence", ''))
    WHEN 'high' THEN 0.9
    WHEN 'medium' THEN 0.65
    WHEN 'low' THEN 0.35
    ELSE NULL
  END;

CREATE INDEX "MealEntry_deletedAt_idx" ON "MealEntry"("deletedAt");

-- Session state for conversational orchestration.
CREATE TABLE "ConversationSession" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "sessionId" TEXT NOT NULL,
  "activeMealId" INTEGER,
  "lastIntent" TEXT,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ConversationSession_activeMealId_fkey" FOREIGN KEY ("activeMealId") REFERENCES "Meal" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConversationSession_sessionId_key" ON "ConversationSession"("sessionId");

-- Audit log for model/tool actions.
CREATE TABLE "MealAction" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "sessionId" TEXT,
  "mealId" INTEGER,
  "actionType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "rawText" TEXT NOT NULL,
  "resolvedIntent" TEXT NOT NULL,
  "reason" TEXT,
  "entryIdsJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MealAction_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "Meal" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "MealAction_sessionId_idx" ON "MealAction"("sessionId");
CREATE INDEX "MealAction_mealId_idx" ON "MealAction"("mealId");
CREATE INDEX "MealAction_createdAt_idx" ON "MealAction"("createdAt");

-- Revision history for entry patches.
CREATE TABLE "EntryRevision" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "entryId" INTEGER NOT NULL,
  "actor" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "beforeJson" TEXT NOT NULL,
  "afterJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EntryRevision_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "MealEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "EntryRevision_entryId_idx" ON "EntryRevision"("entryId");
CREATE INDEX "EntryRevision_createdAt_idx" ON "EntryRevision"("createdAt");
