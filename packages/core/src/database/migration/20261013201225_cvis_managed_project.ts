import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261013201225_cvis_managed_project",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`cvis_managed_project\` (
          \`id\` text PRIMARY KEY,
          \`slug\` text NOT NULL,
          \`type\` text DEFAULT 'work' NOT NULL,
          \`owner\` text DEFAULT '' NOT NULL,
          \`mission\` text DEFAULT '' NOT NULL,
          \`status\` text DEFAULT 'planning' NOT NULL,
          \`native_project_id\` text,
          \`metadata\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`cvis_managed_project_slug_idx\` ON \`cvis_managed_project\` (\`slug\`);`)
      yield* tx.run(
        `CREATE INDEX \`cvis_managed_project_native_idx\` ON \`cvis_managed_project\` (\`native_project_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`cvis_managed_project_status_idx\` ON \`cvis_managed_project\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
