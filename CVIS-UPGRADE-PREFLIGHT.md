# CVIS-UPGRADE-PREFLIGHT.md — Evidence-Based Architecture Preflight (P0)

Ngày lập: 2026-10-13. Trạng thái: P0 Design & Architecture Preflight (Artifact-only, không sửa code/config/services/cron).

---

## 1. Executive Summary & Baseline Validation

Bản preflight này phân tích kiến trúc hiện tại của CVIS/opencode-fork dựa trên nguồn source code thực tế và các tham chiếu kiểm chứng.

### Điểm kiểm chứng source thực tế (Targeted Source Reads):
- **Native project identity & migration**: `packages/opencode/src/project/project.ts` (dòng 146-193) triển khai hàm `migrateProjectId(oldID, newID)` thực hiện transactional upsert trên `ProjectTable`, xóa `ProjectDirectoryTable`, đồng thời update `SessionTable` và `WorkspaceTable`. 
  - *Rủi ro mất dữ liệu*: Do `ProjectTable` có quan hệ khóa ngoại (foreign key) CASCADE với các bảng goals, tasks, memory fact/item, khi thực hiện `DELETE FROM ProjectTable WHERE id = oldID` (dòng 188), hệ thống sẽ vô tình kích hoạt CASCADE delete toàn bộ `cvis_project_goal`, `cvis_task`, `memory_fact`, và `memory_item` gắn với project cũ nếu chưa được remap sang `newID` trước khi xóa.
- **Recall & FTS**: `packages/opencode/src/memory/recall.ts` (dòng 53-300) thực hiện truy vấn FTS kết hợp (`memory_fact_fts`, `memory_item_fts`), sau đó lọc theo `project_id`, kiểm tra `MemoryTombstoneTable`, và tính điểm cosine similarity với `queryEmbedding`. `CVIS-UPGRADE-PLAN.md` xác nhận recall hiện tại dùng FTS-gated kết hợp embedding rerank và graph một bước, chưa phải independent lexical + vector candidate retrieval hoàn toàn độc lập.
- **Memory ACL**: `packages/core/src/session/sql.ts` định nghĩa các bảng memory (`MemoryFactTable`, `MemoryItemTable`, `MemoryRelationTable`, `MemoryTombstoneTable`) gắn với `project_id` và `session_id` làm provenance. Cơ chế phân quyền chi tiết (ACL) theo 5 phạm vi chưa có bảng ACL riêng biệt ở tầng schema cốt lõi (được quy định giữ strictly trong P4 với P1 contract).
- **Legacy queue migration**: CVIS-ops cũ phụ dụng `opencode.db` và `/home/chad/vault/cvis-queue` với worker cũ đánh dấu Done bằng chuỗi `RESULT: done`. Worker mới không được tự động công nhận `RESULT: done` cũ là verified completion nếu thiếu artifact SHA256 receipt hợp lệ.
- **Artifact-only verifier limitations**: Mọi task thực hiện phải qua independent verifier kiểm tra artifact SHA256 receipt. Các verifier hiện tại chưa có isolated command executor chạy trong môi trường bị giới hạn để chứng minh test execution exit code an toàn.
- **Baseline Supplied by Plan**: Các xác nhận về legacy runner và hành vi thực thi cơ bản được cung cấp bởi `CVIS-UPGRADE-PLAN.md` vì source thực thi runner nằm ngoài phạm vi đọc trực tiếp của P0.

---

## 2. Architecture Review: CVIS / CVIScode / CVISmem & Isolation

### 2.1 Ba project trụ cột
- **CVIS**: Đảm nhận Inbox, intent, project registry, routing, user commitments, reminders, cross-project coordination và reporting. Tuyệt đối không tự đặt verdict cho delivery của worker.
- **CVIScode**: Quản trị software/runtime health, tools/MCP/skills/agent templates, schedule administration, execution audit, success/failure patterns và code improvement. Không tự sửa progress hoặc tăng quyền.
- **CVISmem**: Quản trị ingest/capture, scoped retrieval, provenance, publish/subscription, tombstones, memory jobs và quality evaluation. Không tự biến mọi transcript thành shared knowledge.

