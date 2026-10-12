import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012180321_cvis_orchestration_state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`cvis_event\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`entity_kind\` text NOT NULL,
          \`entity_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`payload\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_cvis_event_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`cvis_message\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`task_id\` text,
          \`run_id\` text,
          \`from_session\` text NOT NULL,
          \`to_session\` text,
          \`kind\` text NOT NULL,
          \`body\` text,
          \`status\` text DEFAULT 'sent' NOT NULL,
          \`idempotency_key\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_cvis_message_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_cvis_message_task_id_cvis_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`cvis_task\`(\`id\`) ON DELETE SET NULL,
          CONSTRAINT \`fk_cvis_message_run_id_cvis_task_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`cvis_task_run\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`cvis_project_goal\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`objective\` text NOT NULL,
          \`status\` text DEFAULT 'planning' NOT NULL,
          \`budget_tokens\` integer,
          \`metadata\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_cvis_project_goal_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`cvis_session_binding\` (
          \`session_id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`task_id\` text,
          \`manager_session\` text,
          \`status\` text DEFAULT 'idle' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_cvis_session_binding_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_cvis_session_binding_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_cvis_session_binding_task_id_cvis_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`cvis_task\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`cvis_task_run\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`attempt\` integer NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`tokens_used\` integer DEFAULT 0 NOT NULL,
          \`result\` text,
          \`error\` text,
          \`time_started\` integer,
          \`time_finished\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_cvis_task_run_task_id_cvis_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`cvis_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`cvis_task\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`goal_id\` text,
          \`title\` text NOT NULL,
          \`description\` text DEFAULT '' NOT NULL,
          \`role\` text NOT NULL,
          \`priority\` integer DEFAULT 0 NOT NULL,
          \`status\` text DEFAULT 'draft' NOT NULL,
          \`scope\` text,
          \`acceptance\` text,
          \`dependencies\` text,
          \`assigned_session\` text,
          \`attempt\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_cvis_task_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_cvis_task_goal_id_cvis_project_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`cvis_project_goal\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`cvis_event_project_time_idx\` ON \`cvis_event\` (\`project_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`cvis_message_project_idx\` ON \`cvis_message\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`cvis_message_task_idx\` ON \`cvis_message\` (\`task_id\`);`)
      yield* tx.run(`CREATE INDEX \`cvis_message_to_idx\` ON \`cvis_message\` (\`to_session\`,\`status\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`cvis_message_idem_idx\` ON \`cvis_message\` (\`project_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(`CREATE INDEX \`cvis_goal_project_idx\` ON \`cvis_project_goal\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`cvis_binding_project_idx\` ON \`cvis_session_binding\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`cvis_binding_task_idx\` ON \`cvis_session_binding\` (\`task_id\`);`)
      yield* tx.run(`CREATE INDEX \`cvis_run_task_idx\` ON \`cvis_task_run\` (\`task_id\`);`)
      yield* tx.run(`CREATE INDEX \`cvis_run_session_idx\` ON \`cvis_task_run\` (\`session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`cvis_run_task_attempt_idx\` ON \`cvis_task_run\` (\`task_id\`,\`attempt\`);`)
      yield* tx.run(`CREATE INDEX \`cvis_task_project_idx\` ON \`cvis_task\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`cvis_task_goal_idx\` ON \`cvis_task\` (\`goal_id\`);`)
      yield* tx.run(`CREATE INDEX \`cvis_task_status_idx\` ON \`cvis_task\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
