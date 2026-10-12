import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import type { SessionMessage } from "./message"
import type { Prompt } from "./prompt"
import type { SessionInput } from "./input"
import type { Snapshot } from "../snapshot"
import { PermissionV1 } from "../v1/permission"
import { ProjectV2 } from "../project"
import type { SessionSchema } from "./schema"
import type { MessageID, PartID, SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import { AgentV2 } from "../agent"
import type { Revert } from "@opencode-ai/schema/revert"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
type V1MessageData = Omit<SessionV1.Info, "id" | "sessionID">
type V1PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.LegacyFileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Revert.State>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1MessageData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<Prompt>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<SystemContext.Snapshot>(),
  baseline_seq: integer().notNull(),
})

export const MemoryFactTable = sqliteTable(
  "memory_fact",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    project_id: text()
      .$type<ProjectV2.ID>()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    fact: text().notNull(),
    topic: text().notNull().default(""),
    keywords: text({ mode: "json" }).$type<string[]>(),
    embedding: text({ mode: "json" }).$type<number[]>(),
    vault_path: text(),
    kind: text().notNull().default("fact"),
    source: text().notNull().default("session"),
    trust: real().notNull().default(1.0),
    ttl_days: integer(),
    fetched_at: integer(),
    hash: text().notNull().default(""),
    ...Timestamps,
  },
  (table) => [
    index("memory_fact_session_idx").on(table.session_id),
    index("memory_fact_project_idx").on(table.project_id),
    index("memory_fact_topic_idx").on(table.topic),
    uniqueIndex("memory_fact_project_hash_idx").on(table.project_id, table.hash),
  ],
)

export const MemoryArchiveTable = sqliteTable(
  "memory_archive",
  {
    id: text().primaryKey(),
    date: text().notNull(),
    session_id: text().$type<SessionSchema.ID>(),
    project_id: text().$type<ProjectV2.ID>(),
    payload: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    vault_path: text(),
    ...Timestamps,
  },
  (table) => [index("memory_archive_date_idx").on(table.date)],
)

export const MemorySourceTable = sqliteTable(
  "memory_source",
  {
    id: text().primaryKey(),
    kind: text().notNull().default("session"),
    ref: text(),
    trust: real().notNull().default(1.0),
    ...Timestamps,
  },
  (table) => [index("memory_source_kind_idx").on(table.kind)],
)

export const MemoryItemTable = sqliteTable(
  "memory_item",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    kind: text().notNull().default("fact"),
    status: text().notNull().default("active"),
    claim: text().notNull(),
    topic: text().notNull().default(""),
    keywords: text({ mode: "json" }).$type<string[]>(),
    embedding: text({ mode: "json" }).$type<number[]>(),
    trust: real().notNull().default(1.0),
    version: integer().notNull().default(1),
    ttl_days: integer(),
    source_id: text().references(() => MemorySourceTable.id, { onDelete: "set null" }),
    session_id: text().$type<SessionSchema.ID>(),
    vault_path: text(),
    hash: text().notNull().default(""),
    fetched_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("memory_item_project_idx").on(table.project_id),
    index("memory_item_status_idx").on(table.status),
    index("memory_item_topic_idx").on(table.topic),
    uniqueIndex("memory_item_project_hash_idx").on(table.project_id, table.hash),
  ],
)

export const MemoryEvidenceTable = sqliteTable(
  "memory_evidence",
  {
    id: text().primaryKey(),
    item_id: text()
      .notNull()
      .references(() => MemoryItemTable.id, { onDelete: "cascade" }),
    kind: text().notNull().default("quote"),
    ref: text(),
    content: text(),
    ...Timestamps,
  },
  (table) => [index("memory_evidence_item_idx").on(table.item_id)],
)

export const MemoryRelationTable = sqliteTable(
  "memory_relation",
  {
    id: text().primaryKey(),
    from_id: text()
      .notNull()
      .references(() => MemoryItemTable.id, { onDelete: "cascade" }),
    to_id: text()
      .notNull()
      .references(() => MemoryItemTable.id, { onDelete: "cascade" }),
    relation: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("memory_relation_from_idx").on(table.from_id),
    uniqueIndex("memory_relation_triple_idx").on(table.from_id, table.to_id, table.relation),
  ],
)

export const MemoryTombstoneTable = sqliteTable(
  "memory_tombstone",
  {
    id: text().primaryKey(),
    hash: text().notNull(),
    project_id: text().$type<ProjectV2.ID>(),
    reason: text(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("memory_tombstone_project_hash_idx").on(table.project_id, table.hash)],
)

export const MemoryJobTable = sqliteTable(
  "memory_job",
  {
    id: text().primaryKey(),
    kind: text().notNull(),
    status: text().notNull().default("pending"),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>(),
    attempts: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("memory_job_status_idx").on(table.status)],
)
