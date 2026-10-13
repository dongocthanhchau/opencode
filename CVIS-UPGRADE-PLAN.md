# CVIS upgrade plan: project-managed personal assistant and isolated assistant applications

Ngày lập: 2026-10-13. Trạng thái: plan và P0 preflight; các phase triển khai cần đi qua acceptance và policy bên dưới.

## 1. Yêu cầu đã chốt

- Một danh tính trợ lý cá nhân CVIS thống nhất trên Telegram, Zalo, web, Xiaozhi và các kênh tương lai.
- Ba project trụ cột: CVIS giao tiếp/điều phối; CVIScode quản trị phần mềm, agents/tools/skills, cronjobs, audit và cải thiện; CVISmem quản trị memory/knowledge.
- Project kênh phụ trách transport, conversations, attachments, giọng nói và delivery; không tạo bộ goals/reminders cá nhân độc lập.
- Assistant App chuyên biệt là project có mission, knowledge, context, tools/MCP, capabilities, budgets và runtime độc lập. Một app có thể phục vụ nhiều kênh/thiết bị.
- Các project công việc được tạo hoặc tái sử dụng theo nhiệm vụ và vòng đời; không tạo project mới cho mọi câu hỏi/task.
- Xiaozhi cá nhân chuyển nhận yêu cầu/kết quả/reminders với CVIS. Xiaozhi chuyên biệt kết nối Assistant App có context/knowledge/quyền riêng.
- Hệ thống hiện tại nhận task và thực hiện trong phạm vi được giao; người quan sát kiểm tra evidence và chỉ can thiệp khi có blocker cụ thể.

## 2. Baseline đã kiểm chứng

- Fork authoritative: `/home/chad/opencode-fork`, branch `cvis/v1`; runtime `/home/chad/.opencode/bin/opencode-cvis`, loopback port 14096.
- Version khi bắt đầu: `0.0.0-cvis/v1-202610130954`; DB runtime `/home/chad/.local/share/opencode/opencode-cvis-v1.db`.
- V1 session API `/session`; orchestration `/cvis/projects/:id`, `/cvis/command`, `/cvis/bind`, `/cvis/pump`, task execution, recover và SSE.
- Đã có goals/tasks/runs/checks/bindings/messages/events, runtime permission enforcement, cancellation/lease recovery, revision/attempt gates và artifact SHA256 receipts.
- Verifier hiện review artifact thật; chưa có isolated command executor để chứng minh test execution exit code. Managed sessions bị chặn unrestricted shell/MCP.
- Memory capture/recall đã sửa integrity: latest summary, tombstones, dedup, conservative relations, DB-first atomic vault publication và concurrent writes.
- Recall hiện FTS-gated rồi embedding rerank, graph một bước; chưa phải independent lexical + vector candidate retrieval.
- Session ID trên memory hiện là provenance; chưa có đầy đủ session-private/project/user-shared/system-shared ACL.
- Native Project ID liên quan Git remote/cache/root commit; non-Git có thể fallback `global`. Native project không đồng nghĩa managed project.
- Migration native Project ID phải được audit: đổi ID hiện chưa remap toàn bộ CVIS/memory references trước khi xóa native project cũ.
- Legacy `cvis-ops` vẫn dùng `opencode.db` và `/home/chad/vault/cvis-queue`; worker cũ có thể đánh dấu Done bằng chuỗi `RESULT: done`.
- Các sửa memory/session lần trước vẫn chưa commit trong repo. P0 phải giữ nguyên các thay đổi này.

## 3. Kiến trúc đích và ownership

### 3.1 Project trụ cột

| Project | Ownership | Không tự thay thế trách nhiệm |
| --- | --- | --- |
| CVIS | Inbox, intent, project registry, routing, user commitments, reminders, cross-project coordination, reporting | Không tự đặt verdict cho delivery của worker |
| CVIScode | Software/runtime health, tools/MCP/skills/agent templates, schedule administration, execution audit, success/failure patterns, code improvement | Không tự sửa progress hoặc tăng quyền chỉ vì model kết luận |
| CVISmem | Ingest/capture, scoped retrieval, provenance, publish/subscription, tombstones, memory jobs, quality evaluation | Không tự biến mọi transcript thành shared knowledge |

