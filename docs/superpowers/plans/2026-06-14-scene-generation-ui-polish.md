# Scene Generation UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the project page header action layout, make the scene/video generation areas communicate state clearly, fix stale refresh behavior, and make generated videos easier to preview and export.

**Architecture:** Keep all changes scoped to the existing project workbench page, result gallery, shot-set panel, video panel, log drawer, and export routes. Do not change DB schema; derive scene-reference markings from existing `scene_references.imageAssetId` and generated video exports from existing `video_jobs.localVideoPath`. Preserve existing generation, retry, queue, shot-set, video, and scene-reference APIs.

**Tech Stack:** Next.js App Router, React, Tailwind utility classes, existing SQLite-backed APIs.

---

## Current Context

Relevant files:

- `app/projects/[id]/page.tsx`
  - Owns the project workbench page.
  - Renders the project header, queue controls, scene generation form, scene results, and modals.
  - Contains `SceneResultsSection`, `SceneGenerationForm`, and `QueueCompactBar` in the same file.
- `components/ResultGallery.tsx`
  - Renders generated image cards.
  - Already supports `onSetSceneRef(jobId, imageAssetId)`.
- `app/globals.css`
  - Contains shared utility classes such as `.toolbar`, `.project-header`, `.status-badge`, and result-card styles.
- `app/api/projects/[id]/scene-references/route.ts`
  - Existing source of scene reference data.
  - Scene references include `imageAssetId`.
- `components/ShotSetPanel.tsx`
  - Renders `新分镜图` / shot-set cards.
  - Fetches expanded shot details from `/api/shot-sets/[id]`.
  - Currently refreshes expanded shots only for limited status transitions, so completed generated images can require closing/reopening before they appear.
- `app/api/shot-sets/[id]/route.ts`
  - Returns each shot with `jobStatus`, `outputImageId`, `latestGeneratedImageId`, and `generatedImageUrl`.
- `app/api/shot-sets/[id]/apply-scene/route.ts`
  - Creates one image job per shot and sets `shots.latestJobId`.
- `lib/queue.ts`
  - On image job success, writes `jobs.outputImageId` and updates `shots.latestGeneratedImageId`.
- `components/VideoGenerationPanel.tsx`
  - Owns the video generation workspace, selected shot set, selected preview job, video job polling, and right-side results panel.
- `components/VideoGenerationPreview.tsx`
  - Renders the center video player and preview controls.
- `components/VideoGenerationResults.tsx`
  - Renders the right-side generated video cards and preview/download actions.
- `components/LogDrawer.tsx`
  - Opens the run-log drawer and passes `autoRefresh` into `LogViewer`.
- `components/LogViewer.tsx`
  - Fetches `/api/projects/[id]/logs` and currently only polls when `autoRefresh` is true.
- `app/api/projects/[id]/download/route.ts`
  - Project-level `导出 ZIP` endpoint. Currently gathers succeeded image jobs only.
- `app/api/shot-sets/[id]/download/route.ts`
  - Shot-set ZIP endpoint. Already includes succeeded video files; use this as a reference for project-level ZIP behavior.
- `app/api/projects/[id]/creative-package/route.ts`
  - Creative package endpoint. Already gathers videos into `videos/`; use this as another reference for safe video path handling.
- `components/ScriptPanel.tsx`
  - Owns the script generation workflow and local step state.
  - It is mounted only when `activeTab === 'script'`, so switching to video unmounts it.
  - It should restore the latest saved `script_drafts` result when remounted.
- `app/api/projects/[id]/script/route.ts`
  - Saves generated scripts into `script_drafts` and returns drafts from `GET /api/projects/[id]/script`.

Important existing state in `app/projects/[id]/page.tsx`:

```tsx
const [queueStatus, setQueueStatus] = useState<QueueStatus>('idle');
const running = queueStatus === 'running';
const [sceneRefs, setSceneRefs] = useState<Array<{
  id: string; name: string; imageAssetId: string; imageFilename: string; status: string;
}>>([]);
```

Important existing job statuses:

```ts
pending
running
retrying
needs_check
succeeded
failed
canceled
```

---

## Task 1: Restore Project Header Actions To The Right

**Files:**

- Modify: `app/projects/[id]/page.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: Locate the project header JSX**

Find the project header near `app/projects/[id]/page.tsx:399`.

It currently has this shape:

```tsx
<div className="project-header mb-6">
  <div>
    <div className="flex flex-wrap items-center gap-3">
      ...
    </div>
    <div className="mt-1 flex flex-wrap gap-4 text-xs text-ink-secondary">
      ...
    </div>
  </div>

  <div className="flex flex-wrap gap-2">
    ...
  </div>
