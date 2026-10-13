# CVIS upgrade addendum: P0 observations and P0.1 bootstrap gate

Ngày: 2026-10-13. Addendum này bổ sung findings từ execution thật; không thay đổi hồi tố acceptance của task P0.

## 1. Giao việc đã thực hiện

- Runtime: fork `0.0.0-cvis/v1-202610130954`, production DB fork, V1 HTTP API loopback 14096.
- Native repository project: `dc6b72fa40badc90ca0789a2c936aeee321998d9`, worktree `/home/chad/opencode-fork`.
- Manager: `ses_eca7f2b20ffeMx5bdqzQNn12D6`.
- P0 goal: `goal_92c44084-346a-44e3-9fd4-32e7eaecc455`.
- Task: `task_b511a83b-52fb-42db-9bc1-9a89f931561d`.
- Manager thực sự gọi tools tạo/queue task. Worker thực sự read/write artifact `CVIS-UPGRADE-PREFLIGHT.md`; không phải observer viết thay.
- Phạm vi write đúng một artifact; read source paths được khai báo. Không có source/config/cron/deploy/commit change do P0 worker.

## 2. Kết quả và can thiệp

### Attempt 1 / revision 1

- Run `run_ca095951-a889-4ecc-8526-9004e3d9dc95`: worker viết preflight nhưng source trace chỉ chứng minh đọc plan và hai project modules.
- Observer không chấp nhận các tuyên bố broad source validation. Artifact nhầm risk cascade-delete thành orphan/missing-cascade, thiếu P1 patch sequence đủ cụ thể và thêm multi-node load requirement ngoài target ban đầu.
- Review run `run_31791134-92e3-48e0-a0a7-f1e5de508064`: verifier đọc artifact và gọi verification với review job ID thay vì target task ID; còn dùng check ID `verification` không có trong acceptance.
- Backend từ chối cả hai calls. Không có PASS receipts được ghi. Provider/execution sau đó timeout ở giới hạn 3 phút.
- Observer đưa trace feedback cho manager, không viết verdict hoặc sửa artifact thay verifier/worker.

### Revision 2 / attempt 2

- Manager dùng revise/requeue cho task cũ; review cũ bị supersede/cancel theo lifecycle, giữ lại history.
- Observer archive đúng hai idle sessions của P0 để tránh mang theo context/error history; không xóa dữ liệu. Runtime tạo worker/verifier sessions mới khi pump tiếp.
- Run `run_8cdcba5f-4ecc-4903-b352-79eda8757e66`: worker đọc thêm recall và schemas, sửa artifact. Recorded usage: 251121 tokens.
- Review mới `task_13a582c6-1c44-4db5-b12f-e0db7ae3d599` được tạo nhưng chưa chạy: new claim bị chặn bởi goal budget.
- Reported goal spend 699376 / cap 650000. Đây là usage counter của runtime, không phải số tiền thanh toán.
- Observer pause goal qua API. Runtime pause implementation task, cancel its active run và release worker; artifact/checkpoint/history vẫn còn. Không có active session runner khi kiểm tra.
- Trạng thái cuối: goal paused, implementation task paused revision 2, pending review queued nhưng goal gate chặn execution, progress 0%, checks rỗng.

## 3. Findings cần giải quyết ở P0.1

### F1 — Review identity và lỗi có thể tự sửa

- Phân biệt rõ `reviewJobID`, `targetTaskID`, `targetRevision`, `checkIDs` trong system context và typed tool contract.
- Review-bound verifier nên có server-derived target/checklist; input sai vẫn bị từ chối nhưng error phải chứa valid target/checkIDs và lý do, không chỉ tên `CvisInvalidTransition`.
- Verify prompt không chỉ dẫn chung chung “run tests” khi role không có executor; tool vocabulary phải thống nhất.
- Tests: multiple checklist IDs, wrong review ID, unknown check ID, stale revision, self-verification, readonly scope và genuine FAIL.

### F2 — Token accounting trên mọi exit path