Project công việc/Assistant App sở hữu mission, resource, corpus và acceptance chuyên môn. CVIScode sửa resource theo ownership hoặc task được owner giao. Cross-project write được chuyển thành task cho owner; không cấp wildcard write để vượt ranh giới.

### 3.2 Managed Project contract

Đề xuất registry có ID ổn định độc lập Git và slug duy nhất. Native repository ID là liên kết placement/source, không là identity quản trị.

Contract cần có:

- `id`, `slug`, `type`: core/channel/assistant-app/work/initiative; `owner`, mission và non-goals.
- Resources: repository/workspace/config/service/corpus/device/channel được quản trị; canonical read/write roots; owner của mỗi resource.
- Status: planning/ready/active/paused/completed/archived; version của manifest.
- Manager binding, worker role profiles, permission ceiling và allowed actions.
- Allowed models, token/cost/time/concurrency/retry budgets; định nghĩa rõ cách tính input/output/reasoning/cache usage.
- Memory profile, shared subscriptions, retention, promotion policy và knowledge version.
- Schedules, dependencies, acceptance/evaluation suites, report/notification destinations.
- Runtime/deployment references cho Assistant App; secret references thay vì secret plaintext trong prompt.

Migration phải gắn managed ownership cho goals/tasks/bindings/events/messages/memory/session context. Không chỉ thêm metadata rồi vẫn lọc theo native Git ID. Mapping mơ hồ chuyển vào review, không tự gom vào `global`.

### 3.3 Init project lifecycle

1. Clarify mission, owner, loại project và kết quả mong muốn.
2. Register stable identity và resource ownership.
3. Apply policy/budget/memory/schedule templates phù hợp.
4. Bind manager; tạo worker/verifier theo nhu cầu, không giữ model turn chạy thường trực.
5. Seed requirements/approved decisions và goal đầu tiên có acceptance.
6. Run init doctor: identity, storage, scope, credential references, model/tools, scheduler, memory isolation.
7. Run một dispatch/verify smoke task và restart/reconnect test.
8. Chuyển ready/active khi đạt gate; init lại không duplicate manager/goal/schedule.

## 4. Task, scheduler và evidence

- Một operational DB fork là nguồn chuẩn runtime. Notion/Telegram/web là interfaces và adapters; edit đi qua commands/revision/outbox, không có hai nơi độc lập quyết định Done.
- Mọi operation/job có owner project, trigger, correlation ID, actor, policy version, budget, lease, attempt và outcome.
- Probe nhẹ có JobRun/metrics; chỉ tạo task/đánh thức manager khi cần hành động hoặc suy luận. Tránh tạo LLM task cho mỗi heartbeat.
- Schedule riêng từng project, một scheduler engine: timezone, due slot, catch-up policy, dedup key, atomic claim, heartbeat, cancellation, bounded retry/backoff và circuit breaker.
- Event-driven routing/result callbacks đánh thức manager theo budget; tránh wake loop gọi model khi không có thay đổi.
- Task cần scope, acceptance, dependencies, revision và active run. Worker submit không đồng nghĩa Done.
- Checklist progress tính từ evidence đúng revision/attempt; estimate/at-risk/time-spent là chỉ số khác, không cộng giả thành completion.
- Verifier độc lập và có structured artifact/test receipts. Command receipts gồm executor identity, allowed command, working directory, artifact/commit SHA, exit code, logs và timestamps.
- Test executor chạy trong environment được cách ly và giới hạn. Không mở arbitrary shell cho model để bù thiếu executor.
- Physical resource arbitration phải chặn overlapping writes cả giữa managed projects có chung repository/resource.
- Code deployment có named action, human approval theo policy hiện hành, health canary và rollback. Task Done, release verified và release deployed là các mốc riêng.

## 5. Memory và knowledge

### 5.1 Năm phạm vi

| Scope | Ví dụ | Visibility |
| --- | --- | --- |
| Session | Transcript, hypothesis, temporary checkpoint | Session/handoff được cấp |
| Channel/device | Transport state, interaction settings, device context | Channel/device app tương ứng |
| Project | Requirements, approved decisions, domain facts/lessons | Project members có capability |
| User-shared | Preferences, agenda, commitments xuyên kênh | Các session/kênh gắn đúng user identity |
| System-shared | Reusable verified patterns/lessons | Project subscriptions được phép |

