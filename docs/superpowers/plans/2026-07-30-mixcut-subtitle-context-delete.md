# Mixcut Subtitle Context Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent “删除字幕” context-menu action to Mixcut subtitle blocks in both select and split modes.

**Architecture:** Extend the existing `MixcutTimeline` discriminated context-menu state with a subtitle branch and route deletion through the existing `onGroupCommand` queue. Keep persistence, revision handling, errors, and subtitle storage unchanged because `delete_subtitle_cue` is already implemented by the final-edit workspace.

**Tech Stack:** Next.js 16, React 19, TypeScript strict mode, Playwright, Node `assert`, ESLint.

---

## File map

- Modify `components/mixcut/MixcutTimeline.tsx`: open a subtitle context menu, prevent right-click from activating split/drag behavior, submit `delete_subtitle_cue`, and clear a deleted selection after acceptance.
- Modify `components/mixcut/PreviewStep.tsx`: update the visible operation hint so subtitle deletion is discoverable.
- Modify `scripts/final-edit-mixcut-ui-contract.test.mjs`: lock the subtitle menu type, accessible label, callback wiring, and delete command into the static UI contract.
- Modify `scripts/final-edit-mixcut.playwright.test.mjs`: make the mock group route persist subtitle deletion and exercise the full split → right-click → delete flow.

No backend, database, CSS, or shared command-type file changes are required.

## Worktree safety

At plan-writing time, unrelated BGM work is already present in `MixcutTimeline.tsx`, `PreviewStep.tsx`, and `final-edit-mixcut-ui-contract.test.mjs`. Preserve these exact edits: the BGM empty-waveform rendering, cross-group import messaging, and associated UI contract assertions. Apply only the subtitle-context-menu hunks described below; never restore, overwrite, or stage an entire overlapping file without rechecking its diff.

### Task 1: Add failing contract and browser coverage

**Files:**
- Modify: `scripts/final-edit-mixcut-ui-contract.test.mjs:119`
- Modify: `scripts/final-edit-mixcut.playwright.test.mjs:426-490`
- Modify: `scripts/final-edit-mixcut.playwright.test.mjs:960-997`

- [ ] **Step 1: Add static contract assertions for the subtitle context-menu branch**

Replace the existing context-menu assertion in `scripts/final-edit-mixcut-ui-contract.test.mjs` with these explicit requirements:

```js
assert.match(timeline, /\| \{ kind: 'subtitle'; cueId: string; x: number; y: number \}/, '时间线上下文菜单必须能绑定具体字幕 Cue');
assert.match(timeline, /onOpenContextMenu=\{\(clientX, clientY\) => setContextMenu\(\{[\s\S]{0,180}kind: 'subtitle'[\s\S]{0,120}cueId: cue\.id/, '字幕块必须把右键坐标和 Cue ID 传给共享菜单');
assert.match(timeline, /contextMenu\.kind === 'narration' \? 'dialog' : 'menu'/, '视频和字幕使用 menu 语义，只有口播调速使用 dialog');
assert.match(timeline, /contextMenu\.kind === 'subtitle' \? '字幕操作'/, '字幕菜单必须提供独立可访问名称');
assert.match(timeline, /type: 'delete_subtitle_cue', cueId/, '字幕菜单必须通过现有原子 group command 持久化删除');
```

- [ ] **Step 2: Teach the Playwright mock route to persist the existing delete command**

Add this branch immediately after the `split_subtitle_cue` branch in the mocked group `PATCH` route:

```js
} else if (body.type === 'delete_subtitle_cue') {
  const cueIndex = savedGroup.subtitleCues.findIndex((cue) => cue.id === body.cueId);
  assert.ok(cueIndex >= 0, 'delete command cue must exist');
  savedGroup = {
    ...savedGroup,
    revision: savedGroup.revision + 1,
    subtitleCues: savedGroup.subtitleCues.filter((cue) => cue.id !== body.cueId),
  };
```

This is test-fixture behavior only; production persistence already exists in `lib/final-edit/workspace.ts`.

- [ ] **Step 3: Add the split-mode right-click deletion scenario**

In `scripts/final-edit-mixcut.playwright.test.mjs`, after the first split has produced three Cue blocks and before switching back to the select tool, insert:

