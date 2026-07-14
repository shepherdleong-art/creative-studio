# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                  # Dev server at localhost:3000
npm run dev:win              # Dev server at 127.0.0.1 (Windows)
npm run build                # Production build (next build + sync standalone assets)
npm run lint                 # ESLint
npm run icons                # Regenerate app icons from source art
npm run build:win-installer  # Build Windows installer (PowerShell/Inno Setup; run on Windows)
npm run build:mac-installer  # Build macOS DMG (bash; Apple Silicon host, requires Node 22.x)
```

There is no `npm test` script. Tests are standalone files under `scripts/*.test.ts` and `scripts/*.test.mjs`, run directly via Node's native TypeScript support (Node 22+):

```bash
node scripts/db-migrations.test.ts   # run a single test file
node scripts/<name>.test.ts          # pattern for any other test file
```

## Architecture

**Creative Studio** is a local-first AI asset production workbench — it turns a product image into scene images, shot sequences, scripts, and video tasks, then exports a ZIP package. Built with Next.js 16 App Router + React 19 + SQLite (`better-sqlite3`). Ships either as a plain web app or as a packaged Windows/macOS desktop installer with a bundled private Node runtime.

### Core layers

- **`app/api/`** — ~40 REST API routes (projects, jobs, images, shots, scripts, video, shutdown)
- **`lib/`** — Business logic
  - `db.ts` / `db-migrations.ts` — SQLite init (WAL mode, foreign keys); `CORE_DB_MIGRATIONS` is a flat list of `ALTER TABLE` statements applied on every startup, each wrapped in try/catch so already-applied columns are silently skipped
  - `data-root.ts` — resolves the local data root for the current run mode (dev server / installed app / EXE, overridable via `CREATIVE_STUDIO_DATA_ROOT`); all local paths (`data/`, `storage/`) derive from this
  - `queue.ts` / `video-queue.ts` — Async job polling queues
  - `providers/` — Image generation adapters (Packy, GeekAI, OpenAI-compatible)
  - `script-providers/` — LLM script generation (Gemini, Qwen, Kimi, GPT)
  - `video-providers/` — Video generation adapters (Kling, Jimeng)
  - `image-output-normalize.ts` — Sharp-based crop/resize to target dimensions
  - `provider-concurrency.ts` — Per-provider concurrency limits
  - `final-video/` — 成片包装引擎（时间线/ASS 字幕/FFmpeg 渲染图/渲染队列）。画面的选择与顺序由脚本生成步骤决定（`script_drafts.outputJson.segments`），本层只做确定性对账与秒数精算，不调用 LLM。ffmpeg 二进制经 `lib/ffmpeg.ts` 解析（env → ffmpeg-static → PATH）
- **`components/`** — React UI (workbench tabs, shot panels, video panels)
- **`data/`** — Local SQLite DB (`workbench.db`, gitignored)
- **`storage/`** — Uploaded assets & generated outputs (gitignored)

### Data flow

1. User creates project → uploads scene/input images → sets prompt & model
2. Job submitted to provider, stored in `jobs` table with polling state (`lastPolledAt`, `pollCount`, `maxAttempts`)
3. Queue polls provider status asynchronously; on completion, image downloaded and normalized via Sharp
4. Results stored in `image_assets`, organized into `shot_sets` → `shots` → `shot_result_candidates`
5. Scripts generated via LLM providers; video jobs created from shots
6. Project exported as ZIP

### Desktop packaging

- `scripts/build-win-installer.ps1` and `scripts/build-mac-installer.sh` each run the production build, download a matching private Node runtime, and assemble a self-contained installer from `installer/windows/` (Inno Setup script + launcher) or `installer/macos/` (`.app` bundle template + launcher).
- macOS builds are Apple Silicon-only and must run on a Node 22.x host — the bundled runtime is pinned to a specific Node 22 build, and a mismatched major version breaks the native module ABI for `better-sqlite3`/`sharp`.
- Installer payloads must not leak dev-only paths (`data/`, `storage/`, `outputs/`, `docs/`, `scripts/`, `.git/`); the build scripts prune them and then assert none remain before packaging. `ffmpeg-static`/`ffprobe-static` 由 `sync-standalone-assets.mjs` 拷入 standalone，两个安装脚本会断言其存在。
- `app/api/shutdown` exposes a graceful `POST` shutdown endpoint that installed-app stop scripts/launchers call instead of killing the process directly.
- `MACOS.md` covers the macOS installer's user-facing install/uninstall/data-location instructions.

### Key conventions

- **Provider adapter pattern**: All three provider layers (image/script/video) use adapters — add new suppliers by implementing the adapter interface, not modifying core logic.
- **Cost tracking**: Each job stores estimated cost; providers expose a cost calculation method.
- **`projects.concurrency`** controls max parallel job submissions per project.
- **`.env.local`** holds LLM API keys (Gemini, Qwen, Kimi, GPT) — never commit this file.
- **`docs/`** holds design/review/session-summary records; `outputs/` holds phase specs, test checklists, and delivery records; `docs/superpowers/{specs,plans}/` holds spec-driven planning docs for larger features.
- UI language is Chinese; key domain terms: 项目 (project), 分镜 (shot/storyboard), 场景图 (scene image), 脚本 (script).
