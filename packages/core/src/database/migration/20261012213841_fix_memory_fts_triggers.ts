import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012213841_fix_memory_fts_triggers",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run('DROP TRIGGER IF EXISTS "memory_fact_fts_delete";')
      yield* tx.run('DROP TRIGGER IF EXISTS "memory_fact_fts_update";')
      yield* tx.run('CREATE TRIGGER "memory_fact_fts_delete" AFTER DELETE ON "memory_fact" BEGIN DELETE FROM "memory_fact_fts" WHERE rowid = old.rowid; END;')
      yield* tx.run('CREATE TRIGGER "memory_fact_fts_update" AFTER UPDATE ON "memory_fact" BEGIN DELETE FROM "memory_fact_fts" WHERE rowid = old.rowid; INSERT INTO "memory_fact_fts"("id", "fact", "topic") VALUES (new."id", new."fact", new."topic"); END;')
      yield* tx.run('DELETE FROM "memory_fact_fts";')
      yield* tx.run('INSERT INTO "memory_fact_fts"("id", "fact", "topic") SELECT "id", "fact", "topic" FROM "memory_fact";')
    })
  },
} satisfies DatabaseMigration.Migration