</div>
```

- [ ] **Step 2: Split the header into main and actions regions**

Replace the wrapper content with this structure while keeping the existing inner title, metadata, and button logic:

```tsx
<div className="project-header mb-6">
  <div className="project-header-main">
    <div className="flex flex-wrap items-center gap-3">
      <Link href="/" className="flex items-center gap-1 text-ink-tertiary hover:text-ink transition-colors">
        <Icon name="chevron-left" size={16} /> 返回
      </Link>
      <h1 className="text-xl font-semibold tracking-[-0.01em]">{project.name}</h1>
      <span className={`status-badge status-${project.status === 'partial_failed' ? 'failed' : project.status}`}>
        {STATUS_LABELS[project.status] || project.status}
      </span>
    </div>
    <div className="mt-1 flex flex-wrap gap-4 text-xs text-ink-secondary">
      <span>供应商: {project.provider?.name || '-'}</span>
      <span>模型: {project.model}</span>
      <span>任务数: {project.jobs.length}</span>
      <span>成功: {succeededJobs.length}</span>
      <span
        className="cursor-pointer hover:underline"
        onClick={() => document.querySelector('[data-section="jobs"]')?.scrollIntoView({ behavior: 'smooth' })}
        title="点击查看失败任务"
      >
        失败: {project.jobs.filter((j) => j.status === 'failed').length}
      </span>
    </div>
  </div>

  <div className="project-header-actions">
    <button onClick={() => setLogOpen(true)} className="btn-secondary">运行日志</button>
    {!running && hasPendingJobs && queueStatus !== 'paused' && (
      <button onClick={() => handleAction('start')} disabled={!!actionLoading} className="btn-primary">
        {actionLoading === 'start' ? '...' : '开始运行'}
      </button>
    )}
    {queueStatus === 'paused' && (
      <button onClick={() => handleAction('resume')} disabled={!!actionLoading} className="btn-primary">
        {actionLoading === 'resume' ? '...' : '继续运行'}
      </button>
    )}
    {running && (
      <button onClick={() => handleAction('pause')} disabled={!!actionLoading} className="btn-secondary">
        {actionLoading === 'pause' ? '...' : '暂停'}
      </button>
    )}
    {(running || queueStatus === 'paused') && (
      <button onClick={() => handleAction('cancel')} disabled={!!actionLoading} className="btn-danger">
        {actionLoading === 'cancel' ? '...' : '取消'}
      </button>
    )}
    {succeededJobs.length > 0 && (
      <>
        <button onClick={handleBatchDownload} className="btn-secondary">导出 ZIP</button>
        <button onClick={handleExportCSV} className="btn-secondary">导出 CSV</button>
      </>
    )}
    <a href={`/api/projects/${id}/creative-package`} className="btn-secondary">创意包</a>
  </div>
</div>
```

- [ ] **Step 3: Add responsive header styles**

In `app/globals.css`, replace or adjust the existing `.project-header` block to:

```css
.project-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 18px;
  padding: 0 0 18px;
  border-bottom: 1px solid var(--color-hairline-soft);
}

.project-header-main {
  min-width: 0;
}

.project-header-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 768px) {
  .project-header {
    grid-template-columns: 1fr;
  }

  .project-header-actions {
    justify-content: flex-start;
  }
}
```

- [ ] **Step 4: Verify header behavior**

Run:

```bash
npm run build
```

Expected:

- Build exits 0.
- Desktop: buttons are on the right of the project header.
- Narrow width: buttons wrap below the title instead of squeezing the title.
- Header is not sticky; only the global top bar remains sticky.

---

## Task 2: Add Clear Scene Result States

**Files:**

- Modify: `app/projects/[id]/page.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: Locate `SceneResultsSection`**

Find `SceneResultsSection` in `app/projects/[id]/page.tsx`. It currently renders the `生成结果` card and passes scene jobs into `ResultGallery`.

- [ ] **Step 2: Derive result state counts inside `SceneResultsSection`**

Add these derived values near the top of `SceneResultsSection`:

```tsx
const total = jobs.length;
const pendingCount = jobs.filter((job) => job.status === 'pending').length;
const runningCount = jobs.filter((job) => ['running', 'retrying', 'needs_check'].includes(job.status)).length;
const succeededCount = jobs.filter((job) => job.status === 'succeeded').length;
const failedCount = jobs.filter((job) => job.status === 'failed').length;
const activeCount = pendingCount + runningCount;
const isEmpty = total === 0;
const isGenerating = activeCount > 0;
const isComplete = total > 0 && activeCount === 0;
const isFailedOnly = isComplete && succeededCount === 0 && failedCount > 0;
```

- [ ] **Step 3: Replace static subtitle with state-aware copy**

In the `生成结果` header, replace the existing subtitle with:

```tsx
<p className="mt-1 text-sm text-ink-secondary">
  {isEmpty
    ? '还没有开始生成。选择原始场景图 A 后，点击生成按钮。'
    : isGenerating
      ? `正在生成 ${activeCount} 张图片，已完成 ${succeededCount}/${total}。`
      : succeededCount > 0
        ? '生成完成。挑选可用图并保存为场景参考图。'
        : '本次生成未成功，可查看失败原因或重新生成。'}
</p>
```

- [ ] **Step 4: Render the empty state**

Inside the result body, before `ResultGallery`, add:

```tsx
{isEmpty && (
  <div className="scene-result-state">
    <Icon name="image" size={32} />
    <div className="font-medium text-ink-secondary">等待生成</div>
    <div className="text-xs text-ink-tertiary">生成的场景图会出现在这里。</div>
  </div>
)}
```

If `Icon` does not currently include `image`, add it to `components/ui/Icon.tsx` or use an existing image-like icon already present in the icon map.

- [ ] **Step 5: Render the generating state**

Below the empty state, add:

```tsx
{isGenerating && (
  <div className="scene-result-state scene-result-state-active">
    <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    <div className="font-medium text-ink">生成中</div>
    <div className="text-xs text-ink-tertiary">
      已完成 {succeededCount}/{total}，剩余 {activeCount}
    </div>
  </div>
)}
```

- [ ] **Step 6: Render the completed summary and gallery**

Only render the summary/gallery when `!isEmpty && !isGenerating`.

Use:

```tsx
{!isEmpty && !isGenerating && (
  <>
    <div className="scene-result-summary">
      {succeededCount > 0 && (
        <span className="status-badge status-succeeded">成功 {succeededCount}</span>
      )}
      {failedCount > 0 && (
        <span className="status-badge status-failed">失败 {failedCount}</span>
      )}
    </div>

    {isFailedOnly ? (
      <div className="scene-result-state">
        <Icon name="alert" size={28} />
        <div className="font-medium text-ink-secondary">没有生成成功的图片</div>
        <div className="text-xs text-ink-tertiary">请查看运行日志，或调整提示词后重新生成。</div>
      </div>
    ) : (
      <ResultGallery
        jobs={jobs}
        images={project.images}
        onRetry={onRetry}
        onMark={onMark}
        onRegenerate={onRegenerate}
        onSetSceneRef={onSetSceneRef}
        projectId={project.id}
      />
    )}
  </>
)}
```

When adding this, preserve any existing props already passed to `ResultGallery`.

