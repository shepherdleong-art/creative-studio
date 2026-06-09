# Claude Code Bugfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the concrete bugs found in the 2026-06-08 review of Claude Code changes, especially paid-API safety, Packy behavior, project status accuracy, output naming, and Windows path compatibility.

**Architecture:** Keep the current provider split: GeekAI remains `geekai-json` with async polling, Packy remains `packy-images` with multipart long-connection and no polling. Add targeted guards and shared helpers instead of broad refactors, and verify with no-paid tests only.

**Tech Stack:** Next.js App Router, TypeScript, React, SQLite via `better-sqlite3`, local `storage/`, Node `fs/path`, existing queue/provider adapters.

---

## Review Findings To Fix

Source review file:

```text
outputs/2026-06-08-all-changes.md
```

Confirmed issues:

1. `lib/providers/packy-images.ts` previously ignored extra reference images from the workbench "参考图" upload area. The current desired behavior is experimental: send reference images and the target image as repeated multipart `image` fields, with references first and target image last.
2. `lib/queue.ts` marks a project `completed` when all workers finish and there are no failed jobs, even if some jobs are `needs_check`.
3. `lib/queue.ts` stores Packy `remoteImageUrl`, but does not persist Packy `providerRawResponse`.
4. `app/api/jobs/[id]/resume-poll/route.ts` writes `output-${inputBase}.png` directly and can overwrite existing output files.
5. `app/api/projects/[id]/route.ts` computes image URLs with `filePath.indexOf('storage/')`, which breaks on Windows paths using `\`.
6. `app/api/jobs/[id]/regenerate/route.ts` calculates `revision` using `COUNT(*) + 1`, which can duplicate revisions under concurrent regenerate requests.
7. `npm run lint` currently fails before code linting because `node_modules/node-exports-info/getCategoriesForRange.js` is missing.

## Non-Goals

- Do not run paid image generation API calls.
- Do not change GeekAI's async polling behavior except for project status accounting.
- Do not add Packy polling or `needs_check`.
- Do not delete API keys or local storage data.
- Do not run `npm audit fix --force` unless separately approved.

## Task 1: Enable Experimental Packy Reference Image Upload

**Files:**

- Modify: `app/projects/new/page.tsx`
- Modify: `app/api/projects/route.ts`
- Modify: `lib/providers/packy-images.ts`

- [ ] **Step 1: Add provider type to new project provider interface**

In `app/projects/new/page.tsx`, update the local `Provider` interface:

```ts
interface Provider {
  id: string;
  name: string;
  model: string;
  type: string;
  hasApiKey?: boolean;
  defaultCostPerImage?: number;
}
```

Expected:

- The new project page can distinguish Packy from GeekAI before submitting.

- [ ] **Step 2: Remove frontend guard for Packy + extra reference images**

In `app/projects/new/page.tsx`, inside `handleSubmit`, remove any guard like:

```ts
if (provider.type === 'packy-images' && referenceFiles.length > 0) {
  alert('...');
  return;
}
```

Keep the API key guard:

```ts
if (provider.hasApiKey === false) {
  alert('当前供应商未配置 API Key，请先到供应商配置里填写 Key');
  return;
}
```

Expected:

- User can use Packy for `/v1/images/edits` with one main input image.
- User can intentionally experiment with extra reference images.

- [ ] **Step 3: Remove backend guard for Packy + extra reference images**

In `app/api/projects/route.ts`, keep the provider select with `type` if already present:

```ts
const provider = db.prepare(`SELECT id, enabled, apiKey, apiKeyEnv, type FROM providers WHERE id = ?`).get(providerId) as {
  id: string;
  enabled: number;
  apiKey: string;
  apiKeyEnv: string;
  type: string;
} | undefined;
```

After the API key check, remove any guard like:

```ts
if (provider.type === 'packy-images' && Array.isArray(referenceImageIds) && referenceImageIds.length > 0) {
  return NextResponse.json(
    { error: '...' },
    { status: 400 }
  );
}
```

Expected:

- Direct API calls can create Packy jobs with extra reference images for controlled testing.

- [ ] **Step 4: Upload reference images experimentally**

In `lib/providers/packy-images.ts`, replace any `throw` or prompt-only note for reference images with real multipart upload:

```ts
const hasReferences = request.referenceImagePaths.length > 0;
const prompt = hasReferences
  ? `图1-${request.referenceImagePaths.length}是风格/场景参考图，图${request.referenceImagePaths.length + 1}是需要编辑的原图。保持最后一张图的产品主体、比例、材质不变，参考前面图片调整场景、光线和布置。\n${request.prompt}`
  : request.prompt;

