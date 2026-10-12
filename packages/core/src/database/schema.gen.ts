import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
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
        CREATE TABLE \`memory_fact\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text,
          \`project_id\` text,
          \`fact\` text NOT NULL,
          \`topic\` text DEFAULT '' NOT NULL,
          \`keywords\` text,
          \`embedding\` text,
          \`vault_path\` text,
          \`kind\` text DEFAULT 'fact' NOT NULL,
          \`source\` text DEFAULT 'session' NOT NULL,
          \`trust\` real DEFAULT 1 NOT NULL,
          \`ttl_days\` integer,
          \`fetched_at\` integer,
          \`hash\` text DEFAULT '' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_fact_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_fact_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
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
          \`ttl_days\` integer,
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
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
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
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_archive_date_idx\` ON \`memory_archive\` (\`date\`);`)
      yield* tx.run(`CREATE INDEX \`memory_evidence_item_idx\` ON \`memory_evidence\` (\`item_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_fact_session_idx\` ON \`memory_fact\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_fact_project_idx\` ON \`memory_fact\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_fact_topic_idx\` ON \`memory_fact\` (\`topic\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_fact_project_hash_idx\` ON \`memory_fact\` (\`project_id\`,\`hash\`);`,
      )
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
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
