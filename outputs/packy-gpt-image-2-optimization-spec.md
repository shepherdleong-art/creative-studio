# Packy GPT-Image-2 Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Packy GPT-Image-2 work reliably in the batch image workbench without reusing GeekAI's async polling model or risking unnecessary duplicate charges.

**Architecture:** Keep provider routing explicit. GeekAI keeps using `geekai-json` with JSON submit, `task_id`, polling, `needs_check`, and resume-poll. Packy should use a separate Packy-aware Images API adapter or a clearly Packy-configured branch built on multipart `/v1/images/edits`, synchronous long-connection response handling, no polling, conservative retry behavior, and Packy-specific request parameters.

**Tech Stack:** Next.js App Router, TypeScript, SQLite via `better-sqlite3`, Node `fetch`, `FormData`, local `storage/`, existing provider abstraction in `lib/queue.ts`.

---

## Source Context

Packy documentation:

```text
https://docs.packyapi.com/docs/paint/GPTImage.html
```

Key Packy facts from the documentation:

- `gpt-image-2` belongs to the Sora group; the API token must be created in the `sora` token group.
- Recommended base URL: `https://www.packyapi.com`.
- Text-to-image endpoint: `POST /v1/images/generations`.
- Image edit / image-to-image endpoint: `POST /v1/images/edits`.
- Image edit uses `multipart/form-data`, not JSON.
- It returns the final image directly as `data[0].url` or `data[0].b64_json`.
- It does not document `task_id`, `task_status`, `GET /v1/images/{task_id}`, polling, or resume-poll.
- `n` only supports `1`.
- `quality` supports `low`, `medium`, `high`, `auto`.
- `response_format` is documented as supported, but live `/v1/images/edits` returned `400 Unknown parameter: 'response_format'`; the workbench should omit it and rely on Packy's default URL response.
- `output_format` recommends `png` or `jpeg`; `webp` is not recommended.
- `input_fidelity=high` is documented, but live `/v1/images/edits` returned `400 ... does not support the 'input_fidelity' parameter`; the workbench should omit it.
- Long-running image requests may be interrupted by proxies around 60 seconds; Packy recommends direct routing for `packyapi.com`.

Existing project context:

- `lib/seed.ts` currently seeds Packy as `type: 'openai-compatible'`.
- `lib/queue.ts` already routes `provider.type === 'geekai-json'` to the GeekAI async flow and everything else to `openai-compatible`.
- `lib/providers/openai-compatible.ts` currently sends multipart `/v1/images/edits`, uses `response_format=b64_json`, and appends reference images as `reference_images`.
- `app/api/jobs/[id]/resume-poll/route.ts` is GeekAI-only and should stay GeekAI-only.
- `app/api/projects/[id]/run/route.ts` currently defaults queue timeout to 180000ms.

## Do Not Change

- Do not make Packy use GeekAI polling.
- Do not call Packy with `/v1/responses` or `/v1/chat/completions`.
- Do not add automatic Packy resume-poll behavior.
- Do not silently retry Packy timeouts by default.
- Do not run paid API tests unless explicitly approved by the user.
- Do not commit `.env.local`, SQLite DBs, `storage/`, `.next/`, or `node_modules/`.

## Desired Provider Split

Use this mental model:

```text
GeekAI:
  JSON body
  async: true
  POST /v1/images/edits
  returns task_id
  poll GET /v1/images/{task_id}
  needs_check + resume-poll is valid

Packy:
  multipart/form-data
  POST /v1/images/edits
  long connection waits for final image
  returns data[0].url or data[0].b64_json
  no task_id
  no polling
  no resume-poll
```

## File Structure

Modify these files:

- `lib/seed.ts`
  - Change Packy default base URL to `https://www.packyapi.com`.
  - Prefer a Packy-specific type such as `packy-images`, or keep `openai-compatible` only if Packy-specific behavior is controlled by a helper.

