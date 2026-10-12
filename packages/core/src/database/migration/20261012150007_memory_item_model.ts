import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012150007_memory_item_model",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_evidence\` (
          \`id\` text PRIMARY KEY,
          \`item_id\` text NOT NULL,
          \`kind\` text DEFAULT 'quote' NOT NULL,
          \`ref\` text,
          \`content\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_evidence_item_id_memory_item_id_fk\` FOREIGN KEY (\`item_id\`) REFERENCES \`memory_item\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_item\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text,
          \`kind\` text DEFAULT 'fact' NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`claim\` text NOT NULL,
          \`topic\` text DEFAULT '' NOT NULL,
          \`keywords\` text,
          \`embedding\` text,
          \`trust\` real DEFAULT 1 NOT NULL,
          \`version\` integer DEFAULT 1 NOT NULL,
          \`source_id\` text,
          \`session_id\` text,
          \`vault_path\` text,
          \`hash\` text DEFAULT '' NOT NULL,
          \`fetched_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_item_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_item_source_id_memory_source_id_fk\` FOREIGN KEY (\`source_id\`) REFERENCES \`memory_source\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_job\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`payload\` text,
          \`attempts\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_relation\` (
          \`id\` text PRIMARY KEY,
          \`from_id\` text NOT NULL,
          \`to_id\` text NOT NULL,
          \`relation\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_relation_from_id_memory_item_id_fk\` FOREIGN KEY (\`from_id\`) REFERENCES \`memory_item\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_relation_to_id_memory_item_id_fk\` FOREIGN KEY (\`to_id\`) REFERENCES \`memory_item\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_source\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text DEFAULT 'session' NOT NULL,
          \`ref\` text,
          \`trust\` real DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_tombstone\` (
          \`id\` text PRIMARY KEY,
          \`hash\` text NOT NULL,
          \`project_id\` text,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`memory_evidence_item_idx\` ON \`memory_evidence\` (\`item_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_item_project_idx\` ON \`memory_item\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_item_status_idx\` ON \`memory_item\` (\`status\`);`)
      yield* tx.run(`CREATE INDEX \`memory_item_topic_idx\` ON \`memory_item\` (\`topic\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_item_project_hash_idx\` ON \`memory_item\` (\`project_id\`,\`hash\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_job_status_idx\` ON \`memory_job\` (\`status\`);`)
      yield* tx.run(`CREATE INDEX \`memory_relation_from_idx\` ON \`memory_relation\` (\`from_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_relation_triple_idx\` ON \`memory_relation\` (\`from_id\`,\`to_id\`,\`relation\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_source_kind_idx\` ON \`memory_source\` (\`kind\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_tombstone_project_hash_idx\` ON \`memory_tombstone\` (\`project_id\`,\`hash\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
