import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012230000_ensure_memory_fts",
  up(tx) {
    return Effect.gen(function* () {
      // Repair migration: fresh DBs created via schema.gen never got the FTS
      // virtual tables (they live outside the drizzle schema). Rebuild both
      // indexes from scratch so missing, stale, or partial FTS is fixed.
      yield* tx.run('CREATE VIRTUAL TABLE IF NOT EXISTS "memory_fact_fts" USING fts5("id" UNINDEXED, "fact", "topic");')
      yield* tx.run('CREATE VIRTUAL TABLE IF NOT EXISTS "memory_item_fts" USING fts5("id" UNINDEXED, "fact", "topic");')
      yield* tx.run('DROP TRIGGER IF EXISTS "memory_fact_fts_insert";')
      yield* tx.run('DROP TRIGGER IF EXISTS "memory_fact_fts_delete";')
      yield* tx.run('DROP TRIGGER IF EXISTS "memory_fact_fts_update";')
      yield* tx.run('DROP TRIGGER IF EXISTS "memory_item_fts_insert";')
      yield* tx.run('DROP TRIGGER IF EXISTS "memory_item_fts_delete";')
      yield* tx.run('DROP TRIGGER IF EXISTS "memory_item_fts_update";')
      yield* tx.run('CREATE TRIGGER "memory_fact_fts_insert" AFTER INSERT ON "memory_fact" BEGIN INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic") VALUES (new.rowid, new."id", new."fact", new."topic"); END;')
      yield* tx.run('CREATE TRIGGER "memory_fact_fts_delete" AFTER DELETE ON "memory_fact" BEGIN DELETE FROM "memory_fact_fts" WHERE rowid = old.rowid; END;')
      yield* tx.run('CREATE TRIGGER "memory_fact_fts_update" AFTER UPDATE ON "memory_fact" BEGIN DELETE FROM "memory_fact_fts" WHERE rowid = old.rowid; INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic") VALUES (new.rowid, new."id", new."fact", new."topic"); END;')
      yield* tx.run('CREATE TRIGGER "memory_item_fts_insert" AFTER INSERT ON "memory_item" BEGIN INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic") VALUES (new.rowid, new."id", new."claim", new."topic"); END;')
      yield* tx.run('CREATE TRIGGER "memory_item_fts_delete" AFTER DELETE ON "memory_item" BEGIN DELETE FROM "memory_item_fts" WHERE rowid = old.rowid; END;')
      yield* tx.run('CREATE TRIGGER "memory_item_fts_update" AFTER UPDATE ON "memory_item" BEGIN DELETE FROM "memory_item_fts" WHERE rowid = old.rowid; INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic") VALUES (new.rowid, new."id", new."claim", new."topic"); END;')
      yield* tx.run('DELETE FROM "memory_fact_fts";')
      yield* tx.run('INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic") SELECT rowid, "id", "fact", "topic" FROM "memory_fact";')
      yield* tx.run('DELETE FROM "memory_item_fts";')
      yield* tx.run('INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic") SELECT rowid, "id", "claim", "topic" FROM "memory_item";')
    })
  },
} satisfies DatabaseMigration.Migration