form.append('prompt', prompt);

for (let i = 0; i < request.referenceImagePaths.length; i++) {
  const refPath = request.referenceImagePaths[i];
  const refMime = request.referenceMimeTypes[i] || 'image/png';
  const refBuf = fs.readFileSync(refPath);
  form.append(
    'image',
    new Blob([refBuf], { type: refMime }),
    `reference-${i + 1}-${path.basename(refPath)}`
  );
}

const inputBuf = fs.readFileSync(request.inputImagePath);
form.append(
  'image',
  new Blob([inputBuf], { type: request.inputMimeType }),
  path.basename(request.inputImagePath)
);
```

Expected:

- Even if another route bypasses project creation guards, Packy fails before spending a request with misleading input.

## Task 2: Mark Projects With `needs_check` Correctly

**Files:**

- Modify: `lib/queue.ts`
- Modify: `app/projects/[id]/page.tsx`
- Modify: `app/page.tsx` if it has project status labels

- [ ] **Step 1: Update final project status calculation**

In `lib/queue.ts`, replace the final status block:

```ts
const failedCount = db
  .prepare(`SELECT COUNT(*) as count FROM jobs WHERE projectId = ? AND status = 'failed'`)
  .get(projectId) as { count: number };

db.prepare(
  `UPDATE projects SET status = ? WHERE id = ?`
).run(failedCount.count > 0 ? 'partial_failed' : 'completed', projectId);
```

with:

```ts
const statusCounts = db.prepare(`
  SELECT
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN status = 'needs_check' THEN 1 ELSE 0 END) as needsCheck,
    SUM(CASE WHEN status IN ('pending', 'retrying', 'running') THEN 1 ELSE 0 END) as active
  FROM jobs
  WHERE projectId = ?
`).get(projectId) as { failed: number | null; needsCheck: number | null; active: number | null };

let finalStatus = 'completed';
if ((statusCounts.needsCheck || 0) > 0) {
  finalStatus = 'needs_check';
} else if ((statusCounts.failed || 0) > 0) {
  finalStatus = 'partial_failed';
} else if ((statusCounts.active || 0) > 0) {
  finalStatus = 'draft';
}

db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(finalStatus, projectId);
```

Expected:

- A project with GeekAI jobs waiting for "补抓结果" does not show as completed.

- [ ] **Step 2: Add project status label**

In `app/projects/[id]/page.tsx`, add to `STATUS_LABELS`:

```ts
needs_check: '待补抓',
```

If `app/page.tsx` has its own status labels, add the same mapping there.

Expected:

- Project detail and project list display `needs_check` clearly.

## Task 3: Persist Packy Raw Response

**Files:**

- Modify: `lib/queue.ts`

- [ ] **Step 1: Update success SQL**

In `lib/queue.ts`, replace the success update SQL:

```ts
const completeResult = db.prepare(
  `UPDATE jobs SET
    status = 'succeeded',
    finishedAt = ?,
    latencyMs = ?,
    estimatedCost = ?,
    outputImageId = ?,
    remoteImageUrl = COALESCE(?, remoteImageUrl)
   WHERE id = ? AND status = 'running'`
).run(finishedAt, result.latencyMs, estimatedCost, outputImageId, result.remoteImageUrl || null, job.id);
```

with:

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

Expected:

- Packy successful responses are available for later debugging.
- GeekAI and OpenAI-compatible successful responses also benefit when `rawResponse` exists.

## Task 4: Prevent Resume-Poll Output Overwrites

**Files:**

- Create: `lib/output-filenames.ts`
- Modify: `lib/queue.ts`
- Modify: `app/api/jobs/[id]/resume-poll/route.ts`

- [ ] **Step 1: Create shared filename helper**

Create `lib/output-filenames.ts`:

```ts
import fs from 'fs';
import path from 'path';