- `lib/providers/packy-images.ts`
  - New Packy adapter is preferred.
  - Responsible only for Packy GPT-Image-2 Images API edit calls.
  - Uses multipart `/v1/images/edits`.
  - Adds `output_format=png` and `n=1`.
  - Does not send `response_format` because live Packy `/v1/images/edits` rejects it with `400 Unknown parameter`.
  - Does not send `input_fidelity` because live Packy `/v1/images/edits` rejects it with `400 unsupported parameter`.
  - Downloads `data[0].url` into a `Buffer`.
  - Accepts `AbortSignal`.
  - Produces clear Packy-specific error messages.

- `lib/queue.ts`
  - Route `provider.type === 'packy-images'` to the new Packy adapter.
  - Keep `geekai-json` unchanged.
  - For Packy, prevent automatic retries after timeout-like failures by marking the job failed with a clear "may have been submitted" warning.

- `app/settings/page.tsx`
  - Add `Packy Images API (multipart, no polling)` to provider type dropdown.
  - Make the label clear that Packy does not support GeekAI-style polling.

- `app/api/providers/route.ts`
  - When creating a provider manually, avoid defaulting to `geekai-json`; use `openai-compatible` as the neutral default or preserve submitted type.

- `app/api/providers/[id]/route.ts`
  - Ensure `packy-images` is accepted and persisted.

- `components/ProviderSettings.tsx`
  - Optional but recommended: show provider type on project creation cards so the user can see whether they selected GeekAI or Packy.

- `README.md` or `outputs/packy-test-checklist.md`
  - Add a short Packy test checklist for the user.

## Task 1: Add Packy Provider Type and Defaults

**Files:**

- Modify: `lib/seed.ts`
- Modify: `app/settings/page.tsx`
- Modify: `app/api/providers/route.ts`
- Modify: `app/api/providers/[id]/route.ts`

- [ ] **Step 1: Update seeded Packy provider**

In `lib/seed.ts`, change the Packy provider to:

```ts
{
  id: uuidv4(),
  name: 'Packy GPT-Image-2',
  baseUrl: process.env.PACKY_BASE_URL || 'https://www.packyapi.com',
  apiKeyEnv: 'PACKY_API_KEY',
  apiKey: process.env.PACKY_API_KEY || '',
  model: 'gpt-image-2',
  type: 'packy-images',
  enabled: 0,
  defaultCostPerImage: 0.5,
}
```

Expected behavior:

- New databases seed Packy with the correct documented base URL.
- Existing databases are not overwritten automatically; users can edit provider settings manually.

- [ ] **Step 2: Add provider type option in settings UI**

In `app/settings/page.tsx`, update the provider type dropdown:

```tsx
<option value="geekai-json">GeekAI (JSON + async polling)</option>
<option value="packy-images">Packy Images API (multipart, no polling)</option>
<option value="openai-compatible">OpenAI-compatible (multipart)</option>
```

Expected behavior:

- The UI makes it obvious Packy is not GeekAI-style polling.

- [ ] **Step 3: Change manual provider default**

In `app/api/providers/route.ts`, change:

```ts
body.type || 'geekai-json'
```

to:

```ts
body.type || 'openai-compatible'
```

Expected behavior:

- A manually created provider is not accidentally treated as GeekAI.

- [ ] **Step 4: Verify provider update endpoint accepts the new type**

In `app/api/providers/[id]/route.ts`, confirm it stores `body.type` without filtering out `packy-images`.

If validation exists or is added, allow exactly:

```ts
const allowedTypes = new Set(['geekai-json', 'packy-images', 'openai-compatible']);
```

Expected behavior:

- Editing a provider to `packy-images` persists correctly.

## Task 2: Create Packy Images Adapter

**Files:**

- Create: `lib/providers/packy-images.ts`

- [ ] **Step 1: Create adapter file**

Create `lib/providers/packy-images.ts`:

```ts
import fs from 'fs';
import path from 'path';

export interface PackyEditImageRequest {
  model: string;
  prompt: string;
  inputImagePath: string;
  inputMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  referenceImagePaths: string[];
  referenceMimeTypes: ('image/png' | 'image/jpeg' | 'image/webp')[];
  size: string;
  quality: string;
}

export interface PackyEditImageResult {
  imageBuffer: Buffer;
  latencyMs: number;
  rawResponse?: unknown;
  remoteImageUrl?: string;
}

type PackyImageResponse = {
  created?: number;
  data?: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  error?: string | { message?: string; code?: string };
};

function extractPackyError(data: PackyImageResponse): string | undefined {
  if (!data.error) return undefined;
  if (typeof data.error === 'string') return data.error;
  return data.error.message || data.error.code;
}

async function downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Packy image download failed ${res.status}: ${text.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function editImagePacky(
  request: PackyEditImageRequest,
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<PackyEditImageResult> {
  const startTime = Date.now();
  const cleanBase = baseUrl.replace(/\/$/, '');
  const url = `${cleanBase}/v1/images/edits`;

  const form = new FormData();
  form.append('model', request.model);
  form.append('prompt', request.prompt);
  form.append('image', new Blob([fs.readFileSync(request.inputImagePath)], { type: request.inputMimeType }), path.basename(request.inputImagePath));
  form.append('size', request.size);
  form.append('quality', request.quality || 'auto');
  form.append('n', '1');
  form.append('output_format', 'png');

  if (request.referenceImagePaths.length > 0) {
    const refNote = `\n\n参考图说明：本次任务附带 ${request.referenceImagePaths.length} 张参考图。Packy 文档建议图片编辑一次只上传 1 张 image；如果多参考图失败，请先改为单图测试。`;
    form.set('prompt', request.prompt + refNote);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: '*/*',
    },
    body: form,
    signal,
  });

  const latencyMs = Date.now() - startTime;
  const text = await res.text();

  let data: PackyImageResponse;
  try {
    data = JSON.parse(text) as PackyImageResponse;
  } catch {
    throw new Error(`Packy returned non-JSON response ${res.status}: ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    throw new Error(`Packy API error ${res.status}: ${extractPackyError(data) || text.slice(0, 500)}`);
  }

  const first = data.data?.[0];
  if (!first) {
    throw new Error(`Packy returned no image data: ${JSON.stringify(data).slice(0, 500)}`);
  }

  if (first.b64_json) {
    return {
      imageBuffer: Buffer.from(first.b64_json, 'base64'),
      latencyMs,
      rawResponse: data,
    };
  }

  if (first.url) {
    const imageBuffer = await downloadImage(first.url, signal);
    return {
      imageBuffer,
      latencyMs,
      rawResponse: data,
      remoteImageUrl: first.url,
    };
  }

  throw new Error(`Packy response contains neither url nor b64_json: ${JSON.stringify(data).slice(0, 500)}`);
}
```

Expected behavior:

- Packy uses documented multipart `/v1/images/edits`.
- Packy omits `response_format` and downloads the default returned URL.
- Packy does not poll.
- Packy omits `input_fidelity`.

## Task 3: Route Packy Separately in Queue

**Files:**

- Modify: `lib/queue.ts`

- [ ] **Step 1: Import Packy adapter**

At the top of `lib/queue.ts`, add:

```ts
import { editImagePacky } from './providers/packy-images';
```

- [ ] **Step 2: Add Packy branch**

In `runJob`, after the `geekai-json` branch and before the generic OpenAI-compatible branch, add:

```ts
} else if (providerType === 'packy-images') {
  logInfo('Calling Packy Images API (multipart, no polling)...');

  result = await withTimeout(
    editImagePacky(
      {
        model: job.model,
        prompt: job.prompt,
        inputImagePath: inputApiPath,
        inputMimeType,
        referenceImagePaths: refApiPaths,
        referenceMimeTypes: refMimeTypes,
        size: job.size,
        quality: job.quality || 'auto',
      },
      apiKey,
      provider.baseUrl,
      reqAbort.signal
    ),
    timeoutMs,
    reqAbort
  );
```

Expected behavior:

- `packy-images` does not fall into the generic branch.
- Logs clearly identify Packy.

- [ ] **Step 3: Save Packy remote URL when available**

The existing `result` type inside `runJob` is:

```ts
let result: { imageBuffer: Buffer; latencyMs: number; rawResponse?: unknown } | undefined;
```

Change it to:

```ts
let result: { imageBuffer: Buffer; latencyMs: number; rawResponse?: unknown; remoteImageUrl?: string } | undefined;
```

When updating successful jobs, include `remoteImageUrl` if present:

```ts
const completeResult = db.prepare(
  `UPDATE jobs SET
    status = 'succeeded',
    finishedAt = ?,
    latencyMs = ?,
    estimatedCost = ?,
    outputImageId = ?,
    remoteImageUrl = COALESCE(?, remoteImageUrl),
    providerRawResponse = COALESCE(?, providerRawResponse)
   WHERE id = ? AND status = 'running'`
).run(
  finishedAt,
  result.latencyMs,
  estimatedCost,
  outputImageId,
  result.remoteImageUrl || null,
  result.rawResponse ? safeJsonForDB(result.rawResponse) : null,
  job.id
);
```

Expected behavior:

- Packy result URL and raw response are preserved for debugging.

## Task 4: Prevent Packy Duplicate-Charge Retry Risk

**Files:**

- Modify: `lib/queue.ts`
- Optional modify: `app/api/projects/[id]/run/route.ts`

- [ ] **Step 1: Detect timeout-like errors**

Near `sanitizeErrorMessage`, add:

```ts
function isTimeoutLikeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('abort') ||
    m.includes('aborted') ||
    m.includes('failed to fetch') ||
    m.includes('network')
  );
}
```

- [ ] **Step 2: Special-case Packy timeout failures**

In the `catch` block of `runJob`, after `errorMessage = sanitizeErrorMessage(errorMessage);`, add:

```ts
const providerTypeForRetry = (() => {
  try {
    const p = db.prepare(`SELECT p.type FROM jobs j JOIN providers p ON p.id = j.providerId WHERE j.id = ?`).get(job.id) as { type?: string } | undefined;
    return p?.type || '';
  } catch {
    return '';
  }
})();