- [ ] **Step 7: Add result state styles**

In `app/globals.css`, add:

```css
.scene-result-state {
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px dashed var(--color-hairline);
  border-radius: var(--radius-tile);
  background: var(--color-surface-subtle);
  color: var(--color-ink-tertiary);
  text-align: center;
}

.scene-result-state-active {
  border-style: solid;
  background: #f5f9ff;
  color: var(--color-accent);
}

.scene-result-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
```

- [ ] **Step 8: Verify scene result states**

Manual checks:

- No jobs: result area shows `等待生成`.
- Pending/running jobs: result area shows `生成中` and progress counts.
- Succeeded jobs: result area shows success summary and gallery.
- Failed-only jobs: result area shows a clear failed-only message.

Run:

```bash
npm run build
```

Expected:

- Build exits 0.

---

## Task 3: Mark Images Already Saved As Scene References

**Files:**

- Modify: `app/projects/[id]/page.tsx`
- Modify: `components/ResultGallery.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: Build scene-reference image IDs in the project page**

In `app/projects/[id]/page.tsx`, after `sceneRefs` is available and before the JSX return, add:

```tsx
const sceneReferenceImageIds = new Set(sceneRefs.map((ref) => ref.imageAssetId));
```

If the variable is inside a component body and React lint complains about a new `Set` being recreated every render, use `useMemo`:

```tsx
const sceneReferenceImageIds = useMemo(
  () => new Set(sceneRefs.map((ref) => ref.imageAssetId)),
  [sceneRefs]
);
```

If using `useMemo`, make sure it is imported:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
```

- [ ] **Step 2: Pass scene-reference IDs through `SceneResultsSection`**

Add a prop to `SceneResultsSection`:

```tsx
sceneReferenceImageIds: Set<string>;
```

Pass it where `SceneResultsSection` is rendered:

```tsx
<SceneResultsSection
  ...
  sceneReferenceImageIds={sceneReferenceImageIds}
/>
```

Then pass it into `ResultGallery`:

```tsx
<ResultGallery
  ...
  sceneReferenceImageIds={sceneReferenceImageIds}
/>
```

- [ ] **Step 3: Add the prop to `ResultGallery`**

In `components/ResultGallery.tsx`, update the props interface:

```tsx
interface Props {
  ...
  sceneReferenceImageIds?: Set<string>;
}
```

Update the component signature:

```tsx
export default function ResultGallery({
  jobs,
  images,
  onMark,
  onRegenerate,
  onSetSceneRef,
  projectId,
  sceneReferenceImageIds,
}: Props) {
  ...
}
```

Preserve any existing props in the file. Do not remove unrelated props such as `onRetry` if the file already uses them.

- [ ] **Step 4: Compute whether each card is already a scene reference**

Inside the card rendering loop in `ResultGallery`, add:

```tsx
const isSceneReference = !!job.outputImageId && sceneReferenceImageIds?.has(job.outputImageId);
```

Place it near other per-job derived values such as status checks.

- [ ] **Step 5: Add a visible badge to scene-reference cards**

Inside the thumbnail/card visual area, add:

```tsx
{isSceneReference && (
  <span className="scene-ref-badge">
    <Icon name="check" size={12} />
    已设为场景参考
  </span>
)}
```

The badge should be positioned inside a relatively positioned thumbnail/card container. If the current thumbnail container is not `position: relative`, add `relative` to its className or use the existing `.result-thumb` positioning.

- [ ] **Step 6: Replace duplicate scene-reference action**

Where `ResultGallery` renders the `设为场景参考图` action, change it to:

```tsx
{isSceneReference ? (
  <span className="result-action text-ok">
    <Icon name="check" size={13} />
    已设为场景参考
  </span>
) : (
  onSetSceneRef && job.outputImageId && (
    <button
      onClick={() => onSetSceneRef(job.id, job.outputImageId!)}
      className="result-action text-accent"
    >
      <Icon name="video" size={14} />
      设为场景参考图
    </button>
  )
)}
```

If the current action is inside a detail modal rather than each card, apply the same conditional there too.

- [ ] **Step 7: Add scene-reference badge styles**

In `app/globals.css`, add:

```css
.scene-ref-badge {
  position: absolute;
  left: 8px;
  top: 8px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: rgba(27,142,77,.92);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  box-shadow: 0 4px 12px rgba(0,0,0,.12);
}
```

- [ ] **Step 8: Verify scene-reference markers**

Manual checks:

- Save one generated image as a scene reference.
- The same image shows `已设为场景参考`.
- Reload the page.
- The badge is still visible.
- Other generated images do not show the badge.
- The action is not repeated as a normal primary action for images already saved as references.

Run:

```bash
npm run build
```

Expected:

- Build exits 0.

---

## Task 4: Fix Shot-Set Result Refresh After Generation

**Files:**

- Modify: `components/ShotSetPanel.tsx`
- Review: `app/api/shot-sets/[id]/route.ts`
- Review: `lib/queue.ts`

- [ ] **Step 1: Reproduce the stale shot-set result bug**

Manual reproduction:

- Open a project page.
- Expand one `新分镜图` shot set.
- Choose or confirm a scene reference image.
- Click `生成分镜`.
- Keep the shot-set panel open while jobs run.

Expected current bug:

- Backend logs and downloads show the images are generated successfully.
- Some cards still show `生成中` / `等待中` or blank result slots.
- Collapsing/reopening the panel or leaving/reentering the page makes the completed images appear.

- [ ] **Step 2: Include output image changes in the job fingerprint**

In `components/ShotSetPanel.tsx`, update the parent-job fingerprint so a job finishing with an `outputImageId` triggers a refresh even if the visible status value was already seen:

```tsx
const jobsFingerprint = useMemo(
  () => (jobs || []).map((j) => `${j.id}:${j.status}:${j.outputImageId || ''}`).join(','),
  [jobs]
);
```

- [ ] **Step 3: Refresh expanded shot details when parent jobs change**

