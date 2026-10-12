import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261013000000_memory_fts_project",
  up(tx) {
    return Effect.gen(function* () {
      // Rebuild both FTS indexes with a stored (unindexed) project_id column
      // so recall can scope the prefilter per project instead of a global
      // LIMIT that foreign projects can starve out.
      for (const trigger of [
        "memory_fact_fts_insert",
        "memory_fact_fts_delete",
        "memory_fact_fts_update",
        "memory_item_fts_insert",
        "memory_item_fts_delete",
        "memory_item_fts_update",
      ]) {
        yield* tx.run(`DROP TRIGGER IF EXISTS "${trigger}";`)
      }
      yield* tx.run('DROP TABLE IF EXISTS "memory_fact_fts";')
      yield* tx.run('DROP TABLE IF EXISTS "memory_item_fts";')
      yield* tx.run('CREATE VIRTUAL TABLE "memory_fact_fts" USING fts5("id" UNINDEXED, "fact", "topic", "project_id" UNINDEXED);')
      yield* tx.run('CREATE VIRTUAL TABLE "memory_item_fts" USING fts5("id" UNINDEXED, "fact", "topic", "project_id" UNINDEXED);')
      yield* tx.run('CREATE TRIGGER "memory_fact_fts_insert" AFTER INSERT ON "memory_fact" BEGIN INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic", "project_id") VALUES (new.rowid, new."id", new."fact", new."topic", new."project_id"); END;')
      yield* tx.run('CREATE TRIGGER "memory_fact_fts_delete" AFTER DELETE ON "memory_fact" BEGIN DELETE FROM "memory_fact_fts" WHERE rowid = old.rowid; END;')
      yield* tx.run('CREATE TRIGGER "memory_fact_fts_update" AFTER UPDATE ON "memory_fact" BEGIN DELETE FROM "memory_fact_fts" WHERE rowid = old.rowid; INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic", "project_id") VALUES (new.rowid, new."id", new."fact", new."topic", new."project_id"); END;')
      yield* tx.run('CREATE TRIGGER "memory_item_fts_insert" AFTER INSERT ON "memory_item" BEGIN INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic", "project_id") VALUES (new.rowid, new."id", new."claim", new."topic", new."project_id"); END;')
      yield* tx.run('CREATE TRIGGER "memory_item_fts_delete" AFTER DELETE ON "memory_item" BEGIN DELETE FROM "memory_item_fts" WHERE rowid = old.rowid; END;')
      yield* tx.run('CREATE TRIGGER "memory_item_fts_update" AFTER UPDATE ON "memory_item" BEGIN DELETE FROM "memory_item_fts" WHERE rowid = old.rowid; INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic", "project_id") VALUES (new.rowid, new."id", new."claim", new."topic", new."project_id"); END;')
      yield* tx.run('INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic", "project_id") SELECT rowid, "id", "fact", "topic", "project_id" FROM "memory_fact";')
      yield* tx.run('INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic", "project_id") SELECT rowid, "id", "claim", "topic", "project_id" FROM "memory_item";')
    })
  },
} satisfies DatabaseMigration.Migration
