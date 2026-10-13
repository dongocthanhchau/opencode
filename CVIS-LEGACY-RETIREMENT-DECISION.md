# CVIS legacy retirement decision — 2026-10-14

User explicitly confirmed: legacy OpenChamber/OpenCode CVIS automation was intentionally removed/disabled because it was difficult to control. Rebuild CVIS on the current OpenCode fork.

This decision supersedes earlier plan/status guidance to retain or restore legacy hourly/manager automation during migration. Previously verified plan/evidence artifacts remain immutable historical snapshots; this is the current amendment.

## Operational boundary

- Do not restore legacy crontab entries, OpenChamber-managed OpenCode, old managers, queue workers, auto-upgraders or cleanup loops.
- Fork OpenCode is the new control plane. Project Goals/Tasks/Runs/Checks/Events remain its execution/accounting model.
- Existing LLM backends and LiteLLM may be reused as explicitly approved data-plane services. Their availability does not authorize restarting old CVIS automation.
- `/home/chad/llm-ops` currently holds CVISllm's bootstrap files and native project identity. This location does not make its legacy hourly.py the owner of the new project.
- Read old configs/scripts/history for requirements and reusable code. Port selected functionality into reviewed fork-owned jobs/adapters; do not reactivate the old system wholesale.
- Do not delete or move old data/services merely on this clarification; destructive cleanup still needs specific scope and approval.

## Revised next steps

1. P1: stable managed project registry, resource ownership and safe native identity migration.
2. Bootstrap CVIS, CVIScode, CVISmem and CVISllm against that registry.
3. Implement the minimal fork-native durable scheduler: due slots, deduplication, lease/retry, per-project budget, execution receipts and visible status.
4. First CVISllm scheduled job: hourly backend/alias chat + tool health probes. Enable only once scheduler restart/recovery/no-double-execution tests pass.
5. Port model onboarding/routing/credential lifecycle in small tasks. Report gaps explicitly while legacy automation remains off.

Current status: legacy hourly scheduling is intentionally off; a replacement fork-native hourly schedule is not yet implemented or active. Previous model probes are point-in-time evidence, not proof of continuous health monitoring.
