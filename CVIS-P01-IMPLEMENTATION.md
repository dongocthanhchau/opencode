# P0.1 implementation and delegated execution report

## Update 2026-10-14 — formal QA completed

Cline2API `cline-free/mimo-v2.6-flash` đã thực hiện independent review cho cả sáu component A/B/C0/C1/C2/D. Goal `goal_0e2ea0a7-a72c-4f13-95a4-9dc95ea56a17` hiện completed, 100%; backend gates kiểm tra actual artifact receipts. Phần “Formal component QA còn chờ” bên dưới là checkpoint lịch sử, đã được giải quyết. Token usage tổng cộng 12,916,632 theo counters runtime (gồm các lượt failed/cache); cap operator cuối 14,000,000. Không diễn giải counters này thành chi phí tiền.

Provider selection phân biệt backend models với catalog model đã nạp vào OpenCode: `cline-free/mimo-v2.6-flash` dùng được ngay; một số alias khác probe được qua API nhưng chưa đăng ký trong runtime nên không gọi được từ session. Không nới permission hay sửa assertions để đóng goal.

Runtime cuối: `0.0.0-cvis/v1-202610131720`, fork binary `/home/chad/.opencode/bin/opencode-cvis`, loopback 14096. P1-P10 chưa triển khai.

## Kết quả đã triển khai

- Shared task scope schema giữ max_tokens/commands/review references, validate budget integer/finite.
- Verify dùng target từ assigned review scope khi không truyền taskID; sai target/checkID trả lỗi actionable; không bỏ qua independent verifier gates.
- Goal/task budget update là operator-only HTTP command, CAS old cap, reason và event; không mở trong model tool catalog.
- Usage finalization trên failure/timeout/cancel và success; reconcile từ native assistant receipts theo run/time window, giữ cache counters và historical failures.
- Live usage guards trước title/overflow/compaction decision; per-turn reservation trong immediate transaction, output cap thực sự gửi vào cả hai provider paths.
- Assignment prompt ngắn, authoritative context vẫn giữ full task/goal/scope; fresh worker thay transcript reuse không phù hợp.
- Delivery rỗng thành failed, không tự chuyển thành verified completion.
- Verifier có thể kết thúc khi đủ current signed artifact receipts, không phải chờ thêm model prose; evidence roots gồm read/write artifacts đúng scope.
- Goal progress/completion bỏ superseded review history đúng correlation, vẫn giữ ordinary cancelled required work và cross-project invalid reviews.

## Worker đã làm

Các task nằm trong goal `goal_0e2ea0a7-a72c-4f13-95a4-9dc95ea56a17`:

- A-contracts: scope schema, review identity/error routing và operator interface.
- B-usage-context: usage helper, finalizer, deadline config, context/worker selection.
- C0-budget-operation: goal budget CAS service và real service tests.
- D-operator-route: authenticated HTTP dispatch cho operator budget commands.
- C1-live-budget: attempted integration; whole-module rewrites bị reject và rollback về exact pre-task snapshots.
- C2-budget-helper: isolated helper prototype; operator sửa các lỗi DB API, accounting/reservation/scoping và thay các test không đạt bằng real isolated DB tests.

Task IDs, runs, scopes, revisions và observations nằm trong `CVIS-P01-OBSERVATION.json`; không giả mạo thao tác agent.

## Can thiệp tay thực sự

- Chạy typecheck/tests/build vì managed roles hiện không có shell/test executor.
- Sửa bootstrap API Effect v4 và required template inputs khi agent bị quota/deadline chặn.
- Restore các module bị C1 rewrite làm mất exported APIs; không dùng git checkout HEAD nên giữ toàn bộ các sửa user/operator trước đó.
- Integrate vào service/policy/prompt/llm bằng patch nhỏ, giữ permission/cancellation/legacy behavior; viết kiểm tra budget thực sự thay cho mirrored assertions.
- Chỉnh scopes thành read-only khi làm final delivery checkpoint qua normal service API; không sửa verdict trực tiếp trong DB.
- Budget tăng do operator explicit decision qua CAS/event, giữ nguyên consumption; không reset token history hay để model tự tăng cap.
- Abort đúng hai own session preparation bị provider treo; không restart các provider/legacy services.

## Verification

| Suite | Kết quả |
| --- | --- |
| Unit/runtime cuối | 86 pass, 0 fail |
| HTTP/provider bootstrap | 15 pass, 0 fail |
| HTTP pause/restart/crash/archive | 27 pass, 0 fail |
| Security regression | 20 pass, 0 fail |
| Memory integrity/concurrent capture | 33 pass, 0 fail |
| Actual Claude manager/worker/verifier + restart + compaction pilot | 27 pass, 0 fail |
| Core/opencode typecheck và build | pass |

Nguồn evidence: `/tmp/cvis-p01-http-d9us1aex`, `/tmp/cvis-http-faults-xiuo590t`, `/tmp/cvis-orch-review-xx12h8mw`, `/tmp/cvis-management-audit-lk1tb47w`, `/tmp/cvis-live-pilot-3_dyf2r8`.

HTTP checks chứng minh partial failed run usage 110 tokens vẫn được giữ, output cap có trong real request, exhausted usage chặn provider call tiếp theo, invalid/stale budget update và wrong review target/check IDs bị từ chối.

Input reservations là estimates, không là cam kết exact provider billing. Token/cache counters không đồng nghĩa số tiền thanh toán.

## P0 đã đạt gate thật

- Goal `goal_92c44084-346a-44e3-9fd4-32e7eaecc455`: completed, 100%.
- Target `task_b511a83b-52fb-42db-9bc1-9a89f931561d`: done, revision 4, attempt 4.
- Independent reviewer `ses_ec9df106dffetKek2Wb1lKtr0J`; run `run_e80e5b26-9fa8-475a-9b99-0fa950742232`.
- Checks baseline/architecture/rollout/honesty: PASS, current revision/run, actual file SHA256 receipts.
- Worker preflight SHA256 `08ed875f305a98ef6088db2783f7ecdbf3967a8a48f2114aa8d53725098645eb`.

Không sửa các evidence snapshots đã được reviewer hash. `packages/opencode/test/orchestration/p01-evidence.json` là snapshot của lượt verification, không overwrite để làm checksum cũ vô hiệu.

## Formal component QA còn chờ

Code P0.1 đã operator-test và deploy; goal P0.1 chưa được đóng bằng independent evidence cho toàn bộ task components.

- First component review batch có actual reads và một số receipts nhưng các model turns tiếp theo timeout 9 phút; chưa ghi đủ verdict/settlement cho mọi component.
- Retry Claude preparation treo trước khi có READY; Gemini retry có READY nhưng delivery rỗng, backend đánh dấu failed.
- P0 riêng đã hoàn thành. Không dùng P0 PASS để giả là mọi implementation task P0.1 đã Done.
- Goal P0.1 đã pause để giữ checkpoint và không tự chạy thêm các lượt provider đang lỗi. Cần resume component QA khi provider ổn, ưu tiên từng task/ít concurrency và source reads nhỏ. Nếu đủ receipts, runtime có early settlement mới.
- Source changes chưa commit; Notion chưa publish vì connector thiếu NOTION_TOKEN.

Sau formal QA, bước tiếp theo là P1 stable managed project registry/identity migration theo master plan, không tự chuyển legacy cron/Docker/package configuration ngoài approval.
