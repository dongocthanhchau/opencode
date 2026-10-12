import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012221000_memory_item_fts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run('CREATE VIRTUAL TABLE IF NOT EXISTS "memory_item_fts" USING fts5("id" UNINDEXED, "fact", "topic");')
      yield* tx.run('INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic") SELECT rowid, "id", "claim", "topic" FROM "memory_item";')
      yield* tx.run('CREATE TRIGGER IF NOT EXISTS "memory_item_fts_insert" AFTER INSERT ON "memory_item" BEGIN INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic") VALUES (new.rowid, new."id", new."claim", new."topic"); END;')
      yield* tx.run('CREATE TRIGGER IF NOT EXISTS "memory_item_fts_delete" AFTER DELETE ON "memory_item" BEGIN DELETE FROM "memory_item_fts" WHERE rowid = old.rowid; END;')
      yield* tx.run('CREATE TRIGGER IF NOT EXISTS "memory_item_fts_update" AFTER UPDATE ON "memory_item" BEGIN DELETE FROM "memory_item_fts" WHERE rowid = old.rowid; INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic") VALUES (new.rowid, new."id", new."claim", new."topic"); END;')
    })
  },
} satisfies DatabaseMigration.Migration