Keep `loadSets()` so list-level counts update, but also refetch all currently expanded shot sets:

```tsx
useEffect(() => {
  loadSets();
  Array.from(expandedIdsRef.current).forEach((setId) => {
    loadShots(setId, true);
  });
}, [jobsFingerprint, loadSets, loadShots]);
```

Remove the current exhaustive-deps disable for this effect if it is no longer needed. The dependency list should be honest.

- [ ] **Step 4: Treat all active queue statuses as still generating**

Define one shared active-status helper near the other status constants:

```tsx
const ACTIVE_JOB_STATUSES = new Set(['pending', 'running', 'retrying', 'needs_check']);
```

Use it anywhere the shot-set UI decides a shot is still active. At minimum update:

- The polling effect that builds `activeSetIds`.
- The per-card `generating` boolean.
- Any label fallback that currently treats only `running` as `生成中`.

Current statuses to cover:

```ts
pending
running
retrying
needs_check
succeeded
failed
canceled
```

- [ ] **Step 5: Keep polling until expanded active sets become terminal**

Update the polling effect so it polls expanded sets while any shot in the expanded set has an active status from `ACTIVE_JOB_STATUSES`.

Important details:

- Use `shot.jobStatus` from `/api/shot-sets/[id]` when present.
- Fall back to `jobs?.find((j) => j.id === shot.latestJobId)?.status` when `shot.jobStatus` is missing.
- On each polling tick, call `loadShots(setId, true)` for active expanded sets.
- After a tick, call `loadSets()` or `onShotChanged?.()` so generated counts and parent-level status summaries also refresh.

Do not rely on closing/reopening the panel to fetch the final `latestGeneratedImageId`.

- [ ] **Step 6: Keep placeholders accurate during and after generation**

For each shot card:

- Active status: show `生成中`.
- `pending`: show `等待中` only before actual running starts.
- `succeeded` with `generatedImageUrl` or `latestGeneratedImageId`: show the generated image immediately.
- `succeeded` without a result image: show a clear non-crashing fallback such as `生成完成，图片同步中`.
- `failed`: show `失败`.

- [ ] **Step 7: Verify the refresh fix**

Manual checks:

- Start `生成分镜` with the panel already expanded.
- Generated images appear in the open panel as each job finishes.
- The top count changes from `生成中` to completed counts without reopening the panel.
- Refresh still works when jobs enter `retrying` or `needs_check`.
- Re-expanding the set still fetches the latest state.

Run:

```bash
npm run build
```

Expected:

- Build exits 0.

---

## Task 5: Fix `EmptyRanges` Runtime Overlay When Generating Shot Sets

**Files:**

- Investigate: `components/ShotSetPanel.tsx`
- Investigate: `app/projects/[id]/page.tsx`
- Investigate: `components/HoverZoomImage.tsx`
- Investigate: `components/AssetUploadGrid.tsx`
- Investigate: browser console / Next.js dev overlay stack trace

- [ ] **Step 1: Reproduce and capture the real stack trace**

Manual reproduction:

- Open the project page in dev mode.
- Trigger `生成分镜`.
- Confirm whether the Next.js runtime overlay appears immediately.

Observed error from screenshot:

```text
Runtime ReferenceError
Can't find variable: EmptyRanges
```

Use the overlay controls or browser console to capture the stack trace. Do not guess the fix from the variable name alone.

- [ ] **Step 2: Search for direct and indirect references**

Run:

```bash
rg -n "EmptyRanges|Range|Selection|document\\.getSelection|window\\.getSelection|selectionStart|selectionEnd|setSelectionRange" app components lib
```

Current local search shows no direct `EmptyRanges` reference in app code, so the stack trace is required to identify whether this is:

- A typo or undefined identifier in a nearby component after transformation.
- A stale Turbopack/dev overlay artifact.
- A browser-only API path triggered by the generation click.
- A third-party/dev-runtime issue exposed by stale compiled output.

- [ ] **Step 3: If the stack points into app code, fix the exact undefined reference**

If the stack trace points into a project file:

- Open the exact source file and line.
- Replace the undefined `EmptyRanges` reference with the intended value or a guarded branch.
- Prefer explicit empty arrays/objects or null checks over relying on implicit globals.
- Add a small defensive guard if the code touches DOM selection/ranges in the browser.

Examples of acceptable fixes depending on the stack:

```tsx
const ranges: Range[] = [];
```

or:

```tsx
const selection = typeof window !== 'undefined' ? window.getSelection() : null;
if (!selection || selection.rangeCount === 0) return;
```

Do not add a global `EmptyRanges` shim unless the stack proves a dependency requires it and there is no cleaner local fix.

- [ ] **Step 4: If the stack only points to stale Turbopack/dev runtime, clear stale build output**

If no app code appears in the stack and the error disappears after a clean dev restart, document that finding in the implementation notes and clean the local dev cache:

```bash
rm -rf .next
npm run dev
```

Then retry the same `生成分镜` flow.

- [ ] **Step 5: Verify no overlay appears during generation**

Manual checks:

- Clicking `生成分镜` does not show the Next.js overlay.
- The shot-set panel remains usable while background jobs run.
- The refresh fix from Task 4 still updates cards as jobs finish.
- Browser console has no new uncaught `ReferenceError`.

Run:

```bash
npm run build
```

Expected:

- Build exits 0.

---

## Task 6: Fix Video Workspace With A Fixed Center Preview And Scrollable Side Rails

**Files:**

- Modify: `app/globals.css`
- Review: `components/VideoGenerationPanel.tsx`
- Review: `components/VideoGenerationPreview.tsx`
- Review: `components/VideoGenerationResults.tsx`

- [ ] **Step 1: Reproduce the oversized black preview workspace**

Manual reproduction:

- Open the project page.
- Go to the `视频生成` tab.
- Select a shot set with completed videos.
- Click a completed video on the right.
- Generate or wait for more videos to complete so the right-side list grows.

