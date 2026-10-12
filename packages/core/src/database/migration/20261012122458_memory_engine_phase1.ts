import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012122458_memory_engine_phase1",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_archive\` (
          \`id\` text PRIMARY KEY,
          \`date\` text NOT NULL,
          \`session_id\` text,
          \`project_id\` text,
          \`payload\` text NOT NULL,
          \`vault_path\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_fact\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text,
          \`project_id\` text,
          \`fact\` text NOT NULL,
          \`topic\` text DEFAULT '' NOT NULL,
          \`keywords\` text,
          \`embedding\` text,
          \`vault_path\` text,
          \`hash\` text DEFAULT '' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_fact_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_fact_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`memory_archive_date_idx\` ON \`memory_archive\` (\`date\`);`)
      yield* tx.run(`CREATE INDEX \`memory_fact_session_idx\` ON \`memory_fact\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_fact_project_idx\` ON \`memory_fact\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_fact_topic_idx\` ON \`memory_fact\` (\`topic\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_fact_hash_idx\` ON \`memory_fact\` (\`hash\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
