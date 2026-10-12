import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012134138_memory_provenance_fts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run('ALTER TABLE "memory_fact" ADD "kind" text DEFAULT \'fact\' NOT NULL;')
      yield* tx.run('ALTER TABLE "memory_fact" ADD "source" text DEFAULT \'session\' NOT NULL;')
      yield* tx.run('ALTER TABLE "memory_fact" ADD "trust" real DEFAULT 1 NOT NULL;')
      yield* tx.run('ALTER TABLE "memory_fact" ADD "ttl_days" integer;')
      yield* tx.run('ALTER TABLE "memory_fact" ADD "fetched_at" integer;')
      yield* tx.run('CREATE VIRTUAL TABLE IF NOT EXISTS "memory_fact_fts" USING fts5("id" UNINDEXED, "fact", "topic");')
      yield* tx.run('INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic") SELECT rowid, "id", "fact", "topic" FROM "memory_fact";')
      yield* tx.run('CREATE TRIGGER IF NOT EXISTS "memory_fact_fts_insert" AFTER INSERT ON "memory_fact" BEGIN INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic") VALUES (new.rowid, new."id", new."fact", new."topic"); END;')
      yield* tx.run('CREATE TRIGGER IF NOT EXISTS "memory_fact_fts_delete" AFTER DELETE ON "memory_fact" BEGIN DELETE FROM "memory_fact_fts" WHERE rowid = old.rowid; END;')
      yield* tx.run('CREATE TRIGGER IF NOT EXISTS "memory_fact_fts_update" AFTER UPDATE ON "memory_fact" BEGIN DELETE FROM "memory_fact_fts" WHERE rowid = old.rowid; INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic") VALUES (new.rowid, new."id", new."fact", new."topic"); END;')
    })
  },
} satisfies DatabaseMigration.Migration