Expected current bug:

- The center preview column becomes a large black area.
- The right-side result list stretches the whole workspace height.
- The actual video is harder to inspect because the main preview is no longer a stable stage.

- [ ] **Step 2: Change the video workspace into a fixed-height three-column workbench**

In `app/globals.css`, replace the current video workspace block:

```css
.video-generation-section { overflow: hidden; }
.video-workspace { display: grid; grid-template-columns: minmax(260px, 320px) minmax(360px, 1fr) minmax(230px, 280px); gap: 14px; align-items: stretch; width: 100%; min-height: clamp(500px, calc(100vh - 380px), 680px); }
.video-workspace > .panel-col { min-width: 0; min-height: 0; background: var(--color-surface-subtle); border: 1px solid var(--color-hairline-soft); border-radius: var(--radius-tile); padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
.video-workspace > .video-preview-col { padding: 0; overflow: hidden; background: #000; }
.video-preview-shell { min-width: 0; min-height: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-start; background: #000; }
.video-stage { flex: 0 0 auto; width: 100%; aspect-ratio: 16 / 9; min-height: 360px; max-height: min(560px, calc(100vh - 280px)); display: flex; align-items: center; justify-content: center; background: #000; position: relative; overflow: hidden; }
.video-stage video, .video-stage img, .video-stage .video-player { width: 100%; height: 100%; object-fit: contain; background: #000; }
.video-preview-shell::after { content: ""; flex: 1 1 auto; min-height: 0; background: #000; }
```

with:

```css
.video-generation-section { overflow: hidden; }

.video-workspace {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(420px, 1fr) minmax(230px, 280px);
  gap: 14px;
  align-items: start;
  width: 100%;
  height: clamp(560px, calc(100vh - 250px), 760px);
  min-height: 0;
}

.video-workspace > .panel-col {
  min-width: 0;
  min-height: 0;
  max-height: 100%;
  background: var(--color-surface-subtle);
  border: 1px solid var(--color-hairline-soft);
  border-radius: var(--radius-tile);
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.video-workspace > .video-preview-col {
  padding: 0;
  overflow: visible;
  background: transparent;
  border-color: transparent;
}

.video-preview-shell {
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: auto;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  background: transparent;
}

.video-stage {
  flex: 0 0 auto;
  width: 100%;
  aspect-ratio: 16 / 9;
  min-height: 0;
  max-height: min(560px, calc(100vh - 320px));
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-tile) var(--radius-tile) 0 0;
}

.video-stage video,
.video-stage img,
.video-stage .video-player {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.video-preview-shell::after {
  display: none;
}

.stage-controls {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(0,0,0,.85);
  color: #fff;
  font-size: 0.75rem;
  border-radius: 0 0 var(--radius-tile) var(--radius-tile);
}
```

Keep `object-fit: contain` so generated videos are not cropped. The goal is to keep the main player stable while left and right panels scroll independently.

- [ ] **Step 3: Preserve mobile behavior**

Update the current media rules:

```css
@media (max-width: 1024px) {
  .video-workspace { grid-template-columns: 1fr; width: 100%; margin-left: 0; transform: none; min-height: auto; }
  .video-workspace > .center-col { order: -1; }
  .video-stage { max-height: none; min-height: 320px; }
}

@media (max-width: 640px) {
  .video-workspace { gap: 12px; }
  .video-workspace > .panel-col { padding: 14px; border-radius: var(--radius-tile); }
  .video-workspace > .video-preview-col { padding: 0; }
  .video-stage { aspect-ratio: 16 / 9; min-height: 260px; }
  .stage-controls { flex-wrap: wrap; }
}
```

to:

```css
@media (max-width: 1024px) {
  .video-workspace {
    grid-template-columns: 1fr;
    width: 100%;
    height: auto;
    min-height: auto;
    margin-left: 0;
    transform: none;
  }

  .video-workspace > .center-col {
    order: -1;
  }

  .video-workspace > .panel-col {
    max-height: none;
    overflow-y: visible;
  }

  .video-workspace > .video-preview-col {
    overflow: visible;
  }

  .video-stage {
    max-height: none;
    min-height: 0;
  }
}

@media (max-width: 640px) {
  .video-workspace {
    gap: 12px;
  }

  .video-workspace > .panel-col {
    padding: 14px;
    border-radius: var(--radius-tile);
  }

  .video-workspace > .video-preview-col {
    padding: 0;
  }

  .video-stage {
    aspect-ratio: 16 / 9;
    min-height: 0;
  }

  .stage-controls {
    flex-wrap: wrap;
  }
}
```

- [ ] **Step 4: Verify fixed-center and side scrolling behavior**

Manual checks:

- The center player stays at a fixed, inspectable size.
- Left parameter controls scroll inside the left rail when content is tall.
- Right video result cards scroll inside the right rail as more videos complete.
- The right rail no longer stretches the center preview into a large black box.
- The stage controls stay directly under the visible video.
- Mobile layout still stacks preview above the side panels and uses normal page scrolling.

Run:

```bash
npm run build
```

Expected:

- Build exits 0.

---

## Task 7: Make Right-Side Video Thumbnails Play In The Center Immediately

**Files:**

- Modify: `components/VideoGenerationPanel.tsx`
- Modify: `components/VideoGenerationPreview.tsx`
- Modify: `components/VideoGenerationResults.tsx`

- [ ] **Step 1: Replace preview toggle behavior with select-and-play behavior**

In `components/VideoGenerationPanel.tsx`, add a play signal state near `videoPreviewJobId`:

```tsx
const [videoPreviewJobId, setVideoPreviewJobId] = useState<string | null>(null);
const [videoPreviewPlaySignal, setVideoPreviewPlaySignal] = useState(0);
```

Add a helper:

```tsx
const selectVideoPreview = (jobId: string) => {
  previewSuppressedRef.current = false;
  setVideoPreviewJobId(jobId);
  setVideoPreviewPlaySignal((value) => value + 1);
};
```

