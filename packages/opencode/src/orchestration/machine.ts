export const TaskStatus = [
  "draft",
  "queued",
  "running",
  "verifying",
  "blocked",
  "paused",
  "failed",
  "cancelled",
  "done",
] as const
export type TaskStatus = (typeof TaskStatus)[number]

const TaskTransitions: Record<TaskStatus, TaskStatus[]> = {
  draft: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["verifying", "blocked", "paused", "failed", "cancelled"],
  verifying: ["done", "failed", "running", "paused", "cancelled"],
  blocked: ["queued", "cancelled"],
  paused: ["queued", "cancelled"],
  failed: ["queued", "cancelled"],
  cancelled: [],
  done: [],
}

export const GoalStatus = ["planning", "active", "paused", "blocked", "completed", "cancelled"] as const
export type GoalStatus = (typeof GoalStatus)[number]

const GoalTransitions: Record<GoalStatus, GoalStatus[]> = {
  planning: ["active", "cancelled"],
  active: ["paused", "blocked", "completed", "cancelled"],
  paused: ["active", "cancelled"],
  blocked: ["active", "cancelled"],
  completed: [],
  cancelled: [],
}

export const RunStatus = ["pending", "running", "verifying", "done", "failed", "cancelled"] as const
export type RunStatus = (typeof RunStatus)[number]

const RunTransitions: Record<RunStatus, RunStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["verifying", "failed", "cancelled"],
  verifying: ["done", "failed"],
  done: [],
  failed: [],
  cancelled: [],
}

export const BindingStatus = ["idle", "busy", "paused"] as const
export type BindingStatus = (typeof BindingStatus)[number]

const BindingTransitions: Record<BindingStatus, BindingStatus[]> = {
  idle: ["busy", "paused"],
  busy: ["idle", "paused"],
  paused: ["idle"],
}

export const MessageKind = ["assign", "progress", "question", "blocked", "result", "review", "cancel", "ack"] as const
export type MessageKind = (typeof MessageKind)[number]

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TaskTransitions[from]?.includes(to) ?? false
}

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return GoalTransitions[from]?.includes(to) ?? false
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RunTransitions[from]?.includes(to) ?? false
}

export function canTransitionBinding(from: BindingStatus, to: BindingStatus): boolean {
  return BindingTransitions[from]?.includes(to) ?? false
}

export interface ChecklistItem {
  id: string
  label: string
  weight: number
}

// Progress counts only verified checklist weight. Retries and revisions are
// safe by construction: callers pass the current acceptance list, so removed
// items drop out and re-verified items count once.
export function checklistProgress(
  acceptance: ChecklistItem[],
  passed: Set<string> | string[],
): { percent: number; passed: string[]; pending: string[] } {
  const done = Array.isArray(passed) ? new Set(passed) : passed
  const total = acceptance.reduce((sum, item) => sum + item.weight, 0)
  if (total <= 0) return { percent: 0, passed: [], pending: acceptance.map((item) => item.id) }
  const doneWeight = acceptance.filter((item) => done.has(item.id)).reduce((sum, item) => sum + item.weight, 0)
  return {
    percent: Math.floor((doneWeight / total) * 100),
    passed: acceptance.filter((item) => done.has(item.id)).map((item) => item.id),
    pending: acceptance.filter((item) => !done.has(item.id)).map((item) => item.id),
  }
}

// Terminal states never leave, so a restarted manager can safely resume
// anything else from durable state without re-deciding finished work.
export function isTerminalTask(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled"
}

export * as OrchestrationMachine from "./machine"
