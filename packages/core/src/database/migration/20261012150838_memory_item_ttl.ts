import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012150838_memory_item_ttl",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`memory_item\` ADD \`ttl_days\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