- [ ] **Step 2: Use the helper for preview navigation**

In the `VideoGenerationPreview` props, change:

```tsx
onNavigate={(jobId) => {
  previewSuppressedRef.current = false;
  setVideoPreviewJobId(jobId);
}}
```

to:

```tsx
onNavigate={selectVideoPreview}
playSignal={videoPreviewPlaySignal}
```

Keep `onClose` as the only way to close the center preview:

```tsx
onClose={() => {
  previewSuppressedRef.current = true;
  setVideoPreviewJobId(null);
}}
```

- [ ] **Step 3: Make right-side cards always select and play**

In `components/VideoGenerationPanel.tsx`, change the `VideoGenerationResults` `onPreview` prop from toggle behavior:

```tsx
onPreview={(jobId) => {
  if (videoPreviewJobId === jobId) {
    previewSuppressedRef.current = true;
    setVideoPreviewJobId(null);
  } else {
    previewSuppressedRef.current = false;
    setVideoPreviewJobId(jobId);
  }
}}
```

to:

```tsx
onPreview={selectVideoPreview}
```

- [ ] **Step 4: Add auto-play support to the center player**

In `components/VideoGenerationPreview.tsx`, change the import:

```tsx
import { useRef } from 'react';
```

to:

```tsx
import { useEffect, useRef } from 'react';
```

Add `playSignal` to props:

```tsx
interface Props {
  videoUrl: string | null;
  posterUrl?: string | null;
  placeholderText: string;
  videoJobs: VideoJob[];
  currentJobId: string | null;
  playSignal: number;
  onNavigate: (jobId: string) => void;
  onClose: () => void;
}
```

Update the function signature:

```tsx
export default function VideoGenerationPreview({
  videoUrl,
  posterUrl,
  placeholderText,
  videoJobs,
  currentJobId,
  playSignal,
  onNavigate,
  onClose,
}: Props) {
```

Add this effect after `currentIndex`:

```tsx
useEffect(() => {
  if (!videoUrl || !videoRef.current) return;
  const video = videoRef.current;
  video.currentTime = 0;
  const playPromise = video.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      // Browser autoplay policy can still block playback in rare cases.
      // Controls remain visible, so the user can play manually.
    });
  }
}, [videoUrl, currentJobId, playSignal]);
```

Update the `<video>` element:

```tsx
<video
  key={videoUrl}
  ref={videoRef}
  src={videoUrl}
  poster={posterUrl || undefined}
  controls
  autoPlay
  playsInline
  className="video-player"
/>
```

- [ ] **Step 5: Rename the right-side preview action**

In `components/VideoGenerationResults.tsx`, keep the active card styling, but change the action label:

```tsx
{isActive ? '正在播放' : '播放'}
```

Do not use the right-side action as `收起`; closing belongs to the center preview close button.

- [ ] **Step 6: Verify thumbnail play behavior**

Manual checks:

- Clicking a completed video thumbnail on the right selects that card.
- The video appears in the center player.
- Playback starts automatically after the click.
- Clicking the same thumbnail again restarts playback instead of closing the preview.
- The center close button still hides the preview when needed.

Run:

```bash
npm run build
```

Expected:

- Build exits 0.

---

## Task 8: Keep Run Logs Live While The Drawer Is Open

**Files:**

- Modify: `app/projects/[id]/page.tsx`
- Modify: `components/LogViewer.tsx`
- Review: `components/LogDrawer.tsx`

- [ ] **Step 1: Reproduce the frozen log drawer**

Manual reproduction:

- Open `运行日志`.
- Start or wait for video generation.
- Leave the drawer open.

Expected current bug:

- Logs can stay fixed until the user clicks `刷新`.
- This is especially visible for video generation because `autoRefresh` is driven by image job state from `project.jobs`.

- [ ] **Step 2: Always auto-refresh while the drawer is open**

In `app/projects/[id]/page.tsx`, replace:

```tsx
<LogDrawer open={logOpen} projectId={project.id} autoRefresh={running || hasActiveJobs} onClose={() => setLogOpen(false)} />
```

with:

```tsx
<LogDrawer open={logOpen} projectId={project.id} autoRefresh={logOpen} onClose={() => setLogOpen(false)} />
```

`LogDrawer` returns `null` when closed, so this only polls while the drawer is visible.

- [ ] **Step 3: Trigger an immediate refresh when auto-refresh turns on**

In `components/LogViewer.tsx`, update the auto-refresh effect from:

```tsx
useEffect(() => {
  if (!autoRefresh) return;
  const interval = setInterval(loadLogs, refreshMs);
  return () => clearInterval(interval);
}, [autoRefresh, loadLogs, refreshMs]);
```

to:

```tsx
useEffect(() => {
  if (!autoRefresh) return;
  loadLogs();
  const interval = setInterval(loadLogs, refreshMs);
  return () => clearInterval(interval);
}, [autoRefresh, loadLogs, refreshMs]);
```

- [ ] **Step 4: Keep the UI label accurate**

`LogViewer` already shows `实时刷新中` when `autoRefresh` is true. Confirm the label appears whenever the drawer is open.

- [ ] **Step 5: Verify log refresh**

Manual checks:

- Open logs during image generation: new lines appear without clicking `刷新`.
- Open logs during video generation: new lines appear without clicking `刷新`.
- The drawer does not poll after it is closed.
- Manual `刷新` still works.

Run:

```bash
npm run build
```

Expected:

- Build exits 0.

---

## Task 9: Include Generated Videos In Project ZIP Export

**Files:**

- Modify: `app/api/projects/[id]/download/route.ts`
- Review: `app/api/shot-sets/[id]/download/route.ts`
- Review: `app/api/projects/[id]/creative-package/route.ts`
- Review: `lib/zip-download.ts`

- [ ] **Step 1: Reproduce the ZIP export gap**

Manual reproduction:

- Generate at least one scene image and at least one video.
- Click project header `导出 ZIP`.
- Open the downloaded ZIP.

