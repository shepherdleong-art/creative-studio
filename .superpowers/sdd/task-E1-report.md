# Task E1 report — Render immutable draft snapshots

## RED

- Added `scripts/final-video-render-snapshot.test.ts` before the implementation.
- `node scripts/final-video-render-snapshot.test.ts` initially failed while importing the legacy project-final route: it imported the `FinalVideoJobRow` type as a runtime value. The inspected legacy queue also depended on `script_drafts` and `video_jobs`, which the new fixture deliberately does not seed.

## GREEN

- The queue now parses persisted v2 snapshot fields at runtime, solves only those beats/clips/arrangement inputs, and builds narration from persisted local audio (or its existing job-local track).
- Preview renders constrain the output to 540px maximum width and apply `ultrafast` / CRF 28; final renders retain package dimensions.
- v2 manifests record draft revision, snapshot content, issues, solver version, and v2 schema version.
- The legacy project endpoint now requires the draft workflow, lists only final jobs, preserves legacy final successes, and rejects v1 retries with an actionable message.

## Verification

```text
node scripts/final-video-render-snapshot.test.ts
node scripts/project-final-status.test.ts
node scripts/final-video-e2e.test.ts
npx tsc --noEmit
npm run lint
git diff --check
```

All commands passed. Lint completed with the repository's existing 39 warnings and no errors.

## Commit

`refactor(final-video): render immutable draft snapshots`

## Concerns

- Phase E2 must copy narration source files into the submitted job directory and persist the copied paths in the job snapshot. E1 already reuses the job-local combined narration track on recovery and never invokes paid generation work.

## Follow-up review fix

- Review found that the v2 queue's recovery and pending-job selection were not constrained by `solverVersion`, so a legacy pending/running row could be claimed and failed by the v2 parser.
- Added a regression fixture for both legacy statuses. It failed with `legacy-pending` changed to `failed`, then passed after adding `solverVersion = 2` to both recovery and selection SQL predicates.
- Re-ran the focused snapshot and project-status tests, TypeScript check, lint, and `git diff --check`.
