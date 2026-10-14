import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261014041625_template_canary",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`cvis_prompt_template\` ADD \`status\` text DEFAULT 'stable' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`cvis_prompt_template\` ADD \`canary_pct\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