Expected current bug:

- ZIP includes generated images.
- ZIP does not include generated videos.

- [ ] **Step 2: Switch project ZIP to the generic ZIP stream**

In `app/api/projects/[id]/download/route.ts`, change the import:

```ts
import { buildZipStream, ZipImageEntry } from '@/lib/zip-download';
```

to:

```ts
import { buildGenericZipStream, ZipImageEntry } from '@/lib/zip-download';
```

- [ ] **Step 3: Keep existing generated image entries**

Leave the existing image query in place, but rename `rows` to `imageRows` for clarity:

```ts
const imageRows = db.prepare(`
  SELECT oa.path as filePath, oa.filename as filename, ia.filename as inputFilename, j.revision
  FROM jobs j
  JOIN image_assets oa ON oa.id = j.outputImageId
  LEFT JOIN image_assets ia ON ia.id = j.inputImageId
  WHERE j.projectId = ? AND j.status = 'succeeded' AND j.outputImageId IS NOT NULL
  ORDER BY ia.filename, j.revision, j.id
`).all(id) as Array<{ filePath: string; filename: string; inputFilename: string | null; revision: number | null }>;
```

Build entries from images:

```ts
const entries: ZipImageEntry[] = imageRows.map((row, index) => ({
  filePath: row.filePath,
  filename: `images/${row.filename || `${String(index + 1).padStart(2, '0')}-${row.inputFilename || 'output'}.png`}`,
}));
```

- [ ] **Step 4: Add succeeded generated videos**

Below the image entries, add:

```ts
const videoRows = db.prepare(`
  SELECT vj.filename, vj.localVideoPath, vj.createdAt,
         s.indexNum, ss.name as shotSetName,
         vp.name as providerName, vpt.name as templateName
  FROM video_jobs vj
  LEFT JOIN shots s ON s.id = vj.shotId
  LEFT JOIN shot_sets ss ON ss.id = vj.shotSetId
  LEFT JOIN video_providers vp ON vp.id = vj.providerId
  LEFT JOIN video_prompt_templates vpt ON vpt.id = vj.templateId
  WHERE vj.projectId = ? AND vj.status = 'succeeded' AND vj.localVideoPath IS NOT NULL
  ORDER BY ss.createdAt, s.indexNum, vj.createdAt
`).all(id) as Array<{
  filename: string | null;
  localVideoPath: string;
  createdAt: string;
  indexNum: number | null;
  shotSetName: string | null;
  providerName: string | null;
  templateName: string | null;
}>;

videoRows.forEach((row, index) => {
  const shotPart = row.indexNum ? `shot-${String(row.indexNum).padStart(2, '0')}` : `video-${String(index + 1).padStart(2, '0')}`;
  const providerPart = row.providerName || 'provider';
  const templatePart = row.templateName || 'custom';
  entries.push({
    filePath: row.localVideoPath,
    filename: `videos/${shotPart}-${providerPart}-${templatePart}-${row.filename || 'video.mp4'}`,
  });
});
```

`buildGenericZipStream` already resolves and includes non-image extensions through `assertStoragePath`.

- [ ] **Step 5: Update the empty ZIP error**

Replace:

```ts
if (rows.length === 0) {
  return NextResponse.json({ error: 'No generated images to download' }, { status: 404 });
}
```

with:

```ts
if (entries.length === 0) {
  return NextResponse.json({ error: 'No generated images or videos to download' }, { status: 404 });
}
```

- [ ] **Step 6: Use the generic ZIP stream**

Replace:

```ts
const stream = buildZipStream(entries);
```

with:

```ts
const stream = buildGenericZipStream(entries);
```

- [ ] **Step 7: Verify ZIP content**

Manual checks:

- Project ZIP with only images still downloads and contains `images/`.
- Project ZIP with images and videos contains both `images/` and `videos/`.
- Project ZIP with only videos still downloads and contains `videos/`.
- Video files open from the extracted ZIP.
- Shot-set ZIP behavior still works.

Run:

```bash
npm run build
```

Expected:

- Build exits 0.

---

## Task 10: Persist And Restore Script Generation After Switching Tabs

**Files:**

- Modify: `components/ScriptPanel.tsx`
- Review: `app/api/projects/[id]/script/route.ts`
- Review: `app/projects/[id]/page.tsx`

- [ ] **Step 1: Reproduce the script result loss**

Manual reproduction:

- Open a complex project.
- Go to `脚本生成`.
- Generate a script until the result appears.
- Go to `视频生成` and operate there.
- Return to `脚本生成`.

Expected current bug:

- The previously generated script result is missing or the panel returns to an earlier step.
- The user cannot trust that completed script work is still available after video operations.

- [ ] **Step 2: Confirm whether the draft is saved in the API**

Open browser devtools or use the terminal and request:

```bash
curl "http://localhost:3000/api/projects/<PROJECT_ID>/script"
```

Expected JSON shape:

```json
{
  "drafts": [
    {
      "id": "...",
      "provider": "...",
      "model": "...",
      "inputSnapshot": "...",
      "outputJson": "...",
      "createdAt": "..."
    }
  ],
  "analysis": null
}
```

If `drafts` is empty immediately after a successful script generation, fix `app/api/projects/[id]/script/route.ts` first. The `handleGenerate` path must insert a row into `script_drafts` before returning success.

- [ ] **Step 3: Make `ScriptPanel` always restore the newest draft on mount**

In `components/ScriptPanel.tsx`, move the existing `loadShotImages` callback above `loadAll`, then add this helper below `loadShotImages` and above `loadAll`:

```tsx
const restoreLatestDraft = useCallback(async (draftList: ScriptDraft[]) => {
  if (draftList.length === 0) return false;

  const latest = draftList[0];
  setDrafts(draftList);
  setSelectedDraftId(latest.id);

  try {
    const parsed = JSON.parse(latest.outputJson) as ScriptOutput;
    setScript(parsed);
    setStep(3);
    if (parsed.shotSetId) {
      await loadShotImages(parsed.shotSetId);
    }
    return true;
  } catch {
    return false;
  }
}, [loadShotImages]);
```

