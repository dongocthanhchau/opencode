import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261014030332_memory_scope",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`memory_fact\` ADD \`scope\` text DEFAULT 'project' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`memory_item\` ADD \`scope\` text DEFAULT 'project' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
