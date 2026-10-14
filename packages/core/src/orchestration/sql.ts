import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectTable } from "../project/sql"
import { SessionTable } from "../session/sql"

export const CvisProjectGoalTable = sqliteTable(
  "cvis_project_goal",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    objective: text().notNull(),
    status: text().notNull().default("planning"),
    budget_tokens: integer(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [index("cvis_goal_project_idx").on(table.project_id)],
)

export const CvisTaskTable = sqliteTable(
  "cvis_task",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    goal_id: text().references(() => CvisProjectGoalTable.id, { onDelete: "set null" }),
    title: text().notNull(),
    description: text().notNull().default(""),
    role: text().notNull(),
    priority: integer().notNull().default(0),
    status: text().notNull().default("draft"),
    scope: text({ mode: "json" }).$type<{
      read_paths?: string[]
      write_paths?: string[]
      tools?: string[]
      commands?: string[]
      review_task_id?: string
      review_revision?: number
      max_tokens?: number
    }>(),
    acceptance: text({ mode: "json" }).$type<{ id: string; label: string; weight: number }[]>(),
    dependencies: text({ mode: "json" }).$type<string[]>(),
    assigned_session: text(),
    active_run_id: text(),
    weight: integer().notNull().default(1),
    attempt: integer().notNull().default(0),
    revision: integer().notNull().default(1),
    supersedes_task: text(),
    ...Timestamps,
  },
  (table) => [
    index("cvis_task_project_idx").on(table.project_id),
    index("cvis_task_goal_idx").on(table.goal_id),
    index("cvis_task_status_idx").on(table.status),
  ],
)

export const CvisCheckTable = sqliteTable(
  "cvis_check",
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => CvisTaskTable.id, { onDelete: "cascade" }),
    check_id: text().notNull(),
    run_id: text().references(() => CvisTaskRunTable.id, { onDelete: "set null" }),
    verifier_session: text().notNull(),
    revision: integer().notNull().default(0),
    verdict: text().notNull(),
    evidence: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    index("cvis_check_task_idx").on(table.task_id),
    uniqueIndex("cvis_check_task_check_idx").on(table.task_id, table.check_id),
  ],
)

export const CvisPromptTemplateTable = sqliteTable(
  "cvis_prompt_template",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    role: text(),
    version: integer().notNull().default(1),
    body: text().notNull(),
    inputs: text({ mode: "json" }).$type<{ name: string; required: boolean }[]>(),
    // Canary lifecycle: new rewrites land as canary, serve a rollout
    // bucket, and only replace the stable version on promote. Retired
    // versions stay readable for audit and rollback comparison.
    status: text().notNull().default("stable"),
    canary_pct: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("cvis_template_name_version_idx").on(table.name, table.version),
    index("cvis_template_role_idx").on(table.role),
  ],
)

export const CvisTaskRunTable = sqliteTable(
  "cvis_task_run",
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => CvisTaskTable.id, { onDelete: "cascade" }),
    session_id: text().notNull(),
    attempt: integer().notNull(),
    revision: integer().notNull().default(1),
    lease_expires: integer(),
    status: text().notNull().default("pending"),
    tokens_used: integer().notNull().default(0),
    result: text({ mode: "json" }).$type<Record<string, unknown>>(),
    error: text(),
    time_started: integer(),
    time_finished: integer(),
    ...Timestamps,
  },
  (table) => [
    index("cvis_run_task_idx").on(table.task_id),
    index("cvis_run_session_idx").on(table.session_id),
    uniqueIndex("cvis_run_task_attempt_idx").on(table.task_id, table.attempt),
  ],
)