if (providerTypeForRetry === 'packy-images' && isTimeoutLikeError(errorMessage)) {
  const msg = `${errorMessage}。Packy 是长连接同步返回，超时不代表远端一定未扣费；为避免重复扣费，已停止自动重试。请检查 Packy 控制台或稍后手动决定是否重跑。`;
  db.prepare(
    `UPDATE jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
     WHERE id = ? AND status = 'running'`
  ).run(msg, job.id);
  logError(msg);
  return;
}
```

Expected behavior:

- Packy timeout does not automatically retry and possibly charge twice.
- GeekAI behavior remains unchanged.
- Generic OpenAI-compatible behavior remains unchanged.

- [ ] **Step 3: Consider longer default timeout for Packy**

Do not globally increase every provider timeout unless desired. The safest initial behavior is:

```text
For Packy testing, the user should start with low/medium quality, 1 image, concurrency 1.
```

If implementing provider-aware timeout later, use 300000ms for Packy and keep 180000ms for generic providers.

## Task 5: Make Packy Test Mode Obvious to User

**Files:**

- Modify: `components/ProviderSettings.tsx`
- Optional modify: `app/projects/new/page.tsx`
- Create: `outputs/packy-test-checklist.md`

- [ ] **Step 1: Show provider type on provider cards**

In `components/ProviderSettings.tsx`, add this line under the model display:

```tsx
<div className="text-xs text-gray-400 mt-0.5">类型: {p.type}</div>
```

Expected behavior:

- User can visually confirm Packy is using `packy-images`, not `geekai-json`.

- [ ] **Step 2: Create Packy test checklist**

Create `outputs/packy-test-checklist.md`:

```md
# Packy GPT-Image-2 Test Checklist

## Before buying or spending balance

- Create a Packy API token in the `sora` token group.
- Configure provider:
  - Name: Packy GPT-Image-2
  - Base URL: https://www.packyapi.com
  - Model: gpt-image-2
  - Type: Packy Images API (multipart, no polling)
  - API Key: your Sora group token

## First paid test

