import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
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
      max_tokens?: number
    }>(),
    acceptance: text({ mode: "json" }).$type<{ id: string; label: string; weight: number }[]>(),
    dependencies: text({ mode: "json" }).$type<string[]>(),
    assigned_session: text(),
    attempt: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [
    index("cvis_task_project_idx").on(table.project_id),
    index("cvis_task_goal_idx").on(table.goal_id),
    index("cvis_task_status_idx").on(table.status),
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
    ...Timestamps,
  },
  (table) => [index("cvis_binding_project_idx").on(table.project_id), index("cvis_binding_task_idx").on(table.task_id)],
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
    payload: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [index("cvis_event_project_time_idx").on(table.project_id, table.time_created, table.id)],
)