export const CvisSessionBindingTable = sqliteTable(
  "cvis_session_binding",
  {
    session_id: text()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    role: text().notNull(),
    task_id: text().references(() => CvisTaskTable.id, { onDelete: "set null" }),
    manager_session: text(),
    status: text().notNull().default("idle"),
    permission_ceiling: text({ mode: "json" }).$type<
      { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[]
    >(),
    ...Timestamps,
  },
  (table) => [index("cvis_binding_project_idx").on(table.project_id), index("cvis_binding_task_idx").on(table.task_id)],
)

export const CvisCapabilityKind = ["tool", "skill", "mcp"] as const
export type CvisCapabilityKind = (typeof CvisCapabilityKind)[number]

export const CvisCapabilityStatus = ["proposed", "canary", "active", "deprecated"] as const
export type CvisCapabilityStatus = (typeof CvisCapabilityStatus)[number]

// Agent-proposed capabilities (tools, skills, MCP servers) with a
// propose -> canary -> active -> deprecated lifecycle. Update means a
// new version through the same flow; approving one version retires the
// older active ones so rollback is always one status flip away.
export const CvisCapabilityTable = sqliteTable(
  "cvis_capability",
  {
    id: text().primaryKey(),
    kind: text().notNull(),
    name: text().notNull(),
    version: integer().notNull().default(1),
    description: text().notNull(),
    source: text(),
    install_payload: text({ mode: "json" }).$type<Record<string, unknown>>(),
    status: text().notNull().default("proposed"),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    proposed_by: text(),
    reason: text(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("cvis_capability_kind_name_version_project_idx").on(
      table.kind,
      table.name,
      table.version,
      table.project_id,
    ),
    index("cvis_capability_project_status_idx").on(table.project_id, table.status),
  ],
)

export const CvisMessageTable = sqliteTable(
  "cvis_message",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    task_id: text().references(() => CvisTaskTable.id, { onDelete: "set null" }),
    run_id: text().references(() => CvisTaskRunTable.id, { onDelete: "set null" }),
    from_session: text().notNull(),
    to_session: text(),
    kind: text().notNull(),
    body: text({ mode: "json" }).$type<Record<string, unknown>>(),
    status: text().notNull().default("sent"),
    idempotency_key: text(),
    ...Timestamps,
  },
  (table) => [
    index("cvis_message_project_idx").on(table.project_id),
    index("cvis_message_task_idx").on(table.task_id),
    index("cvis_message_to_idx").on(table.to_session, table.status),
    uniqueIndex("cvis_message_idem_idx").on(table.project_id, table.idempotency_key),
  ],
)

export const CvisEventTable = sqliteTable(
  "cvis_event",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    entity_kind: text().notNull(),
    entity_id: text().notNull(),
    type: text().notNull(),
    sequence: integer().notNull().default(0),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [index("cvis_event_project_time_idx").on(table.project_id, table.time_created, table.id)],
)

export const ManagedProjectStatus = ["planning", "ready", "active", "paused", "completed", "archived"] as const
export type ManagedProjectStatus = (typeof ManagedProjectStatus)[number]

export const ManagedProjectType = ["core", "channel", "assistant-app", "work", "initiative"] as const
export type ManagedProjectType = (typeof ManagedProjectType)[number]

// Stable managed identity, independent of the native Git-derived project
// rows it links to. Native IDs may change on remote/path changes; the
// managed row (and everything referencing it) never moves.
export const CvisManagedProjectTable = sqliteTable(
  "cvis_managed_project",
  {
    id: text().primaryKey(),
    slug: text().notNull(),
    type: text().notNull().default("work"),
    owner: text().notNull().default(""),
    mission: text().notNull().default(""),
    status: text().notNull().default("planning"),
    native_project_id: text(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("cvis_managed_project_slug_idx").on(table.slug),
    index("cvis_managed_project_native_idx").on(table.native_project_id),
    index("cvis_managed_project_status_idx").on(table.status),
  ],
)

// Durable schedules owned by managed projects. A schedule is only ever
// executed by explicitly claiming it (single winner via lease CAS) and
// completing it; there is no in-process loop, so no legacy cron is
// replaced implicitly. Claim/complete are the only writers of lease state.
export const CvisScheduleTable = sqliteTable(
  "cvis_schedule",
  {
    id: text().primaryKey(),
    managed_project_id: text()
      .notNull()
      .references(() => CvisManagedProjectTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    kind: text().notNull().default("health"),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>(),
    interval_seconds: integer(),
    enabled: integer().notNull().default(1),
    next_due_at: integer().notNull(),
    lease_owner: text(),
    lease_expires: integer(),
    last_status: text(),
    last_run_at: integer(),
    consecutive_failures: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("cvis_schedule_managed_name_idx").on(table.managed_project_id, table.name),
    index("cvis_schedule_due_idx").on(table.enabled, table.next_due_at),
  ],
)
