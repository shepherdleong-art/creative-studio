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

Company-gateway local stack (Windows): when `.venv-litellm`, `config.yaml` and `.cache/cloudflared/cloudflared.exe` are present, `start-windows.cmd` first runs `scripts/start-stack.ps1 -SkipApp` to bring up the LiteLLM proxy (port 4000) and a tunnel (cloudflared, pinggy fallback), injects the tunnel URL as `CREATIVE_STUDIO_PUBLIC_BASE_URL`, then starts the dev server as before; without those components it behaves exactly as before. `stop-windows.cmd`, Ctrl+C in the start window, and the UI shutdown button (`/api/shutdown` reads `storage/run/stack.json`'s `stopScript` and runs `scripts/stop-stack.ps1`) all tear down the proxy and tunnel too. `storage/run/stack.json` is BOM-less JSON; `scripts/*.ps1` MUST stay UTF-8 **with BOM** — PS 5.1 misreads BOM-less Chinese and fails to parse.

There is no `npm test` script. Tests are standalone files under `scripts/*.test.ts` and `scripts/*.test.mjs`, run directly via Node's native TypeScript support (Node 22+):

```bash
node scripts/db-migrations.test.ts   # run a single test file
node scripts/<name>.test.ts          # pattern for any other test file
```

## Architecture

**Creative Studio** is a local-first AI asset production workbench — it turns a product image into scene images, shot sequences, scripts, video tasks, and rendered final edits, then exports a ZIP package. Built with Next.js 16 App Router + React 19 + SQLite (`better-sqlite3`). Ships either as a plain web app or as a packaged Windows/macOS desktop installer with a bundled private Node runtime.

### Core layers

- **`app/api/`** — REST API route groups for projects, jobs, images, shots, scripts, video, shutdown, and the versioned final-edit/mixcut workflow (context, scoped Module 4 assets, external assets, groups, variants, jobs, BGM and proposals)
- **`lib/`** — Business logic
  - `db.ts` / `db-migrations.ts` — SQLite init (WAL mode, foreign keys); `CORE_DB_MIGRATIONS` is an append-only flat SQL list applied after core tables exist, each wrapped in try/catch so already-applied columns/indexes are skipped
  - `schema-upgrade/` — shared safe-upgrade infrastructure: SQLite Online Backup, disk preflight, a cross-process SQLite write lock, repairable JSONL audit records, one shared gate, and verified recovery-candidate discovery; paths derive from `dataRoot()`
  - `batch-production/` — independent batch-production module; `schema.ts` uses versioned `IMMEDIATE` transactions and `readiness.ts` is the locked, audited gate behind `GET /api/batch-production/readiness`. Published migrations v1–v9 cover the full batch domain: project assets + analysis versions (v2, identity by content fingerprint, never by path), batch versions + asset pools (v3), project scripts + snapshots (v4), output plans + output versions (v5, copy count decides exactly N plans), tasks + attempts (v6, retries only add attempts), artifacts + current-output pointer (v7), append-only artifact path uniqueness and protected artifact lineage (v8), and irreversible per-version input freezing, logical batch deletion, and batch-owned external copy (v9). Once a version starts, its `inputState` stays frozen even if the batch status later returns to draft; changing the input requires a new version. External copy can only be snapshotted into its owning batch version and is copied, not retyped, when explicitly saved as a project script. Public domain interfaces live in `assets.ts`/`versions.ts`/`scripts.ts`/`plans.ts`/`tasks.ts`/`artifacts.ts`. `GET /api/batch-production/recovery` only lists and revalidates candidates; no running API may overwrite the live database. If unavailable, disable only batch production and preserve legacy projects and single precise mixcut
  - `video-provider-schema.ts` — safely upgrades the legacy `video_providers` CHECK constraint only when an `openai-video` provider is created or selected; normal database startup must not rebuild the table without a verified backup
  - `data-root.ts` — resolves the local data root for the current run mode (dev server / installed app / EXE, overridable via `CREATIVE_STUDIO_DATA_ROOT`); all local paths (`data/`, `storage/`) derive from this
  - `local-image-url.ts` — turns a local `storage/` image into an `/api/images/...` HTTP URL for gateway upstreams that only accept real URLs (e.g. Tencent); the address is auto-detected (first non-internal IPv4 + `PORT`/3000, overridable via `CREATIVE_STUDIO_PUBLIC_BASE_URL`), otherwise callers fall back to data URLs
  - `gateway-media-url.ts` — normalizes gateway result URLs (rewrites localhost/relative result URLs back onto the gateway origin) and downloads media with Bearer auth only when the target is the gateway origin
  - `queue.ts` / `video-queue.ts` — Async job polling queues
  - `providers/` — Image generation adapters (Packy, GeekAI, OpenAI-compatible, `gateway-task-image` for gateways that expose image models via the async `/v1/videos` task protocol)
  - `script-providers/` — LLM script generation through Gemini, OpenAI-compatible Chat Completions, OpenAI Responses/SSE, or Anthropic Messages (`/v1/messages`) adapters selected by persisted `apiStyle`
  - `video-providers/` — Video generation adapters (Kling, Jimeng, `openai-video` for New API-style gateways speaking the OpenAI `/v1/videos` protocol)
  - `company-gateway-size.ts` — size whitelist and snap-to-whitelist logic for the company model gateway (llm-gateway-idc.linshimuye.com via a local LiteLLM proxy, config in `config.yaml`); the `gateway-task-image` / `openai-video` adapters snap requested sizes to the documented per-model combinations and add the required `response_format` only for company models; completed tasks often carry no result URL, so both adapters fall back to downloading from `/v1/videos/<id>/content` using the ORIGINAL submit-time task id (poll-response ids may lose the embedded model_id and misroute at the LiteLLM proxy)
  - `final-edit/` — Versioned final-edit schema, group/variant workspace, external-material import, media analysis, V-API/Doubao TTS and alignment adapters, TTS-aware matching-sentence refinement, timeline planning and FFmpeg rendering. Mixcut context and external assets are scoped by `projectId + shotSetId`; never infer grouping from filenames or timestamps
  - `image-output-normalize.ts` — Sharp-based crop/resize to target dimensions
  - `provider-concurrency.ts` — Per-provider concurrency limits
  - `ffmpeg.ts` — resolves ffmpeg/ffprobe (env → static package → PATH), probes media with an asynchronous fallback, and runs final-edit renders with progress/timeout/error-tail handling
- **`components/`** — React UI (workbench tabs, shot panels, video panels); `components/mixcut/` is the formal fifth-step “智能混剪” workspace, while `components/final-edit/` retains shared preview, inspector, and Canvas editing primitives
- **`data/`** — Local SQLite DB (`workbench.db`, gitignored)
- **`storage/`** — Uploaded assets & generated outputs (gitignored)

### Data flow

1. User creates project → uploads scene/input images → sets prompt & model
2. Job submitted to provider, stored in `jobs` table with polling state (`lastPolledAt`, `pollCount`, `maxAttempts`)
3. Queue polls provider status asynchronously; on completion, image downloaded and normalized via Sharp
4. Results stored in `image_assets`, organized into `shot_sets` → `shots` → `shot_result_candidates`
5. Scripts generated via LLM providers; video jobs created from shots
6. Final edit analyzes selected video, generates narration and aligned subtitles, builds timelines, and renders output through FFmpeg
7. Project artifacts, including historical storyboard candidates, can be exported as ZIP

### Desktop packaging

- `scripts/build-win-installer.ps1` and `scripts/build-mac-installer.sh` each run the production build, download a matching private Node runtime, and assemble a self-contained installer from `installer/windows/` (Inno Setup script + launcher) or `installer/macos/` (`.app` bundle template + launcher).
- macOS builds are Apple Silicon-only and must run on an arm64 Node 22.x host — the bundled runtime is pinned to a specific Node 22 build, and a mismatched major version or x64 Node under Rosetta breaks the native module ABI for `better-sqlite3`/`sharp`.
- Installer payloads must not leak dev-only paths (`data/`, `storage/`, `outputs/`, `docs/`, `scripts/`, `.git/`); the build scripts prune them and then assert none remain before packaging. Both platforms require bundled FFmpeg. On macOS the installer verifies an arm64 FFmpeg and removes the currently mislabeled x86_64 `ffprobe-static` payload, relying on the tested FFmpeg metadata-probe fallback; Windows still requires its native ffprobe binary.
- `app/api/shutdown` exposes a graceful `POST` shutdown endpoint that installed-app stop scripts/launchers call instead of killing the process directly.
- `MACOS.md` covers the macOS installer's user-facing install/uninstall/data-location instructions.

### Key conventions

- **Provider adapter pattern**: All three provider layers (image/script/video) use adapters — add new suppliers by implementing the adapter interface, not modifying core logic.
- **Database migrations**: Keep published `CORE_DB_MIGRATIONS` and `FINAL_EDIT_MIGRATIONS` entries unchanged. Existing core tables retain the append-only legacy stream; final edit and batch production have separate versioned streams. Batch migrations and the legacy video-provider table rebuild must pass the shared lock, validated-backup, and audit gate; never place them in the legacy catch-and-continue core runner.
- **Cost tracking**: Each job stores estimated cost; providers expose a cost calculation method.
- **`projects.concurrency`** controls max parallel job submissions per project.
- **`.env.local`** holds LLM API keys (Gemini, Qwen, Kimi, GPT) — never commit this file.
- **`docs/`** holds design/review/session-summary records; `outputs/` holds phase specs, test checklists, and delivery records; `docs/superpowers/{specs,plans}/` holds spec-driven planning docs for larger features.
- UI language is Chinese; key domain terms: 项目 (project), 分镜 (shot/storyboard), 场景图 (scene image), 脚本 (script).