- `global` native fallback không là system-shared scope.
- Dùng explicit owner/scope/subject/access policy; scope được kiểm tra trước candidate retrieval và graph expansion.
- Phân biệt requirement, decision, observation, hypothesis, lesson; source và trạng thái xác nhận không được suy ra chỉ từ summary text.
- Session -> project -> system promotion là workflow có criteria, provenance và actor. Raw transcript không tự publish.
- Project/knowledge memory đã publish không bị mất khi xóa/archive session nguồn; provenance có thể trỏ archive/immutable source.
- Capture từ compaction, verified delivery, confirmed decisions và knowledge ingest; dùng durable jobs, lease/retry và degraded-status observable.
- Tombstones áp dụng đúng scope trên lexical/vector/graph/recapture/export/import paths. Forget, TTL, archive và supersede là các lifecycle riêng.
- KB ingest: file/text/link/document, source checksum, parser/version, chunking, index version, status và rollback khi update.
- KB chính thức của Assistant App không tự học từ mọi câu hỏi người dùng. Conversation learning mặc định là candidate riêng cho review.

### 5.2 Retrieval

1. Resolve requester/user/project/app/corpus capabilities.
2. Build query từ user turn và task/goal context trong budget.
3. Lấy lexical candidates và vector candidates độc lập; embedding error dùng lexical degraded mode và phát maintenance signal.
4. Fuse/rerank, dedup; thêm graph một bước với cùng ACL.
5. Kiểm tra expired/retired/tombstoned/conflicting/source quality.
6. Allocate context theo scopes và token budget; format nguồn, status và citation.
7. Ghi retrieval trace: matched terms, semantic score, relation, selected/skipped reasons, index/model version và latency.

Eval cần tiếng Việt/English, paraphrase không lexical overlap, mixed projects, private/shared scope, stale/mâu thuẫn/tombstone và long sessions. Đo relevance/coverage, leakage, citation quality, latency và token cost trên holdout; không sửa expected assertions để biến bug thành pass.

## 6. Channels và Assistant Apps

### 6.1 Personal channels

- Telegram/Zalo/web/Xiaozhi-personal chuyển incoming envelope: channel, message ID, conversation, authenticated subject/device, text/media refs, timestamp và reply route.
- Dedup theo source identity/message/delivery ID; không dedup chỉ bằng text vì hai yêu cầu giống nhau có thể là hai việc.
- Một task/correlation identity xuyên kênh; routing uncertainty vào CVIS inbox để clarify, không đoán project rồi chạy.
- Outgoing delivery có destination, deadline, receipt/ack, retry và dedup. Reminder được lưu bền vững, không dựa model nhớ trong chat.
- Cấu hình kênh/persona/context riêng không nhân bản user commitments hoặc shared memory.

### 6.2 Assistant App contract

- App identity/mission/audience, persona/instructions, project-private context và conversation policy.
- Allowed corpora và knowledge versions; RAG answering có citations và xử lý insufficient evidence.
- Workflows/DAG/agent-loop version; tool/MCP allowlist và execution budgets.
- Channels/devices gắn app; authentication/guest capabilities độc lập personal CVIS identity.
- Runtime riêng: container/process/config/filesystem/resource caps/network policy/secret references. Ban đầu đề xuất container trên cServer; Docker/config/package changes cần được duyệt trước khi triển khai.
- Serving agent khác management agent: public conversation API không mở cvis admin/task/scheduler/deploy API cho app users.
- Một app có thể nhiều thiết bị/kênh; device profiles tách context. Chỉ tách project khi nhiệm vụ/knowledge/quyền khác biệt.
- Runtime health, evaluation và deployment version observable, app restart/update độc lập.

Pilot: Telegram hoặc Xiaozhi-personal -> CVIS; một knowledge Assistant App với corpus fixture được ghi rõ là test, read-only capabilities. Chuyển sang corpus thật do user cung cấp ở gate ingest. Tool thực tế/MCP được bổ sung sau khi project capability và executor được chứng minh.

## 7. Self-management và self-improvement

