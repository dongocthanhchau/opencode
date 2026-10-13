import { expect, test } from "bun:test"
import { currentGoalTasks } from "../../src/orchestration/service"

test("superseded review history cannot block current goal regardless of legacy weight", () => {
  const target = { id: "target", role: "implementer", project_id: "p", goal_id: "g", revision: 4, scope: null }
  const old = { id: "old", role: "verifier", project_id: "p", goal_id: "g", revision: 1, scope: { review_task_id: "target", review_revision: 3 }, weight: 1 }
  const current = { ...old, id: "current", scope: { review_task_id: "target", review_revision: 4 } }
  expect(currentGoalTasks([target, old, current]).map((task) => task.id)).toEqual(["target", "current"])
})

test("ordinary cancelled work and invalid cross-project review remain required", () => {
  const target = { id: "target", role: "implementer", project_id: "p", goal_id: "g", revision: 4, scope: null }
  const cancelled = { ...target, id: "cancelled", status: "cancelled" }
  const other = { id: "other", role: "verifier", project_id: "other-p", goal_id: "g", revision: 1, scope: { review_task_id: "target", review_revision: 3 } }
  expect(currentGoalTasks([target, cancelled, other])).toHaveLength(3)
})

test("failed same-revision review is replaced only by a completed independent review", () => {
  const target = { id: "target", role: "implementer", project_id: "p", goal_id: "g", revision: 4, scope: null, status: "done" }
  const failed = { id: "failed-review", role: "verifier", project_id: "p", goal_id: "g", revision: 1, scope: { review_task_id: "target", review_revision: 4 }, status: "failed" }
  const current = { ...failed, id: "replacement", status: "done" }
  expect(currentGoalTasks([target, failed])).toHaveLength(2)
  expect(currentGoalTasks([target, failed, current]).map((task) => task.id)).toEqual(["target", "replacement"])
})
