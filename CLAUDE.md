# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Dev server at localhost:3000
npm run dev:win      # Dev server at 127.0.0.1 (Windows)
npm run build        # Production build
npm run lint         # ESLint
```

## Architecture

**Creative Studio** is a local-first AI asset production workbench — it turns a product image into scene images, shot sequences, scripts, and video tasks, then exports a ZIP package. Built with Next.js 16 App Router + React 19 + SQLite (`better-sqlite3`).

### Core layers

- **`app/api/`** — 40+ REST API routes (projects, jobs, images, shots, scripts, video)
- **`lib/`** — Business logic
  - `db.ts` — SQLite init (WAL mode, foreign keys, migrations on startup)
  - `queue.ts` / `video-queue.ts` — Async job polling queues
  - `providers/` — Image generation adapters (Packy, GeekAI, OpenAI-compatible)
  - `script-providers/` — LLM script generation (Gemini, Qwen, Kimi, GPT)
  - `video-providers/` — Video generation adapters (Kling, Jimeng)
  - `image-output-normalize.ts` — Sharp-based crop/resize to target dimensions
  - `provider-concurrency.ts` — Per-provider concurrency limits
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

### Key conventions

- **Provider adapter pattern**: All three provider layers (image/script/video) use adapters — add new suppliers by implementing the adapter interface, not modifying core logic.
- **DB migrations**: Applied idempotently on startup in `db.ts`; use try/catch for rollback safety.
- **Cost tracking**: Each job stores estimated cost; providers expose a cost calculation method.
- **`projects.concurrency`** controls max parallel job submissions per project.
- **`.env.local`** holds LLM API keys (Gemini, Qwen, Kimi, GPT) — never commit this file.
- UI language is Chinese; key domain terms: 项目 (project), 分镜 (shot/storyboard), 场景图 (scene image), 脚本 (script).
