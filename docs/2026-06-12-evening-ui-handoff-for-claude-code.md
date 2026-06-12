# 2026-06-12 Evening UI Handoff for Claude Code

This note summarizes the evening UI/UX changes on branch `feat/apple-ui-redesign`.
It is intended as the next-session handoff for Claude Code or other coding agents.

## Goal

Continue the Apple-style workbench redesign and remove several workflow frictions found during live visual review:

- Make result/shot preview experiences consistent.
- Improve video generation form usability.
- Reduce dark/light contrast conflicts in embedded result panels.
- Make storyboard/shot-set browsing easier to compare and less cramped.
- Preserve selected shot-set state across tab switches.

## Files Changed

- `app/globals.css`
- `components/AssetUploadGrid.tsx`
- `components/HoverZoomImage.tsx`
- `components/ImagePickerGrid.tsx`
- `components/ResultGallery.tsx`
- `components/ShotSetPanel.tsx`
- `components/VideoGenerationPanel.tsx`

Untracked `.claude/` already exists in the worktree; do not include it unless explicitly requested.

## Shared Visual Foundation

### Dark Viewer Scope

`app/globals.css` now has a scoped `.theme-dark` token override for dark preview/viewer contexts.
It changes local surface, ink, hairline, button, card, input, segmented, and link styling only under `.theme-dark`.

The intent:

- Embedded workbench panels should stay light.
- Full-screen image viewers can be dark/immersive.
- Avoid applying the dark theme to normal page sections.

### Hover Preview Popovers

`app/globals.css` also defines:

- `.theme-preview-popover`
- `.theme-preview-caption`

These are now reused by:

- `HoverZoomImage`
- `ImagePickerGrid`
- `AssetUploadGrid`
- Shot-set reference scene thumbnail via `HoverZoomImage`

This keeps hover-preview styling consistent.

## Result Gallery

File: `components/ResultGallery.tsx`

Main changes:

- Embedded generated-result panel was changed back to light workbench styling:
  - `rounded-[18px]`
  - `border border-hairline`
  - `bg-surface-subtle`
- Full-screen viewer remains dark via `theme-dark`.
- Added `JobStatusDot` helper and small status dots on result cards.
- Full-screen viewer now follows an Apple Photos-like pattern:
  - dark full-screen background
  - top translucent filename/count bar
  - large centered before/after images
  - right generation-context panel
  - bottom action toolbar
  - floating previous/next buttons
- Regenerate controls remain available inside the viewer.

Design decision:

- Embedded panels are light because they are part of the workbench.
- Full-screen viewers are dark because they are inspection mode.

## Shot Set / Storyboard Panel

File: `components/ShotSetPanel.tsx`

This file received the largest interaction change.

### Multi-Set Expansion

Old model:

- `expandedId`
- single shared `shots`
- single shared `sceneRefInfo`

New model:

- `expandedIds: string[]`
- `shotsBySet: Record<string, Shot[]>`
- `sceneRefInfoBySet: Record<string, ...>`
- `loadingShotSetIds: string[]`
- `previewSetId`

Why:

- Users need to open multiple shot sets at once for comparison.
- Clicking another shot set should not collapse the currently open one.
- Each shot set needs its own cached shot data and reference-scene info.

### Shot Set Status Display

The row badge no longer blindly trusts `set.status`.

Current display rule:

- If `set.shotCount > 0 && set.generatedCount >= set.shotCount`, show `completed` / `已完成`.
- Otherwise show the backend status label.

Reason:

- Backend `shot_sets.status` can still say `generating` even when all images have been generated.
- The user saw `5 张 | 5 已生成` while the badge still said `生成中`.

### Larger Thumbnail Comparison Cards

Shot-set thumbnails were enlarged:

- Grid now uses `grid-cols-1`, `lg:grid-cols-2`, `2xl:grid-cols-3`.
- Each card compares original/result in wider `aspect-[4/3]` slots.
- Labels and filename padding were increased slightly.

Reason:

- The previous 4-5 column layout made original/result pairs too small and cramped.
- User preferred a larger gallery-like review density.

### Full-Screen Shot Preview Unified With Result Gallery

Shot preview was moved from a centered modal to a full-screen dark viewer.

It now includes:

- full-screen `theme-dark` shell
- original / reference / result image columns
- right-side generation context panel
- bottom toolbar
- previous/next navigation
- regenerate action
- download action when generated image exists

Overflow fixes:

- Viewer root has `overflow-hidden`.
- Main image grid has `min-w-0` and `overflow-x-hidden`.
- Image wrappers have `min-w-0`.
- Images use `max-w-full` and `object-contain`.
- Bottom toolbar uses `flex-wrap`.

Reason:

- A horizontal scrollbar appeared in the shot preview viewer.
- The root cause was image/grid intrinsic width pushing past the viewport.

### Reference Scene Hover Preview

The reference scene thumbnail in the expanded shot-set panel now uses `HoverZoomImage`.

Settings:

- thumbnail remains `h-12 w-12`
- hover cursor: `cursor-zoom-in`
- zoom max size: `420 x 320`

Reason:

- User wanted the reference scene image to be inspectable without opening a full modal or consuming panel space.

## Video Generation Panel

File: `components/VideoGenerationPanel.tsx`

Main changes:

### Shot Set Selector Persistence

Added `localStorage` persistence:

- key: `batch-image-workbench:video-shot-set:${projectId}`
- restores last selected shot set after tab remounts
- guarded by `restoredSetRef`

Reason:

- User selected a shot set, switched tabs, returned, and had to select it again.

### Selector Remains Visible

The shot-set selector is now rendered both before and after a shot set is selected.

Reason:

- After selecting a shot set, users could not switch to another shot set without leaving and returning to the tab.

### Cleaner State Reset On Shot Set Change

When selecting a new shot set:

- clears `selectedShot`
- clears `motionRows`
- clears per-shot motion cache
- clears current loaded shots
- clears current video jobs

Reason:

- Prevents stale rows/jobs from the previous shot set leaking into the new one.

### Horizontal Motion Row Layout

Motion description rows are now grid-based instead of a loose flex wrap.

Key behavior:

- Provider select, template select, duration, prompt textarea, delete action align horizontally on desktop.
- Prompt moves full-width on narrower breakpoints.
- Controls use `!w-full` because `.input-field` has global `width: 100%`.

### Prompt Textarea

The prompt field changed from single-line input to a multiline textarea:

- `rows={3}`
- `min-h-[4.75rem]`
- `resize-y`
- mono font / relaxed line height

Reason:

- Long motion prompts were truncated and hard to review.

### Template Switching

Template selection now always overwrites the current prompt with the selected template prompt.

Old behavior:

- Only filled prompt if the prompt was blank.

New behavior:

- Selecting a template updates prompt every time.

Reason:

- User selected one template, then selected another, but the prompt did not change.

### Delete Button

The row delete control was made more visible and contained inside the row:

- fixed grid operation column
- red-hover trash icon
- no right-side overflow

Reason:

- The previous minus button was subtle and could visually spill outside the row.

### Shot Thumbnail Size

Video-generation shot thumbnails were enlarged from `h-10 w-10` to `h-16 w-16`.

Reason:

- User wanted the small thumbnails larger and easier to inspect.

## Result / Hover Preview Components

Files:

- `components/HoverZoomImage.tsx`
- `components/ImagePickerGrid.tsx`
- `components/AssetUploadGrid.tsx`

Changes:

- Replaced local dark popover classes with shared `.theme-preview-popover`.
- Replaced local caption classes with `.theme-preview-caption`.
- This unifies hover zoom / picker preview styling.

## Verification Run

Recent verification commands passed:

```powershell
npx.cmd tsc --noEmit
npm.cmd run lint
git diff --check
npm.cmd run build
```

Observed warnings:

- `npm.cmd run lint` exits with 0 errors.
- It still reports existing warnings, mostly:
  - `@next/next/no-img-element`
  - a few unused variables
  - hook dependency warnings in unrelated components
- Latest lint count after the hover-reference change: 32 warnings.
- `npm.cmd run build` passes but still reports the existing Turbopack NFT trace warning through `next.config.ts` and `app/api/upload/route.ts`.

## Known Follow-Ups / Caveats

- No browser automation screenshot was captured in this environment because the browser control tool was not exposed during the session. User screenshots were used for visual iteration.
- The shot-set `completed` badge is currently a UI-derived display status, not a backend persisted status update.
- The result-gallery and shot-preview viewers are visually close but not yet fully componentized into a shared viewer abstraction.
- `ShotSetPanel.tsx` has grown larger and now owns several concerns:
  - shot-set list
  - multi-expansion state
  - reference scene display
  - shot preview viewer
  - redo/regenerate behavior
  A future cleanup could extract a shared full-screen comparison viewer, but avoid doing that unless the next task explicitly benefits from it.

## Suggested Next Agent Starting Point

If continuing UI polish:

1. Run `git status --short` and inspect current modified files.
2. Start from `ShotSetPanel.tsx` for storyboard/shot-set issues.
3. Start from `VideoGenerationPanel.tsx` for video generation UX issues.
4. Start from `ResultGallery.tsx` for scene generation result gallery/viewer issues.
5. Keep embedded panels light and full-screen viewers dark.
6. Do not include `.claude/` in commits unless the user explicitly asks.
