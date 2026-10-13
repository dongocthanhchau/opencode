import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261013005454_cvis_checks_revisions",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`cvis_check\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`check_id\` text NOT NULL,
          \`run_id\` text,
          \`verifier_session\` text NOT NULL,
          \`verdict\` text NOT NULL,
          \`evidence\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_cvis_check_task_id_cvis_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`cvis_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_cvis_check_run_id_cvis_task_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`cvis_task_run\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`cvis_task\` ADD \`revision\` integer DEFAULT 1 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`cvis_task\` ADD \`supersedes_task\` text;`)
      yield* tx.run(`CREATE INDEX \`cvis_check_task_idx\` ON \`cvis_check\` (\`task_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`cvis_check_task_check_idx\` ON \`cvis_check\` (\`task_id\`,\`check_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