- Images: 1 input image only
- Reference images: none
- Quality: low or medium
- Size: auto or 1k
- Concurrency: 1
- Max attempts: 1
- Prompt: simple edit that preserves the main subject

## Expected behavior

- No task_id is created.
- No polling happens.
- No "补抓结果" is needed.
- The request waits until Packy returns `data[0].url` or `data[0].b64_json`.
- The workbench downloads and saves one output image.

## If it times out

- Do not immediately retry many times.
- Check whether the Packy request was charged or produced a result.
- Confirm proxy/VPN rules allow direct access to `packyapi.com`.
- Try again with lower quality or smaller size.
```

Expected behavior:

- The user has a safe 10 yuan test path.

## Task 6: No-Paid Verification

**Files:**

- Test command only; do not call Packy.

- [ ] **Step 1: Type/lint check**

Run:

```bash
npm run lint
```

Expected:

```text
No ESLint errors from the changed files.
```

If local `node_modules` is broken, run:

```bash
npm install
npm run lint
```

- [ ] **Step 2: Build check**

Run:

```bash
npm run build
```

Expected:

```text
Build succeeds without TypeScript errors.
```

- [ ] **Step 3: Provider UI check**

Run:

```bash
npm run dev
```

Open:

```text
http://localhost:3000/settings
```

Expected:

- Provider type dropdown includes `Packy Images API (multipart, no polling)`.
- Packy provider can be saved with `https://www.packyapi.com`.
- API Key field still does not echo saved keys.

- [ ] **Step 4: Do not perform paid API calls**

Do not click "run" on a real Packy project during implementation verification unless the user explicitly approves paid testing.

## Task 7: First Paid Smoke Test, Only With User Approval

**Files:**

- Runtime only; no code changes.

- [ ] **Step 1: Configure Packy provider**

Use:

```text
Base URL: https://www.packyapi.com
Type: packy-images
Model: gpt-image-2
API key: Packy Sora group token
```

- [ ] **Step 2: Create minimal project**

Use:

```text
Input images: 1
Reference images: 0
Prompt: 保持主体不变，把背景改成干净的白色摄影棚背景，自然柔和光线。
Size: auto or 1024x1024
Quality: low or medium
Concurrency: 1
Max attempts: 1
```

- [ ] **Step 3: Run and observe logs**

Expected logs:

```text
Calling Packy Images API (multipart, no polling)...
API call succeeded
任务完成
```

Not expected:

```text
task_id
轮询
needs_check
补抓结果
```

- [ ] **Step 4: Verify output**

Expected:

- One image appears in result gallery.
- Job status is `succeeded`.
- `remoteImageUrl` is saved if Packy returned a URL.
- `providerRawResponse` is saved for debugging.

## Handoff Prompt for Claude Code

```text
Please continue developing /Users/liangpeijian/for-cc/batch-image-workbench.

Read outputs/packy-gpt-image-2-optimization-spec.md first.

Goal:
Optimize Packy GPT-Image-2 support without using GeekAI's async polling model.

Important:
- GeekAI uses JSON + async task_id + polling.
- Packy uses multipart /v1/images/edits and returns data[0].url or data[0].b64_json directly.
- Packy must not use GeekAI polling, needs_check, or resume-poll.
- Packy default base URL should be https://www.packyapi.com.
- Packy token must be a Sora group token.
- Add a Packy-specific provider type such as packy-images.
- Add output_format=png and n=1 for Packy; do not send response_format or input_fidelity because live edits calls reject them.
- Avoid automatic retries on Packy timeout-like errors to reduce duplicate-charge risk.
- Do not run paid API calls unless explicitly approved.

After implementation:
- Run npm run lint.
- Run npm run build.
- If local dependencies are broken, run npm install first.
- Commit changes locally with a clear message.
```

## Self-Review

- Spec coverage: Covers provider split, Packy API shape, no polling, base URL, request parameters, timeout/retry risk, UI visibility, no-paid verification, and paid smoke-test checklist.
- Placeholder scan: No TBD/TODO/implement later placeholders remain.
- Type consistency: The proposed provider type is consistently `packy-images`; the adapter function is consistently `editImagePacky`.
