# Đề Xuất Động Cơ Bộ Nhớ (Memory Engine Proposal) cho OpenCode (TypeScript Fork)

Tài liệu này đề xuất một **Động Cơ Bộ Nhớ (Memory Engine)** chuyên biệt được thiết kế riêng cho kiến trúc của **OpenCode** (vận hành trên TypeScript, Effect v4, Drizzle ORM và SQLite), kết hợp các mô hình bộ nhớ ba tầng (three-layer memory), tự động lưu trữ/nén (auto-archive/compaction) lấy cảm hứng từ tài liệu tham khảo (`memory.py`, `archive.py`), cũng như khái niệm mạng lưới bộ nhớ (memory lattice) và xác thực miễn dịch 5 lớp (`muex-ref`).

---

## 1. Kiến Trúc 3 Tầng Bộ Nhớ (Three-Layer Memory Architecture)

Động cơ bộ nhớ được phân chia thành 3 tầng rõ rệt nhằm cân bằng giữa tốc độ, ngữ cảnh ngắn hạn và độ bền vững dài hạn:

1. **Tầng Nóng (Hot Layer - Working Context / Session V2 Inbox):**
   - **Mục đích:** Lưu trữ các lượt trò chuyện (turns), tool calls, và input đang xử lý trong phiên làm việc hiện tại.
   - **Cơ chế:** Dựa trên bảng `session_message`, `session_input` và bộ nhớ tạm `InstanceState`.
   - **Đặc tính:** Tốc độ cao, dung lượng giới hạn bởi cửa sổ ngữ cảnh (context window) của mô hình.

2. **Tầng Ấm (Warm Layer - Semantic Memory & Structured Files / `MEMORY.md` & SQLite Vectors):**
   - **Mục đích:** Lưu trữ các tệp chỉ dẫn dự án (`AGENTS.md`, `CLAUDE.md`), cấu trúc bộ nhớ ngữ nghĩa của dự án, và các tóm tắt phiên làm việc trước đó.
   - **Cơ chế:** Kết hợp tệp Markdown tại thư mục làm việc và bảng SQLite chuyên dụng cho vector/fact.
   - **Đặc tính:** Truy xuất nhanh qua từ khóa hoặc semantic search, tự động co giãn khi tệp phình to.

3. **Tầng Lạnh (Cold Layer - Autonomous Archive & Black Box):**
   - **Mục đích:** Lưu trữ lịch sử toàn bộ phiên làm việc, snapshot mã nguồn, diff và nhật ký hệ thống nhằm phục vụ kiểm tra hoặc khôi phục dài hạn.
   - **Cơ chế:** Lưu trữ dạng tệp nén/JSONL tại kho lưu trữ ngoài (`workspace/archive/YYYY-MM-DD/`) tương tự `archive.py`.
   - **Đặc tính:** Không tải toàn bộ vào RAM, chỉ nạp khi có yêu cầu truy vấn ngược (audit/replay).

---

## 2. Lưu Trữ: Bảng SQLite Mới vs Tệp (Files)

Để tận dụng tối đa cơ sở hạ tầng SQLite sẵn có của OpenCode (`packages/core/src/session/sql.ts`) mà vẫn giữ tính linh hoạt của tệp Markdown cho lập trình viên, hệ thống áp dụng **mô hình lưu trữ hỗn hợp (Hybrid Storage)**:

### 2.1. Các Bảng SQLite Mới (Drizzle Schema)
Bổ sung các bảng sau vào `packages/core/src/session/sql.ts`:

```ts
export const MemoryFactTable = sqliteTable(
  "memory_fact",
  {
    id: text().primaryKey(),
    session_id: text().references(() => SessionTable.id, { onDelete: "cascade" }),
    fact: text().notNull(),
    keywords: text({ mode: "json" }).notNull().$type<string[]>(),
    persons: text({ mode: "json" }).notNull().$type<string[]>(),
    timestamp: text(),
    topic: text().notNull(),
    vector: text({ mode: "json" }).notNull().$type<number[]>(), // Hoặc liên kết FTS5/LanceDB nếu tích hợp
    ...Timestamps,
  },
  (table) => [
    index("memory_fact_session_idx").on(table.session_id),
    index("memory_fact_topic_idx").on(table.topic),
  ],
)

export const MemoryArchiveTable = sqliteTable(
  "memory_archive",
  {
    id: text().primaryKey(),
    date: text().notNull(),
    session_id: text(),
    payload: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    index("memory_archive_date_idx").on(table.date),
  ],
)
```

### 2.2. Phân định Lưu trữ: Khi nào dùng Bảng SQLite vs Tệp?
- **Dùng Bảng SQLite (`memory_fact`, `memory_archive`):** Cho dữ liệu cần tìm kiếm vector/semantic, indexing nhanh theo từ khóa, dữ liệu cấu trúc cần ràng buộc khóa ngoại với `session`.
- **Dùng Tệp Markdown (`MEMORY.md`, `guides/*.md`):** Cho tài liệu hướng dẫn tác vụ (`AGENTS.md`), ghi chú dự án mà con người (lập trình viên) trực tiếp đọc/sửa bằng tay và kiểm soát qua Git.

---

## 3. Các Khoảnh Khắc Vòng Đời (Lifecycle Moments)

Hệ thống can thiệp vào 4 khoảnh khắc then chốt trong chu kỳ xử lý của OpenCode:

1. **Capture (Khoảnh khắc Thu thập):**
   - Kích hoạt khi phiên làm việc kết thúc hoặc đạt ngưỡng token (`SessionCompaction`).
   - Trích xuất các sự kiện, quyết định cốt lõi từ hội thoại bằng LLM (hoặc thuật toán trích xuất cấu trúc).

