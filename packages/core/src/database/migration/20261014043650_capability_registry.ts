import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261014043650_capability_registry",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`cvis_capability\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`name\` text NOT NULL,
          \`version\` integer DEFAULT 1 NOT NULL,
          \`description\` text NOT NULL,
          \`source\` text,
          \`install_payload\` text,
          \`status\` text DEFAULT 'proposed' NOT NULL,
          \`project_id\` text NOT NULL,
          \`proposed_by\` text,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_cvis_capability_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`cvis_capability_kind_name_version_project_idx\` ON \`cvis_capability\` (\`kind\`,\`name\`,\`version\`,\`project_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`cvis_capability_project_status_idx\` ON \`cvis_capability\` (\`project_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