- CVIScode đọc execution metadata/checkpoints/evidence xuyên project theo audit capability; raw/private conversation access theo policy, không tự chuyển knowledge riêng sang project khác.
- Phân loại planning/context/tool/model/permission/implementation/verification/delivery failures, success patterns và recurrence.
- Gom issue theo fingerprint để tránh duplicate fix tasks; giữ case evidence, phiên bản và sample size.
- Tạo improvement task có owner, hypothesis, baseline, acceptance và budget. Worker làm trong worktree/scope; verifier dùng fixed tests/holdout; rollout đo lại kết quả.
- Lesson/template/skill/tool candidate có version, provenance, eval và promotion history. Đếm lessons không đồng nghĩa cải thiện chất lượng.
- Tự điều chỉnh backoff/concurrency/job timing/model trong allowlist theo policy và metrics. Mọi adjustment có reason/event; không tự tăng permission ceiling.
- CVISmem audit capture/retrieval/index consistency và memory jobs; thay thuật toán tạo code task cho đúng owner và đi qua eval.
- CVIS tổng hợp thay đổi, việc cần duyệt, blockers và project progress cho user.

## 8. Legacy migration

1. Inventory cron, producers, legacy queue workers, DB reads, reports, install/deploy/cleanup actions.
2. Map từng operation sang managed project/resource/action; adapter read-only import thử với source IDs và idempotency.
3. Legacy Done không có receipt nhập như historical/unverified metadata, không tự pass new verifier gate.
4. Bridge producers sang new commands; old files là input/archive/mirror trong thời gian chuyển đổi.
5. Shadow mode so sánh routing/state/metrics nhưng chỉ một executor được phép thực thi task.
6. Cutover từng pipeline: CVISmem maintenance trước, CVIScode session audit tiếp theo, rồi cron/worker/deploy.
7. Chỉ thay legacy cron/config/worker khi gate và approval đạt; giữ checkpoints cho rollback. Không xóa old DB/queue trong rollout.
8. Notion/TG reports dùng new snapshot/events. Reconcile mappings/outbox sau restart và khi mạng lỗi.

## 9. Milestones và acceptance

### P0 — Preflight và contract review (giao hệ thống hiện tại trước)

Deliverable: `CVIS-UPGRADE-PREFLIGHT.md` đối chiếu plan này với source thật, chỉ ra dependencies/gaps và đề xuất patch sequence. Chỉ write artifact này. Đọc source scoped, không tự sửa code/config/service hay legacy jobs.

Gate: manager thực sự tạo/queue task; worker thực sự write artifact; independent verifier read artifact và record receipts; observer kiểm tra nội dung/citations. P0 completion không có nghĩa upgrade hoàn tất.

### P1 — Managed project identity, registry và migration

- Stable registry, types/manifest/resource ownership, native repo mapping và project contexts.
- Remap đầy đủ relations khi native ID thay đổi; preserve user/work/task/memory identity.
- Session/task admission yêu cầu managed project đúng capability, không fallback silently sang global.
- Tests: init two projects cùng Git repo, non-Git project, change remote/path, legacy/fresh DB, ambiguous mapping, cross-project deny và data preservation.

### P2 — Project init và core bootstrap

- Idempotent init/doctor, templates, lifecycle và lazy manager/session rotation.
- Bootstrap CVIS/CVIScode/CVISmem với mission/resources/policies/budgets/goals rõ ràng.
- Tests: repeated init, failed init rollback/recovery, archived manager replacement, capability inheritance, restart-safe registry.

### P3 — Durable scheduler, authentic actor context và test executor

- Schedule/JobRun schema, trigger admission/outbox, due-slot dedup, leases/recovery, resource arbitration, bounded retries và manager wake policy.
- Authentic caller/actor context; serving apps không thể chỉ gửi một manager session ID để có admin capability.
- Isolated test executor và structured receipts; preserve existing runtime denies.
- Tests: concurrent schedule claims, missed slots/timezone, crash/restart, budget exhaustion, cancellation/late output, arbitrary command/tool denial, cross-project shared-resource lock.

### P4 — Scoped memory và hybrid retrieval

- Năm scopes, promotion/subscriptions, durable capture/ingest jobs, lifecycle và independent lexical/vector retrieval.
- Tests: session privacy, user identity across channels, app corpus isolation, scope ACL before graph, paraphrase retrieval, tombstones across indexes/recapture, delete session preserves published memory, capture/index crash recovery.
- Gate: heldout retrieval eval và no scope leakage trên test corpus; quality/latency/token baseline được ghi.

### P5 — Legacy adapters và controlled cutover