2. **Compress (Khoảnh khắc Nén):**
   - Khi tệp `MEMORY.md` hoặc ngữ cảnh phiên vượt ngưỡng (ví dụ: > 3,000 ký tự cho memory hoặc > 8,000 ký tự cho guides), hệ thống tự động cắt và chuyển các phần lớn sang tệp độc lập, để lại con trỏ (`-> see guides/...`).
   - Các đoạn hội thoại cũ được nén thành các `fact` cô đọng kèm vector embedding.

3. **Retrieve (Khoảnh khắc Truy xuất):**
   - Khi người dùng gửi một prompt mới (`SessionV2.prompt`), hệ thống tính vector embedding của prompt, thực hiện tìm kiếm tương đồng trên bảng `memory_fact`, kết hợp với `Instruction.resolve` để nạp các tệp ngữ cảnh (`AGENTS.md`) liên quan.

4. **Inject (Khoảnh khắc Bơm Ngữ Cảnh):**
   - Bơm các ký ức liên quan (`Related memories`) và tài liệu hướng dẫn vào hệ thống prompt hệ thống (`system prompt`) ngay trước khi gọi LLM turn (`llm.stream`).

---

## 4. Khử Trùng Lặp (Dedup) & Giới Hạn Ngân Sách (Budget Caps)

- **Khử trùng lặp (Dedup & Merge):**
  - Khi nạp một `fact` mới, hệ thống tính độ tương đồng cosin (`cosine similarity`) với các facts hiện có.
  - Nếu độ tương đồng $\ge 0.85$, gọi mô hình phân tích mối quan hệ: **SKIP** (bỏ qua nếu trùng lặp), **UPDATE** (cập nhật thông tin mới thay thế cũ), hoặc **MERGE** (gộp thành một sự kiện hoàn chỉnh hơn).
- **Giới hạn ngân sách (Budget Caps):**
  - **Token Budget:** Giới hạn tổng số token bơm từ bộ nhớ vào system prompt không vượt quá 1,500 tokens (cấu hình qua `compaction.preserve_recent_tokens`).
  - **File Size Caps:** `MEMORY.md` tự động nén khi vượt 3,000 ký tự; tệp hướng dẫn trong `guides/` tự động phân tách khi vượt 8,000 ký tự.

---

## 5. Cổng Xác Thực Miễn Dịch 5 Lớp (5-Layer Immune Validation Gates)

Lấy cảm hứng từ mô hình miễn dịch 5 lớp (`muex-ref`), mọi thay đổi hoặc cập nhật bộ nhớ dài hạn/mã nguồn đều phải đi qua 5 cổng kiểm tra khắt khe:

1. **Lớp 1 - Cú pháp & Kiểu dữ liệu (Typecheck):**
   - Chạy `bun typecheck` tại thư mục package để đảm bảo không phát sinh lỗi TypeScript.
2. **Lớp 2 - Kiểm thử tự động (Automated Tests):**
   - Chạy bộ test nội bộ (ví dụ: `bun test`) để xác minh tính đúng đắn của logic.
3. **Lớp 3 - Xác thực cấu trúc bộ nhớ (Memory Schema Validation):**
   - Kiểm tra định dạng JSON, tính hợp lệ của các trường `fact`, `keywords`, `timestamp` theo Effect Schema.
4. **Lớp 4 - Kiểm tra tính nhất quán (Consistency Check):**
   - Kiểm tra xem facts mới có mâu thuẫn trực tiếp với các quy tắc cốt lõi trong `AGENTS.md` hay không.
5. **Lớp 5 - Cơ chế Hoàn tác & Phục hồi (Rollback & Revert):**
   - Nếu bất kỳ lớp nào từ 1 đến 4 thất bại, hệ thống tự động khôi phục trạng thái tệp/cơ sở dữ liệu trước đó (sử dụng cơ chế `Revert` sẵn có của OpenCode).

---

## 6. Kế Hoạch Theo Pha & Đường Dẫn Tệp Cụ Thể (Phased Plan with Concrete File Paths)

Được chia thành 3 pha triển khai chi tiết:

### Pha 1: Nền tảng Lưu trữ & Schema (Storage & Schema Layer)
- **Tệp cần tạo/sửa:**
  - `packages/core/src/session/sql.ts`: Thêm định nghĩa Drizzle cho `MemoryFactTable` và `MemoryArchiveTable`.
  - `packages/opencode/src/memory/schema.ts`: Định nghĩa Effect Schema cho Memory Fact và Compression payload.

### Pha 2: Động cơ Nén & Truy xuất (Compression & Retrieval Engine)
- **Tệp cần tạo/sửa:**
  - `packages/opencode/src/memory/engine.ts`: Hiện thực hóa hàm `compress_async`, `retrieve`, `dedup`, và tích hợp Vector embedding.
  - `packages/opencode/src/session/compaction.ts`: Mở rộng logic `SessionCompaction` để gọi động cơ bộ nhớ khi tràn bộ đệm hoặc kết thúc phiên.

### Pha 3: Cổng Xác Thực & Tích Hợp Hệ Thống (Immune Validation & Integration)
- **Tệp cần tạo/sửa:**
  - `packages/opencode/src/memory/validation.ts`: Xây dựng 5 lớp cổng xác thực (typecheck, test, schema, consistency, rollback).
  - `packages/opencode/src/index.ts` (hoặc bootstrap service): Khởi tạo dịch vụ Memory Engine cùng với vòng đời ứng dụng.