- Failed review run ghi `tokens_used=0` trong khi verifier Session API ghi input 80925/output 434.
- Accounting cần finalize trên success/fail/timeout/cancel, idempotent theo run/message receipt, giữ được partial usage trước failure.
- Tổng spend phải bao gồm manager và worker execution cùng một định nghĩa, không mất failed consumption hoặc double-count retry.
- Tests: provider partial output rồi lỗi; timeout sau tool calls; cancel; restart before settlement; exact retry; input/output/reasoning/cache counters.

### F3 — Budget admission vs mid-run consumption

- New review claim được chặn đúng khi recorded spend vượt cap; nhưng một running implementation đã làm recorded goal usage vượt 650000 trước settlement.
- Cần budget reservation/admission, runtime usage refresh và output limits; phân biệt rõ hard limits được bảo đảm với conservative estimates.
- Per-task `scope.max_tokens=250000` được yêu cầu trong manager request nhưng task persisted không có field đó. Cần xác định model omission/schema stripping và fail admission nếu required budget không được giữ.
- Không tự tăng budget để che failure. Operator phải có budget-update command được kiểm soát, reason/event và approval policy.

### F4 — Context efficiency và source grounding

- Source read scopes hoạt động: root glob ngoài scope bị chặn; không nên mở rộng scope chỉ để agent glob mặc định.
- Dùng targeted grep/read trong directories/files được cấp; role context ngắn, tránh duplicate plan/task/checkpoint và các transcripts dài của nhiệm vụ cũ.
- Reuse cần explicit context-reset/compact/rotation policy; failed tool traces không nên trở thành instructions của lần review mới.
- Report phải phân biệt source đã đọc thật, baseline do observer cung cấp, proposed paths và tests chưa chạy.
- Tests/eval: fixed preflight corpus so sánh source-grounding accuracy, number of tool errors, input tokens, elapsed time và correct acceptance receipts.

## 4. P0.1 đề xuất

Nhiệm vụ: sửa bootstrap orchestration failures F1-F4 bằng các task nhỏ, scoped source và regression tests. P0.1 là prerequisite để tăng mức tự động giao P1-P10, không là blanket upgrade authorization.

Patch sequence đề xuất:

1. Audit typed create/revise/tool contracts và error serialization; preserve required fields hoặc reject admission.
2. Server-derived review context và actionable errors; explicit multi-check prompt.
3. Usage finalization trên mọi exit và durable ledger reconciliation.
4. Budget reservation/update contracts, guard thresholds và provider output limits.
5. Compact context/reuse strategy và scoped search guidance.
6. Unit + actual HTTP/provider fault tests; rerun P0 preflight with smaller bounded context and independent verifier.

Gate trước P1: a real manager/worker/verifier cycle with at least four acceptance checks, one failure/revision, budget-stop behavior and honest partial usage. No fabricated PASS; source/resource policy unchanged unless specifically approved for the fix task.

P0.1 có thể được duyệt từ P0 observations mà không đòi P0 đã Done, vì các fixes này giúp hoàn tất P0. Sau P0.1 và P0 verification, tiếp tục P1-P10 theo master plan.

## 5. Artifacts và giới hạn bằng chứng

- Master plan: `CVIS-UPGRADE-PLAN.md`.
- Worker artifact: `CVIS-UPGRADE-PREFLIGHT.md`, revision 2, SHA256 `7ed0356a044125d272798d14f83511b2813412b65d373ecf8079654734d4ccb0`.
- Observer state/report: `/home/chad/opencode-fork/CVIS-UPGRADE-OBSERVATION.json`; operational checkpoint `/tmp/cvis-upgrade-observer-state.json`.
- Protected source hashes trước/sau không đổi. P0 không chạy code tests; chỉ author/review preflight workflow.
- Artifact revision 2 là draft, chưa đạt independent verification; không dùng như approved architecture hay proof of implementation.
- Hệ thống đã chứng minh nhận việc, scope enforcement, revise/history, fresh worker creation, budget admission và pause/release. Chưa chứng minh có thể unattended hoàn tất nâng cấp toàn bộ.