export function sanitizeFilenameBase(filePathOrName: string): string {
  const parsed = path.parse(filePathOrName);
  return parsed.name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'image';
}

export function ensureUniqueFilename(dir: string, filename: string, fallbackSuffix: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const direct = path.join(dir, filename);
  if (!fs.existsSync(direct)) return filename;

  const withSuffix = `${base}-${fallbackSuffix}${ext}`;
  if (!fs.existsSync(path.join(dir, withSuffix))) return withSuffix;

  let i = 2;
  while (true) {
    const candidate = `${base}-${fallbackSuffix}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
    i += 1;
  }
}
```

- [ ] **Step 2: Use helper in queue**

In `lib/queue.ts`, import:

```ts
import { sanitizeFilenameBase, ensureUniqueFilename } from './output-filenames';
```

Remove the local `sanitizeFilenameBase` and `ensureUniqueFilename` function definitions from the bottom of the file.

Expected:

- Queue behavior stays the same but helper is reusable.

- [ ] **Step 3: Use helper in resume-poll**

In `app/api/jobs/[id]/resume-poll/route.ts`, import:

```ts
import { sanitizeFilenameBase, ensureUniqueFilename } from '@/lib/output-filenames';
```

Replace:

```ts
const inputImage = db.prepare(`SELECT filename FROM image_assets WHERE id = ?`).get(job.inputImageId) as { filename: string } | undefined;
const inputBase = inputImage?.filename ? sanitizeBase(inputImage.filename) : job.id.slice(0, 8);
const outputFilename = `output-${inputBase}.png`;
const outputPath = path.join(outputsDir, outputFilename);
```

with:

```ts
const inputImage = db.prepare(`SELECT filename FROM image_assets WHERE id = ?`).get(job.inputImageId) as { filename: string } | undefined;
const inputBase = inputImage?.filename ? sanitizeFilenameBase(inputImage.filename) : job.id.slice(0, 8);
const preferredOutputName = `output-${inputBase}.png`;
const outputFilename = ensureUniqueFilename(outputsDir, preferredOutputName, job.id.slice(0, 6));
const outputPath = path.join(outputsDir, outputFilename);
```

Remove the local `sanitizeBase` function at the bottom of `resume-poll/route.ts`.

Expected:

- Resume-poll no longer overwrites `output-A.png` if it already exists.

## Task 5: Fix Windows Image URL Path Handling

**Files:**

- Modify: `app/api/projects/[id]/route.ts`

- [ ] **Step 1: Import `path`**

Add at the top:

```ts
import path from 'path';
```

- [ ] **Step 2: Replace storage string slicing**

Replace:

```ts
const filePath = img.path as string;
const storageIdx = filePath.indexOf('storage/');
const relativePath = storageIdx >= 0 ? filePath.slice(storageIdx + 'storage/'.length) : filePath;
return {
  ...img,
  relativePath,
  imageUrl: `/api/images/${relativePath}`,
};
```

with:

```ts
const filePath = img.path as string;
const storageRoot = path.resolve(path.join(process.cwd(), 'storage'));
const resolvedFile = path.resolve(filePath);
const relativePath = path.relative(storageRoot, resolvedFile).split(path.sep).join('/');

return {
  ...img,
  relativePath,
  imageUrl: `/api/images/${relativePath}`,
};
```

Expected:

- macOS and Windows both generate URL paths like `processed/inputs/file.jpg`.

## Task 6: Make Regenerate Revision Safer

**Files:**

- Modify: `app/api/jobs/[id]/regenerate/route.ts`

- [ ] **Step 1: Wrap revision calculation and insert in a transaction**

Replace the revision calculation and insert block with:

```ts
const newJobId = uuidv4();

const createRegeneration = db.transaction(() => {
  const latest = db.prepare(`
    SELECT COALESCE(MAX(revision), 0) + 1 as rev
    FROM jobs
    WHERE projectId = ? AND inputImageId = ?
  `).get(originalJob.projectId, originalJob.inputImageId) as { rev: number };

  db.prepare(`
    INSERT INTO jobs (
      id, projectId, inputImageId, referenceImageIds, providerId, model,
      prompt, size, quality, status, attempt, maxAttempts,
      parentJobId, revision
    )
    SELECT ?, projectId, inputImageId, referenceImageIds, providerId, model,
           ?, size, quality, 'pending', 0, maxAttempts,
           id, ?
    FROM jobs
    WHERE id = ?
  `).run(newJobId, prompt.trim(), latest.rev, id);

  if (markOriginal) {
    db.prepare(`UPDATE jobs SET reviewMark = 'rework' WHERE id = ?`).run(id);
  }

  return latest.rev;
});

const newRevision = createRegeneration();
```

Then update the response:

```ts
return NextResponse.json({
  success: true,
  projectId: originalJob.projectId,
  newJobId,
  revision: newRevision,
});
```

Remove the old separate `revision` query and separate `markOriginal` update.

Expected:

- Revision calculation and job creation are atomic inside this process.

## Task 7: Restore `npm run lint`

**Files:**

- Modify: `package-lock.json` only if dependency resolution changes.

- [ ] **Step 1: Reproduce lint failure**

Run:

```bash
npm run lint
```

Current observed failure:

```text
Cannot find module .../node_modules/node-exports-info/getCategoriesForRange.js
```

- [ ] **Step 2: Try clean dependency reinstall**

Do not use `npm audit fix --force`.

Run:

```bash
npm cache verify
npm install
npm run lint
```

Expected:

- If lint passes, no package changes are needed.

- [ ] **Step 3: If lint still fails, pin a working transitive resolution carefully**

Investigate `node_modules/node-exports-info` and `package-lock.json`.

If npm keeps installing `node-exports-info@1.6.0` without `getCategoriesForRange.js`, prefer pinning a known-good version through `overrides` in `package.json`:

```json
"overrides": {
  "node-exports-info": "1.5.0"
}
```

Then run:

```bash
npm install
npm run lint
npm run build
```

Expected:

- Lint reaches project files and either passes or reports real code issues.
- Build remains passing.

## Task 8: Verification Checklist

**No paid API calls.**

- [ ] **Step 1: Build**

Run:

```bash
npm run build
```

Expected:

```text
Compiled successfully
```

Note: A Turbopack tracing warning may appear. It is not the focus of this bugfix unless it becomes an error.

- [ ] **Step 2: Lint**

Run:

```bash
npm run lint
```

Expected:

```text
No ESLint errors
```

- [ ] **Step 3: Manual no-paid checks**

Run dev server:

```bash
npm run dev
```

Check:

```text
/settings
  - Enable/disable still works.
  - Set only one provider enabled still works.

/projects/new
- If Packy is selected and extra reference images are uploaded in the reference area, submitting is allowed for experimental testing.
  - If no provider is enabled, empty state is clear.
  - If enabled provider has no key, empty state is clear.
```

- [ ] **Step 4: API no-paid checks**

Use browser or curl-equivalent local requests:

```text
POST /api/projects with provider.type=packy-images and referenceImageIds non-empty
Expected: 400

POST /api/providers/{id}/activate-only
Expected: target provider enabled, all others disabled, API keys preserved
```

## Handoff Prompt For Claude Code

```text
Please continue developing /Users/liangpeijian/for-cc/batch-image-workbench.

Read outputs/2026-06-08-claude-code-bugfix-plan.md first.

Fix the review findings without running paid image generation:
1. Packy must not silently ignore extra reference images from the workbench reference upload area. Send them experimentally as repeated multipart `image` fields before the target image, and keep clear logs that this is experimental.
2. Projects with jobs in needs_check must not be marked completed.
3. Persist providerRawResponse for successful Packy/OpenAI-compatible responses.
4. Resume-poll output filenames must not overwrite existing outputs.
5. Fix Windows path handling in project image URLs.
6. Make regenerate revision calculation safer with a transaction.
7. Restore npm run lint or document the exact dependency blocker if it cannot be fixed safely.

After fixing:
- Run npm run build.
- Run npm run lint.
- Do not call GeekAI or Packy paid APIs.
- Commit changes locally with a clear message.
```

## Self-Review

- Spec coverage: Covers all confirmed review findings and verification limits.
- Placeholder scan: No TBD/TODO/implement later placeholders remain.
- Type consistency: `packy-images`, `needs_check`, `providerRawResponse`, and shared filename helper names are used consistently.
