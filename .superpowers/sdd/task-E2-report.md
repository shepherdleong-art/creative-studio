# Task E2 report — Submit versioned preview and final jobs

## TDD

- Added `scripts/final-video-submit-api.test.ts` before the two submission routes existed.
- RED: `node scripts/final-video-submit-api.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `app/api/final-video-drafts/[id]/preview/route.ts`.
- GREEN: the focused test passes after adding the preview/render submit routes and the legacy preview compatibility response.

## Implementation

- Preview and final submission require a `review` draft and matching revision, then persist a v2 immutable snapshot before starting the queue.
- Narration sources are realpath-checked beneath that draft's narration directory, copied into the job work directory, and the persisted beats point only to those copies.
- Successful previews conditionally update `previewJobId` / `previewRevision` only when the draft is still at the submitted revision.
- The legacy preview endpoint now returns the current draft summary and migration guidance without calculating a v1 timeline.

## Verification

```text
node scripts/final-video-submit-api.test.ts
node scripts/final-video-render-snapshot.test.ts
npx tsc --noEmit
npm run lint
git diff --check
```

All commands passed. Lint completed with the repository's existing 39 warnings and no errors. Node emitted its existing module-type warning for `.ts` scripts.

## Commit

`feat(final-video): submit versioned preview and final jobs`

## Concerns

- Review identified that an in-process completion poller would lose preview writeback across a server restart, and that the old panel still expects the v1 preview response shape.

## Review fixes

- Moved preview writeback into the queue's successful completion path and added startup reconciliation for already-succeeded v2 preview jobs. Both use the same conditional `draft.id + revision` update, so late previews cannot overwrite a changed draft even after recovery.
- Added a restart/recovery test covering both a current preview and a stale revision.
- The legacy route now retains inert `draft`, `segments`, `issues`, and `totalDurationSec` fields alongside its migration notice/current-draft summary. It never recomputes a v1 timeline.
- Hardened narration-copy containment by canonicalizing the drafts storage root as well as the submitted narration directory; a symlink escaping that root is rejected and regression-tested.
