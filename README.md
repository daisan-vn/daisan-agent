# Daisan Agent (Stage 1)

Engine tạo web bằng **Claude Agent SDK** — chính bộ não của Claude Code. Claude tự tạo/sửa nhiều file, lặp, tự fix lỗi để dựng một website hoàn chỉnh trong workspace riêng. Không qua Cloudflare gateway, không container — chỉ Node + Anthropic key.

## Chạy (3 bước)

1. **Lấy key:** vào https://console.anthropic.com → Settings → API Keys → Create Key. Nạp ít credit (Billing).
2. **Đặt key:** copy `.env.example` thành `.env`, dán key vào `ANTHROPIC_API_KEY=...`.
   ```sh
   copy .env.example .env      # Windows
   ```
3. **Dựng web:**
   ```sh
   npm run gen -- "Landing quán cà phê specialty, có menu và đặt bàn"
   ```

Kết quả nằm trong `workspaces/<thời-gian>/index.html` — **mở file đó bằng trình duyệt** (mở trực tiếp được, không cần server).

## HTTP service (Stage 2) — để daisan.ai gọi

`server.mjs` bọc engine thành web service:
```sh
npm run serve         # http://localhost:8787
```
- `POST /api/generate` body `{ "prompt": "..." }` → Server-Sent Events: `start | text | tool | done | error`. Sự kiện `done` trả `previewUrl` (vd `/preview/<jobId>/index.html`).
- `GET /preview/:jobId/...` → phục vụ site đã sinh (preview trực tiếp).
- `GET /health` → `{ ok, hasKey }`.

### Deploy lên host (build-từ-git, KHÔNG cần Docker local)
Agent SDK cần Node + filesystem + chạy lâu → **không chạy trong Cloudflare Worker**. Host hợp: **Render / Railway / Fly.io** (đều build remote từ git, free tier).
1. Đẩy thư mục `daisan-agent/` lên 1 GitHub repo.
2. Tạo Web Service (Node) trên Render/Railway → trỏ vào repo → start command `npm run serve`.
3. Đặt env var `ANTHROPIC_API_KEY` trên host (KHÔNG commit `.env`).
4. Lấy URL service (vd `https://daisan-agent.onrender.com`) → daisan.ai frontend gọi `POST <url>/api/generate` + nhúng `<url>/preview/<jobId>/` trong iframe sandbox.

## Ghi chú
- Tính tiền theo token Anthropic (mỗi web vài cent → vài chục cent; chi phí ở sự kiện `done` / cuối CLI).
- Model mặc định `sonnet` (Sonnet 4.5) trong `instructions.mjs` (`opus` khó hơn, `haiku` nhanh/rẻ).
- Preview là nội dung do AI sinh → phía daisan.ai nên nhúng iframe `sandbox`, và production nên đặt service ở origin riêng.