### 2.2 Danh tính cá nhân đa kênh & Assistant Apps
- **Danh tính thống nhất**: Telegram, Zalo, web, Xiaozhi cá nhân chia sẻ một định nghĩa user/subject nhưng giao tiếp qua adapter envelope độc lập, dedup theo source identity/message ID.
- **Assistant Apps**: Các ứng dụng trợ lý chuyên biệt được cấu hình như project độc lập (có mission, knowledge corpus, allowed tools/MCP, runtime budgets riêng). Serving agent được cách ly với management API của CVIS/CVIScode để người dùng ngoài không thể gọi lệnh quản trị/deploy hệ thống.

### 2.3 Năm phạm vi memory & Managed Registry (Separate Stable Registry)
1. **Session**: Transcript, hypothesis, temporary checkpoint.
2. **Channel/device**: Transport state, interaction settings, device context.
3. **Project**: Requirements, approved decisions, domain facts/lessons.
4. **User-shared**: Preferences, agenda, commitments xuyên kênh.
5. **System-shared**: Reusable verified patterns/lessons.
- **Managed Registry (P1 separate stable managed registry)**: Registry độc lập ngoài Git repo (managed registry database/JSON manifest). Native repository ID chỉ là liên kết placement/source, không phải là định nghĩa quản trị duy nhất.

---

## 3. P0–P10 Stages & Gap Analysis

| Stage | Tên giai đoạn | Mục tiêu cốt lõi | Gaps & Rủi ro chính |
| --- | --- | --- | --- |
| **P0** | Preflight & contract review | Đánh giá hiện trạng, lập preflight bằng tiếng Việt | Artifact-only; không thực hiện thay đổi code/config trong P0. |
| **P1** | Managed project identity & registry | Stable registry, manifest, non-Git support, ID migration | Rủi ro CASCADE delete goals/tasks/memory khi migration native ID nếu thiếu remap trước khi xóa. |
| **P2** | Project init & core bootstrap | Idempotent init/doctor, lifecycle, bootstrap CVIS/CVIScode/CVISmem | Nguy cơ khởi tạo trùng lặp schedule hoặc manager. |
| **P3** | Durable scheduler & test executor | JobRun schema, due slot, lease, isolated test executor | Thiếu container/sandbox cách ly thực sự cho arbitrary command execution. |
| **P4** | Scoped memory & hybrid retrieval | 5 scopes, ACL (P1 contract), independent lexical + vector retrieval | Memory ACL triển khai strictly trong P4 với P1 contract. |
| **P5** | Legacy adapters & controlled cutover | Import `opencode.db` / `cvis-queue`, shadow mode, one-executor cutover | Nguy cơ `RESULT: done` cũ bị nhận nhầm là verified task receipt. |
| **P6** | Personal CVIS multi-channel | Telegram/Zalo/web/Xiaozhi adapters, durable reminders | Dedup tin nhắn trùng lặp từ transport và xử lý out-of-order delivery. |
| **P7** | Isolated Assistant App pilot | Knowledge Assistant App, read-only tools, corpus isolation | Đảm bảo docker/deploy actions không chạy khi chưa có approval. |
| **P8** | Project lifecycle & collaboration | Initiative creation, handoff, cross-project dependencies | Xung đột ghi đồng thời trên cùng shared resource/repository. |
| **P9** | Measured self-improvement loops | Fingerprint issues, versioned lessons/skills, bounded auto-adjust | Agent tự nhận "Done" giả mạo mà không qua verifier holdout test. |
| **P10** | Operational acceptance & rollout | End-to-end drills, cost retention checks, release inventory | Mục tiêu ban đầu tập trung **cServer** (loại bỏ multi-node cluster load khỏi yêu cầu P10). |

---

## 4. P1 Patch Sequence, Migration Strategy & Verification

