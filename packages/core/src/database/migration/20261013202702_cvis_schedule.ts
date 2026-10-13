import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261013202702_cvis_schedule",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`cvis_schedule\` (
          \`id\` text PRIMARY KEY,
          \`managed_project_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`kind\` text DEFAULT 'health' NOT NULL,
          \`payload\` text,
          \`interval_seconds\` integer,
          \`enabled\` integer DEFAULT 1 NOT NULL,
          \`next_due_at\` integer NOT NULL,
          \`lease_owner\` text,
          \`lease_expires\` integer,
          \`last_status\` text,
          \`last_run_at\` integer,
          \`consecutive_failures\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_cvis_schedule_managed_project_id_cvis_managed_project_id_fk\` FOREIGN KEY (\`managed_project_id\`) REFERENCES \`cvis_managed_project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`cvis_schedule_managed_name_idx\` ON \`cvis_schedule\` (\`managed_project_id\`,\`name\`);`,
      )
      yield* tx.run(`CREATE INDEX \`cvis_schedule_due_idx\` ON \`cvis_schedule\` (\`enabled\`,\`next_due_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
