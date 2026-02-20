import { prisma } from "@/lib/prisma";

let schemaEnsured = false;

type TableColumnInfo = {
  name: string;
};

async function trySql(sql: string) {
  try {
    await prisma.$executeRawUnsafe(sql);
  } catch {
    // Ignore if already exists.
  }
}

export async function ensureAgentV2Schema() {
  if (schemaEnsured) return;

  const existingColumns = new Set(
    (
      (await prisma.$queryRawUnsafe('PRAGMA table_info("MealEntry");')) as TableColumnInfo[]
    ).map((column) => column.name)
  );

  if (!existingColumns.has("assumptionsJson")) {
    await trySql('ALTER TABLE "MealEntry" ADD COLUMN "assumptionsJson" TEXT NOT NULL DEFAULT \'[]\';');
  }
  if (!existingColumns.has("provenanceJson")) {
    await trySql('ALTER TABLE "MealEntry" ADD COLUMN "provenanceJson" TEXT NOT NULL DEFAULT \'{}\';');
  }
  if (!existingColumns.has("confidenceScore")) {
    await trySql('ALTER TABLE "MealEntry" ADD COLUMN "confidenceScore" REAL;');
  }
  if (!existingColumns.has("deletedAt")) {
    await trySql('ALTER TABLE "MealEntry" ADD COLUMN "deletedAt" DATETIME;');
  }
  await trySql('CREATE INDEX IF NOT EXISTS "MealEntry_deletedAt_idx" ON "MealEntry"("deletedAt");');

  await trySql(`
    CREATE TABLE IF NOT EXISTS "ConversationSession" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "sessionId" TEXT NOT NULL,
      "activeMealId" INTEGER,
      "lastIntent" TEXT,
      "metadataJson" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await trySql('CREATE UNIQUE INDEX IF NOT EXISTS "ConversationSession_sessionId_key" ON "ConversationSession"("sessionId");');

  await trySql(`
    CREATE TABLE IF NOT EXISTS "MealAction" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "sessionId" TEXT,
      "mealId" INTEGER,
      "actionType" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "rawText" TEXT NOT NULL,
      "resolvedIntent" TEXT NOT NULL,
      "reason" TEXT,
      "entryIdsJson" TEXT NOT NULL DEFAULT '[]',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await trySql('CREATE INDEX IF NOT EXISTS "MealAction_sessionId_idx" ON "MealAction"("sessionId");');
  await trySql('CREATE INDEX IF NOT EXISTS "MealAction_mealId_idx" ON "MealAction"("mealId");');

  await trySql(`
    CREATE TABLE IF NOT EXISTS "EntryRevision" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "entryId" INTEGER NOT NULL,
      "actor" TEXT NOT NULL,
      "reason" TEXT NOT NULL,
      "beforeJson" TEXT NOT NULL,
      "afterJson" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await trySql('CREATE INDEX IF NOT EXISTS "EntryRevision_entryId_idx" ON "EntryRevision"("entryId");');

  await trySql(`
    UPDATE "MealEntry"
    SET "assumptionsJson" =
      CASE
        WHEN trim(COALESCE("assumptions", '')) = '' THEN '[]'
        ELSE '["' || replace(replace(replace("assumptions", '"', '\\"'), char(13), ''), char(10), '","') || '"]'
      END
    WHERE "assumptionsJson" = '[]' OR "assumptionsJson" IS NULL;
  `);

  await trySql(`
    UPDATE "MealEntry"
    SET "provenanceJson" = json_object(
      'sourceType', COALESCE("lookupSourceType", ''),
      'label', COALESCE("lookupLabel", ''),
      'url', COALESCE("lookupUrl", ''),
      'source', COALESCE("source", '')
    )
    WHERE "provenanceJson" = '{}' OR "provenanceJson" IS NULL;
  `);

  await trySql(`
    UPDATE "MealEntry"
    SET "confidenceScore" =
      CASE lower(COALESCE("confidence", ''))
        WHEN 'high' THEN 0.9
        WHEN 'medium' THEN 0.65
        WHEN 'low' THEN 0.35
        ELSE NULL
      END
    WHERE "confidenceScore" IS NULL;
  `);

  schemaEnsured = true;
}