```js
const splitCueId = 'cue-a-left';
const splitCue = page.locator(`[data-cue-id="${splitCueId}"]`);
const splitWritesBeforeRightClick = groupPatchBodies.filter((body) => body.type === 'split_subtitle_cue').length;
const playheadBeforeSubtitleRightClick = await page.getByRole('button', { name: '拖动播放头' }).evaluate((element) => element.style.left);
await splitCue.click({ button: 'right' });
const subtitleMenu = page.getByRole('menu', { name: '字幕操作' });
await subtitleMenu.waitFor();
assert.equal(
  groupPatchBodies.filter((body) => body.type === 'split_subtitle_cue').length,
  splitWritesBeforeRightClick,
  '分割模式下右键字幕不得再次提交 split_subtitle_cue',
);
assert.equal(
  await page.getByRole('button', { name: '拖动播放头' }).evaluate((element) => element.style.left),
  playheadBeforeSubtitleRightClick,
  '右键字幕不得移动播放头',
);
const deleteSubtitleResponse = page.waitForResponse((response) => response.url().endsWith('/api/final-edit-groups/group-e2e') && response.request().method() === 'PATCH');
await subtitleMenu.getByRole('menuitem', { name: '删除字幕' }).click();
await deleteSubtitleResponse;
const deleteSubtitleCommand = groupPatchBodies.at(-1);
assert.equal(deleteSubtitleCommand?.type, 'delete_subtitle_cue', '字幕右键删除必须提交现有原子 group command');
assert.equal(deleteSubtitleCommand?.cueId, splitCueId);
await splitCue.waitFor({ state: 'detached' });
assert.equal(savedGroup.subtitleCues.some((cue) => cue.id === splitCueId), false, 'mock 服务端必须持久化删除结果');
```

- [ ] **Step 4: Run both tests and verify RED for the missing UI**

Run:

```bash
node scripts/final-edit-mixcut-ui-contract.test.mjs
```

Expected: FAIL because `TimelineContextMenu` has no `subtitle` branch.

Run:

```bash
node scripts/final-edit-mixcut.playwright.test.mjs
```

Expected: FAIL while locating the `字幕操作` menu; the current right-click path must not be accepted as a passing result.

### Task 2: Implement the minimal subtitle context-menu path

**Files:**
- Modify: `components/mixcut/MixcutTimeline.tsx:19-21`
- Modify: `components/mixcut/MixcutTimeline.tsx:190`
- Modify: `components/mixcut/MixcutTimeline.tsx:246-264`
- Modify: `components/mixcut/MixcutTimeline.tsx:304-340`
- Modify: `components/mixcut/MixcutTimeline.tsx:440-558`
- Modify: `components/mixcut/PreviewStep.tsx:329`

- [ ] **Step 1: Extend the discriminated menu state**

Use one state union for all three existing timeline popovers:

```ts
type TimelineContextMenu =
  | { kind: 'video'; clipId: string; x: number; y: number }
  | { kind: 'subtitle'; cueId: string; x: number; y: number }
  | { kind: 'narration'; x: number; y: number };
```

- [ ] **Step 2: Wire each `SubtitleBlock` to open the shared menu**

Pass this callback beside `onEditText`:

```tsx
onOpenContextMenu={(clientX, clientY) => setContextMenu({
  kind: 'subtitle',
  cueId: cue.id,
  x: Math.max(8, Math.min(clientX, window.innerWidth - 184)),
  y: Math.max(8, Math.min(clientY, window.innerHeight - 86)),
})}
```

Add the prop to `SubtitleBlock`:

```ts
onOpenContextMenu: (clientX: number, clientY: number) => void;
```

- [ ] **Step 3: Make right-click safe in both subtitle tools**

At the beginning of the subtitle article's `onPointerDown`, ignore non-primary buttons before either drag or split logic runs:

```tsx
onPointerDown={(event) => {
  if (event.button !== 0) return;
  if (tool === 'select') {
    begin('move', event);
    return;
  }
  if (disabled) return;
  event.preventDefault();
  event.stopPropagation();
  const plan = splitPlanFromPointer(event.clientX, event.currentTarget);
  if (!plan) return;
  onSelect(cue.id);
  setSplitPlan(null);
  void onCommand({ type: 'split_subtitle_cue', cueId: cue.id, ...plan });
}}
```

Add the context-menu handler on the same `<article>`:

```tsx
onContextMenu={(event) => {
  if (disabled) return;
  event.preventDefault();
  event.stopPropagation();
  onSelect(cue.id);
  setSplitPlan(null);
  onOpenContextMenu(event.clientX, event.clientY);
}}
```

This ordering is required: a secondary-button pointer event must never reach `begin()` or the split command path.

- [ ] **Step 4: Render and execute the subtitle danger action**

Give video and subtitle menus `menu` semantics, keep narration as a `dialog`, and give each branch an accessible label:

```tsx
role={contextMenu.kind === 'narration' ? 'dialog' : 'menu'}
aria-label={contextMenu.kind === 'video'
  ? '视频片段操作'
  : contextMenu.kind === 'subtitle'
    ? '字幕操作'
    : '口播音频变速'}
```

Render the subtitle branch between video and narration:

```tsx
{contextMenu.kind === 'video' ? (
  <button
    type="button"
    role="menuitem"
    className={styles.timelineContextDanger}
    disabled={disabled}
    onClick={() => {
      const clipId = contextMenu.clipId;
      setContextMenu(null);
      void onVariantCommand({ type: 'delete_clip', clipId }).then((accepted) => {
        if (accepted && selectedClipId === clipId) onSelectClip('');
      });
    }}
  >删除片段</button>
) : contextMenu.kind === 'subtitle' ? (
  <button
    type="button"
    role="menuitem"
    className={styles.timelineContextDanger}
    disabled={disabled}
    onClick={() => {
      const cueId = contextMenu.cueId;
      setContextMenu(null);
      void onGroupCommand({ type: 'delete_subtitle_cue', cueId }).then((accepted) => {
        if (accepted && selectedCueId === cueId) onSelectCue('');
      });
    }}
  >删除字幕</button>
) : (
  <>
    <div className={styles.timelineContextTitle}>调整音频倍速</div>
    <div className={styles.timelineSpeedHint} id="mixcut-narration-speed-help">拖动后立即作用于当前音轨，松手自动保存。</div>
    <NarrationPlaybackRateControl
      idPrefix="mixcut-narration-context-speed"
      value={narrationPlaybackRate}
      disabled={disabled}
      onPreview={onNarrationPlaybackRatePreview}
      onCommit={onNarrationPlaybackRateCommit}
      onPendingChange={(pending) => { narrationPlaybackRatePendingRef.current = pending; }}
    />
  </>
)}
```

Do not add a confirmation dialog. A rejected command keeps the authoritative Cue after the existing command queue refreshes the group.

- [ ] **Step 5: Update discoverability text without changing layout**

In `MixcutTimeline.tsx`, use:

```tsx
{tool === 'split'
  ? '点击字幕块上的目标位置即可切开，右键删除'
  : '拖动字幕块移动，拖两侧修剪，双击改字，右键删除'}
```

In `PreviewStep.tsx`, update the compact chip to:

```tsx
<span
  className={`${styles.chip} ${styles.chipGrey}`}
  title="单击选中 | 拖拽排序 | 双击片段重选时段 | 右键视频/字幕删除 | 右键口播调速 | 双击字幕编辑"
>
  单击选中 · 拖拽排序 · 双击编辑 · 右键视频/字幕删除、口播调速
</span>
```

- [ ] **Step 6: Run targeted tests and verify GREEN**

Run:

```bash
node scripts/final-edit-mixcut-ui-contract.test.mjs
node scripts/final-edit-mixcut.playwright.test.mjs
```

Expected: both exit 0; Playwright prints `final-edit mixcut formal page smoke tests passed`.

- [ ] **Step 7: Preserve overlapping BGM edits and commit only when the index is safe**

Inspect the four-file diff and the staged index:

```bash
git diff -- components/mixcut/MixcutTimeline.tsx components/mixcut/PreviewStep.tsx scripts/final-edit-mixcut-ui-contract.test.mjs scripts/final-edit-mixcut.playwright.test.mjs
git diff --cached --name-only
```

Expected: subtitle-menu hunks appear alongside the documented pre-existing BGM hunks; no pre-existing hunk has disappeared.

If the BGM work has been committed or the four files are otherwise clean apart from this feature, stage and commit them:

```bash
git add components/mixcut/MixcutTimeline.tsx components/mixcut/PreviewStep.tsx scripts/final-edit-mixcut-ui-contract.test.mjs scripts/final-edit-mixcut.playwright.test.mjs
git commit -m "feat: delete mixcut subtitles from timeline"
```

If unrelated BGM hunks are still uncommitted, do not stage the overlapping files and do not create a mixed commit. Leave the verified subtitle changes in the worktree and report that the feature commit is deferred pending separation of the BGM work.

### Task 3: Verify the existing backend contract and production build

**Files:**
- Verify only: `lib/final-edit/workspace.ts`
- Verify only: `scripts/final-edit-workspace.test.ts`

- [ ] **Step 1: Run the workspace regression suite**

Run:

```bash
node scripts/final-edit-workspace.test.ts
```

Expected: exit 0, including the existing `delete_subtitle_cue` persistence coverage.

- [ ] **Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: exit 0 with no ESLint errors.

- [ ] **Step 3: Run a production build**

Run:

```bash
npm run build
```

Expected: `next build` and `scripts/sync-standalone-assets.mjs` both exit 0.

- [ ] **Step 4: Review the final diff and worktree boundaries**

Always run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; pre-existing unrelated worktree changes remain present and untouched.

If Task 2 produced a feature commit, also run:

```bash
git show --stat --oneline HEAD
```

Expected: the feature commit contains only `MixcutTimeline.tsx`, `PreviewStep.tsx`, `final-edit-mixcut-ui-contract.test.mjs`, and `final-edit-mixcut.playwright.test.mjs`. If Task 2 deferred the commit because BGM hunks still overlap, omit `git show` and report the verified worktree state instead.