- Import/dedup/mapping, observation-to-task bridge, historical status handling, shadow comparison và one-executor cutover.
- Chuyển CVISmem maintenance và CVIScode audit vào new runtime trước.
- Tests: import lại không duplicate; old Done không thành verified Done; old/new retry không double execute; resume/reconcile/rollback.

### P6 — Personal CVIS multi-channel và reminders

- Intent routing, inbox/clarify, shared user commitments, Telegram adapter đầu tiên, web/Xiaozhi/Zalo envelopes cùng contract.
- Durable reminders, delivery ack/retry, cross-channel task lookup và preference identity.
- Tests: voice request -> task -> report, same task asked on web/TG, duplicate transport events, failed delivery, reminder survives restart, unlinked identity cannot see personal memory.

### P7 — Isolated knowledge Assistant App pilot

- App manifest/manager vs serving agent separation, runtime isolation, corpus ingest/index versions, RAG citations, channel/device profiles và read-only tool contract.
- Tests: personal/app memory separation, app A/B corpus isolation, denied tools/admin APIs, insufficient knowledge response, app restart independent, KB update/rollback and evaluation.
- Docker/new package/deploy actions chỉ chạy sau approval đúng policy.

### P8 — Project work/initiative lifecycle và cross-project collaboration

- Classify new vs existing project; proposal, task decomposition, handoff/dependencies, ownership routing, progress/reminder/reporting.
- Tests: idea -> initiative -> delivery, task reused vs project created, project archive with knowledge retention, cross-project dependencies and conflict handling.

### P9 — Measured self-improvement loops

- Schedule audit/eval, failure fingerprints, improvement backlog, versioned lessons/templates/skills/tools, bounded auto-adjustments và rollout tracking.
- Tests: repeated failure creates one issue, evidence-backed lesson promotion, failed change remains failed/rolls back, heldout regression blocks promotion, no capability escalation, progress cannot be inflated by agent claim.

### P10 — Operational acceptance và rollout review

- End-to-end personal channels + knowledge app + legacy migration + self-improvement pilot.
- Restart/crash/delivery/model failure drills, cost/load retention checks, full acceptance report và deployment inventory.
- Chỉ kết luận unified self-management khi các core projects, schedules và task runs thực sự tồn tại và chạy trong production; không dùng isolated pilot pass để thay bằng chứng production.

Dependencies: P0 -> P1 -> P2. P3/P4 có thể phát triển theo contracts song song sau P2; P5/P6 cần P3 và phần scope cần thiết của P4; P7 cần P3/P4; P8/P9 cần foundations và pilot đã đạt; P10 sau các phase được chọn cho release.

## 10. Execution và observer protocol

- Mỗi milestone chia task nhỏ với resource scope/acceptance/budget cụ thể. Không giao một prompt “nâng cấp toàn bộ” rồi cho quyền toàn máy.
- Manager nhận plan/context references, tạo/queue tasks; observer gọi dispatch có kiểm soát cho tới khi scheduler mới đủ capability.
- Observer đọc snapshot/events/task detail, actual artifacts/tool traces/check receipts và token usage. Thông báo gắn task/run/revision IDs.
- Can thiệp khi: thiếu API/capability, wrong scope/requirements, lease/budget/time limit, thiếu evidence, verifier fail hoặc phase cần approval.
- Ưu tiên manager clarify/revise/requeue để sửa kế hoạch. Manual patch chỉ khi capability/runtime có bug hoặc blocker đã chứng minh; mọi can thiệp có record.
- Không sửa assertions để hợp thức hóa failure; tests mới phải chứng minh requirement và các negative cases.
- Current approvals không cấp blanket permission để restart services, sửa Docker, cài packages, delete data, commit/push hoặc thay legacy automation.
- P0 được phép chạy ngay theo yêu cầu giao hệ thống hiện tại; P1+ triển khai theo acceptance và các quyết định/approval được ghi sau preflight review.

## 11. Reporting và knowledge preservation

- Plan gốc và preflight là artifacts versioned; cập nhật plan phải ghi lý do/dependency/acceptance thay đổi.
- Runtime state chuẩn ở fork DB; human-facing requirements/tasks/lessons/session logs mirror Notion qua adapter khi connector có credential.
- Notion connector local hiện thiếu NOTION_TOKEN; giữ artifact đầy đủ để publish khi connector hoạt động.
- Báo cáo mỗi phase: actual work, tests/evidence, production vs isolated status, cost/budget, blockers, interventions và next gate.
