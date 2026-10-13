import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261013030638_orchestration_verified_execution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`cvis_check\` ADD \`revision\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`cvis_event\` ADD \`sequence\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`cvis_session_binding\` ADD \`permission_ceiling\` text;`)
      yield* tx.run(`ALTER TABLE \`cvis_task_run\` ADD \`revision\` integer DEFAULT 1 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`cvis_task_run\` ADD \`lease_expires\` integer;`)
      yield* tx.run(`ALTER TABLE \`cvis_task\` ADD \`active_run_id\` text;`)
      yield* tx.run(`ALTER TABLE \`cvis_task\` ADD \`weight\` integer DEFAULT 1 NOT NULL;`)
      yield* tx.run(`UPDATE cvis_event SET sequence = rowid;`)
    })
  },
} satisfies DatabaseMigration.Migration