This keeps the dependency order clear: `loadShotImages` is defined first, then `restoreLatestDraft`, then `loadAll`.

- [ ] **Step 4: Replace one-time `initialLoadDone` restoration**

The current draft restoration is guarded by:

```tsx
if (!initialLoadDone.current) {
  initialLoadDone.current = true;
  const first = draftData.drafts[0] as ScriptDraft;
  setSelectedDraftId(first.id);
  try {
    const parsed = JSON.parse(first.outputJson) as ScriptOutput;
    setScript(parsed);
    setStep(3);
    if (parsed.shotSetId) {
      void loadShotImages(parsed.shotSetId);
    }
  } catch { /* ignore */ }
}
```

Replace that block with:

```tsx
await restoreLatestDraft(draftData.drafts as ScriptDraft[]);
initialLoadDone.current = true;
```

The panel is unmounted when leaving the script tab, so restoring the newest persisted draft on each mount is the desired behavior. Do not let a stale local ref prevent restoration.

- [ ] **Step 5: Preserve in-progress local edits only within the current mount**

Do not add localStorage persistence for half-written prompts in this task. The user-reported bug is about generated script work disappearing after video operations, and generated scripts already have a database table.

Keep these as local state:

- Unsaved selling-point edits.
- Temporary strategy selections before generating.
- Current draft selector state after the newest draft has loaded.

- [ ] **Step 6: Keep draft selector working**

Update `handleSelectDraft` only if needed so it shares the same parse-and-restore behavior:

```tsx
const handleSelectDraft = useCallback((draftId: string) => {
  const draft = drafts.find((d) => d.id === draftId);
  if (!draft) return;

  setSelectedDraftId(draftId);
  try {
    const parsed = JSON.parse(draft.outputJson) as ScriptOutput;
    setScript(parsed);
    setStep(3);
    if (parsed.shotSetId) {
      void loadShotImages(parsed.shotSetId);
    }
  } catch {
    alert('脚本草稿解析失败，请选择其他草稿或重新生成。');
  }
}, [drafts, loadShotImages]);
```

- [ ] **Step 7: Verify script persistence**

Manual checks:

- Generate a script and wait for the result.
- Switch to `视频生成`.
- Create or preview videos.
- Switch back to `脚本生成`.
- The latest script result is still visible.
- Reload the page and open `脚本生成`.
- The latest script result is still visible.
- If multiple drafts exist, the selector still loads older drafts.

Run:

```bash
npm run build
```

Expected:

- Build exits 0.

---

## Task 11: Final Verification

**Files:**

- Review: `app/projects/[id]/page.tsx`
- Review: `components/ResultGallery.tsx`
- Review: `components/ShotSetPanel.tsx`
- Review: `components/ScriptPanel.tsx`
- Review: `components/VideoGenerationPanel.tsx`
- Review: `components/VideoGenerationPreview.tsx`
- Review: `components/VideoGenerationResults.tsx`
- Review: `components/LogViewer.tsx`
- Review: `app/api/projects/[id]/script/route.ts`
- Review: `app/api/projects/[id]/download/route.ts`
- Review: `app/globals.css`

- [ ] **Step 1: Run production build**

Run:

```bash
npm run build
```

Expected:

- Build exits 0.
- Existing Turbopack tracing warning may remain:

```text
Encountered unexpected file in NFT list
```

Do not treat that warning as a failure unless new build errors appear.

- [ ] **Step 2: Run lint if requested by the user**

Run:

```bash
npm run lint
```

Expected:

- The repository may already have unrelated lint failures.
- Confirm no new lint errors are introduced in:
  - `app/projects/[id]/page.tsx`
  - `components/ResultGallery.tsx`
  - `components/ScriptPanel.tsx`
  - `components/VideoGenerationPanel.tsx`
  - `components/VideoGenerationPreview.tsx`
  - `components/VideoGenerationResults.tsx`
  - `components/LogViewer.tsx`
  - `app/api/projects/[id]/script/route.ts`
  - `app/globals.css`

- [ ] **Step 3: Manual desktop UI check**

Open a project page and check:

- Project action buttons are right-aligned.
- Project title and metadata are not squeezed by the buttons.
- Scrolling no longer creates a split sticky toolbar.
- Empty scene result panel says `等待生成`.
- Generating scene result panel says `生成中` and shows progress counts.
- Completed scene result panel shows success/failed counts.
- Scene-reference images show a clear `已设为场景参考` badge.
- Shot-set generated images appear automatically after background jobs finish.
- Clicking `生成分镜` does not trigger `Can't find variable: EmptyRanges`.
- Video preview does not become a tall black box when new videos complete.
- Clicking a right-side video thumbnail plays it in the center automatically.
- Generated scripts remain visible after switching from `脚本生成` to `视频生成` and back.
- Running logs update without manual refresh while the drawer is open.
- Project `导出 ZIP` includes generated videos as well as generated images.

- [ ] **Step 4: Manual narrow-width UI check**

Resize the page to a narrow/mobile width and check:

- Project actions wrap below the title.
- Buttons remain readable.
- Scene result state cards do not overflow.
- Scene-reference badge does not cover important image content too aggressively.
- Shot-set cards keep stable dimensions while placeholders change to generated images.
- Video workspace stacks cleanly and the center preview remains usable on narrow widths.

---

## Notes For The Implementing Agent

- Do not change the database schema for this work.
- Do not change API behavior unless a missing field blocks the UI.
- Prefer deriving scene-reference state from `sceneRefs.map((ref) => ref.imageAssetId)`.
- Keep changes visually consistent with the current Apple-like UI direction: light surfaces, subtle borders, clear status, restrained color.
- Preserve unrelated in-progress work in the tree. This repository may already have many modified or untracked files.