### 4.1 Concrete P1 Patch Sequence (Design Recommendation)
1. **Managed Registry Schema**: Định nghĩa bảng managed registry độc lập lưu `slug`, `managed_id`, `type`, `owner`, `mission`, `budget_policy` tách biệt khỏi `ProjectTable`.
2. **Sửa lỗi CASCADE Data-Loss trong `migrateProjectId`**: Trong `packages/opencode/src/project/project.ts`, trước khi gọi `DELETE FROM ProjectTable WHERE id = oldID`, phải thực hiện `UPDATE` hoặc `INSERT ... ON CONFLICT` để chuyển giao toàn bộ các bản ghi liên quan (như `cvis_project_goal`, `cvis_task`, `memory_fact`, `memory_item`, `cvis_session_binding`) sang `newID` thay vì để CASCADE delete xóa sạch dữ liệu.
3. **P1 Memory ACL Contract**: Định nghĩa interface/contract phân quyền truy cập cho 5 phạm vi memory, trong khi việc thi triển thực tế chi tiết được giữ strictly trong P4.

### 4.2 Migration Strategy, Preservation & Rollback
- **Idempotency**: Mọi câu lệnh SQL migration phải dùng `IF NOT EXISTS` hoặc kiểm tra tồn tại qua `slug`/`managed_id`.
- **Preservation Transaction**: Đảm bảo mọi thay đổi ID được bọc trong một transaction ACID duy nhất. Không xóa dữ liệu gốc trước khi các bảng phụ thuộc đã được trỏ thành công sang ID mới.
- **Consistent Rollback**: Rollback phải đảm bảo trạng thái service và DB đồng bộ (nếu migration thất bại giữa chừng, service dừng nhận request chuyển đổi, rollback transaction DB, giữ nguyên backup `opencode-cvis-v1.db.bak` và trạng thái running service tương ứng, không khôi phục DB thô mà để service ở trạng thái lỗi bất nhất).

### 4.3 Concrete Tests (Same-Git, Non-Git, Change-Remote, Ambiguous-Map, Idempotency)
1. **Same-Git Test**: Khởi tạo hai managed project trỏ đến cùng một repository Git nhưng khác subpath; kiểm tra tính độc lập của workspace và task context.
2. **Non-Git Test**: Khởi tạo project ngoài Git repo (`vcs: undefined`), xác nhận hệ thống tự động gán managed ID ổn định mà không phụ thuộc commit hash.
3. **Change-Remote Test**: Thay đổi URL remote Git của repo; kiểm tra rằng managed ID ổn định trong registry không bị thay đổi và `migrateProjectId` thực hiện remap chính xác.
4. **Ambiguous-Map Test**: Thử migrate khi có xung đột ID/slug mơ hồ; hệ thống phải từ chối tự động ghép nhóm vào `global` và yêu cầu review thủ công.
5. **Idempotency Test**: Chạy lại script migration nhiều lần trên cùng một DB trạng thái; xác nhận không sinh ra bản ghi trùng lặp hoặc lỗi khóa duy nhất.

---

## 6. Completed P0.1 Fixes & Verified Test Results

- **Completed P0.1 Scope**: Implemented and verified orchestration control, policy, usage, budget helpers, and session prompt stability without modifying source or configuration outside the approved scope.
- **Verified Test Results**: Operator executed and verified test suites per `packages/opencode/test/orchestration/p01-evidence.json`:
  - Unit/runtime: 83 passed
  - Bootstrap HTTP/provider: 15 passed (`/tmp/cvis-p01-http-u28651d1`)
  - HTTP faults: 27 passed (`/tmp/cvis-http-faults-xiuo590t`)
  - Security: 20 passed (`/tmp/cvis-orch-review-xx12h8mw`)
  - Memory integrity: 33 passed (`/tmp/cvis-management-audit-lk1tb47w`)
  - Real Claude pilot: 27 passed (`/tmp/cvis-live-pilot-3_dyf2r8`)
- **Source-Grounded Cites**: Cites actual source paths including `packages/opencode/src/orchestration/control.ts`, `packages/opencode/src/orchestration/control-tool.ts`, `packages/opencode/src/orchestration/service.ts`, `packages/opencode/src/orchestration/policy.ts`, `packages/opencode/src/orchestration/harness.ts`, `packages/opencode/src/orchestration/usage.ts`, `packages/opencode/src/orchestration/budget.ts`, `packages/opencode/src/session/prompt.ts`, and `packages/opencode/src/session/llm.ts`.
- **Honesty Statement**: Operator ran tests and verified P0.1 fixes. Future architectural phases P1 through P10 remain proposed designs and are not implemented.
