import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { probeVideoMedia } from '../ffmpeg.ts';
import type { ScriptOutput } from '../script-providers/types.ts';
import { resolveStoragePath } from './storage-path.ts';
import type { MixcutContextResponse } from './types.ts';

// Pure, dependency-injected (db + storageRoot passed in — never getDb()/
// dataRoot()) query/aggregation logic backing
// GET /api/projects/:projectId/final-edit/context (plan §5.1). Kept out of
// workspace.ts so scripts/final-edit-mixcut-flow.test.ts can exercise the
// real query logic against an isolated in-memory SQLite db + temp storage
// root, mirroring how scripts/final-edit-mixcut-context-contract.test.ts
// proved the same rules in raw SQL during Phase 0 — without ever touching
// the real data/workbench.db.
//
// "project not found" is signalled by returning null rather than throwing
// FinalEditError directly: FinalEditError lives in lib/final-edit/workspace.ts,
// and workspace.ts is the module that imports buildMixcutContext() from here
// (to implement FinalEditWorkspace.getMixcutContext) — importing FinalEditError
// back from workspace.ts would make this module circularly depend on its own
// consumer. workspace.ts's getMixcutContext() turns a null result into
// FinalEditError('project_not_found', '项目不存在', 404).

/**
 * Matches Task 2 contract test's local `isUsableV2Draft` predicate exactly:
 * only a V2 script draft with a non-empty shotSetId and at least one segment
 * is usable for mixcut context purposes.
 *
 * This is the single well-named exported predicate the plan's conventions
 * ask for. It is NOT wired into app/api/projects/[id]/final-edit/bootstrap/route.ts
 * (out of scope — that route already has its own inline copy of this same
 * check, and a private near-duplicate also lives in workspace.ts's
 * scriptFromDb; both are pre-existing warts left as-is, see delivery report).
 */
export function isUsableV2ScriptDraft(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const value = parsed as Record<string, unknown>;
  return value.version === 2
    && typeof value.shotSetId === 'string'
    && value.shotSetId.length > 0
    && Array.isArray(value.segments)
    && value.segments.length > 0;
}

interface ProjectRow {
  id: string;
  name: string;
  productName: string | null;
  productCode: string | null;
  createdAt: string;
}

interface ShotSetRow {
  id: string;
  name: string;
  createdAt: string;
}

interface ScriptDraftRow {
  id: string;
  provider: string;
  model: string;
  outputJson: string;
  createdAt: string;
}

interface VideoJobRow {
  videoJobId: string;
  shotSetId: string;
  filename: string | null;
  localVideoPath: string;
}

const MEDIA_PROBE_CONCURRENCY = 4;

/**
 * Resolve media metadata without allowing one context request to fan out into
 * an unbounded number of ffprobe/ffmpeg child processes.
 */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

/**
 * Resolve+validate a `video_jobs.localVideoPath` value against storageRoot,
 * and confirm the resolved file actually exists on disk.
 *
 * Mirrors the `toRelative()` idiom at lib/final-edit/workspace.ts:951-954
 * (enqueueRender) and assetsForScript()'s try/catch at
 * lib/final-edit/workspace.ts:195-208: a single row failing safe-path
 * validation (escapes storageRoot, contains `..`, etc.) or pointing at a file
 * that doesn't actually exist must not break the whole context response —
 * return null so the caller silently excludes just that one row.
 */
function resolveSafeVideoAbsolutePath(storageRoot: string, localVideoPath: string | null): string | null {
  if (!localVideoPath) return null;
  try {
    const resolved = resolveStoragePath(storageRoot, localVideoPath, { allowAbsolute: true });
    // JUDGMENT CALL (JC-4): also require the file to exist on disk — same
    // "exclude, don't 500" reasoning as the safe-path check above.
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Builds the full MixcutContextResponse for one project, per plan §5.1's four
 * query rules:
 *   - shot_sets.projectId = :projectId.
 *   - script_drafts.outputJson parsed; only V2 + usable shotSetId/segments.
 *   - videos for the CURRENT shot set: projectId+shotSetId+status='succeeded'
 *     +localVideoPath present, and passing safe-path validation.
 *   - no grouping ever inferred from filename/title/createdAt.
 *
 * Returns null when the project itself doesn't exist (see file header for
 * why the caller, not this function, turns that into a FinalEditError).
 */
export async function buildMixcutContext(
  db: Database.Database,
  storageRoot: string,
  projectId: string,
  requestedShotSetId?: string | null,
): Promise<MixcutContextResponse | null> {
  const projectRow = db.prepare(`
    SELECT id, name, productName, productCode, createdAt FROM projects WHERE id = ?
  `).get(projectId) as ProjectRow | undefined;
  if (!projectRow) return null;

  // Rule: shot_sets.projectId = :projectId.
  const shotSetRows = db.prepare(`
    SELECT id, name, createdAt FROM shot_sets WHERE projectId = ? ORDER BY createdAt DESC
  `).all(projectId) as ShotSetRow[];

  // JUDGMENT CALL (JC-1): currentShotSetId selection. §5.2 only says "current"
  // shotSetId lives in client workspace state; the plan never specifies a
  // server-side default. An explicit ?shotSetId= is honored only if it
  // belongs to this project (shotSetRows is already projectId-scoped, so a
  // foreign or made-up id simply won't be found here); absent or
  // non-belonging both fall back to the most-recently-created shot set
  // rather than erroring — a stale client-cached shotSetId (e.g. from a
  // deleted shot set) must not break the whole page load. Zero shot sets ->
  // null.
  const requestedRow = requestedShotSetId ? shotSetRows.find((row) => row.id === requestedShotSetId) : undefined;
  const currentShotSetId: string | null = requestedRow?.id ?? shotSetRows[0]?.id ?? null;

  // JUDGMENT CALL (JC-3): sidebar stats for EVERY shot set in the project use
  // cheap DB-only aggregation, never probeVideoMedia/ffprobe — probing every
  // video in the whole project on every page load would be wasteful.
  // succeededVideoCount reuses the same SQL predicate as the detail rule
  // below (projectId+shotSetId+status='succeeded'+localVideoPath IS NOT
  // NULL) but intentionally skips the fs safe-path/existence check the
  // detail list performs below — an intentional, documented approximation
  // (a row with a corrupt/unsafe path still counts toward this number, even
  // though it would never appear in that shot set's videoAssets[] detail
  // list once it becomes "current"). totalDurationUs is likewise a coarse
  // whole-second SUM(durationSec) * 1e6, not the precise per-file
  // probeVideoMedia duration used for the CURRENT shot set's videoAssets[]
  // further down.
  // JUDGMENT CALL (new, not covered by JC-1..JC-5): shotCount = COUNT(*) of
  // every row in `shots` for this shotSetId, unfiltered by any
  // generation/review state — the frozen type just says "shotCount" with no
  // further qualifier, and this is the only unambiguous reading.
  //
  // PERF (code review fix): this used to run two queries PER shot set inside
  // a .map() — an N+1 pattern, and worse than usual because `shots` has no
  // secondary index on shotSetId (lib/db.ts), so each iteration was a full
  // table scan of `shots` across every project, repeated once per shot set
  // in this project. Replaced with two GROUP BY queries, each run once for
  // the whole project, plus idx_shots_shotset in the append-only core
  // migrations so the shots query itself is no longer a full scan either.
  const shotSetIds = shotSetRows.map((row) => row.id);
  const validShotSetIds = new Set(shotSetIds);

  const shotCountByShotSetId = new Map<string, number>();
  if (shotSetIds.length > 0) {
    const placeholders = shotSetIds.map(() => '?').join(',');
    const shotCountRows = db.prepare(`
      SELECT shotSetId, COUNT(*) AS count FROM shots WHERE shotSetId IN (${placeholders}) GROUP BY shotSetId
    `).all(...shotSetIds) as { shotSetId: string; count: number }[];
    for (const r of shotCountRows) shotCountByShotSetId.set(r.shotSetId, Number(r.count) || 0);
  }

  const videoAggByShotSetId = new Map<string, { count: number; totalSec: number }>();
  const videoAggRows = db.prepare(`
    SELECT shotSetId, COUNT(*) AS count, COALESCE(SUM(durationSec), 0) AS totalSec
    FROM video_jobs
    WHERE projectId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL AND shotSetId IS NOT NULL
    GROUP BY shotSetId
  `).all(projectId) as { shotSetId: string; count: number; totalSec: number }[];
  for (const r of videoAggRows) videoAggByShotSetId.set(r.shotSetId, { count: Number(r.count) || 0, totalSec: Number(r.totalSec) || 0 });

  const shotSets = shotSetRows.map((row) => {
    const videoAgg = videoAggByShotSetId.get(row.id);
    return {
      id: row.id,
      name: row.name,
      shotCount: shotCountByShotSetId.get(row.id) || 0,
      succeededVideoCount: videoAgg?.count || 0,
      totalDurationUs: (videoAgg?.totalSec || 0) * 1_000_000,
    };
  });

  // Rule: script_drafts.outputJson parsed; only V2 + usable shotSetId/segments.
  const draftRows = db.prepare(`
    SELECT id, provider, model, outputJson, createdAt FROM script_drafts WHERE projectId = ? ORDER BY createdAt DESC
  `).all(projectId) as ScriptDraftRow[];
  const drafts: MixcutContextResponse['drafts'] = [];
  for (const row of draftRows) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.outputJson); } catch { continue; }
    if (!isUsableV2ScriptDraft(parsed)) continue;
    const script = parsed as ScriptOutput;
    if (!validShotSetIds.has(script.shotSetId)) continue;
    // fullScript is a derived convenience field and can be absent or stale in
    // historical V2 rows. Rebuild the narration from the ordered source
    // segments so Phase 2 never sends drifted text to TTS.
    const narrationText = script.segments
      .map((segment) => typeof segment.narration === 'string' ? segment.narration.trim() : '')
      .filter(Boolean)
      .join('\n');
    if (!narrationText) continue;
    drafts.push({
      id: row.id,
      shotSetId: script.shotSetId,
      title: script.title || '',
      narrationText,
      targetDurationSec: Number(script.targetDurationSec) || 0,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt,
    });
  }

  // Rule: videos for the CURRENT shot set must satisfy projectId+shotSetId+
  // status='succeeded'+localVideoPath present AND pass safe-path validation
  // (+ actually exist on disk). Only probed (JC-2) for this one shot set's
  // detail list — never for the whole project (see shotSets aggregation
  // above, which stays DB-only on purpose).
  const videoAssets: MixcutContextResponse['videoAssets'] = [];
  if (currentShotSetId) {
    const videoRows = db.prepare(`
      SELECT id AS videoJobId, shotSetId, filename, localVideoPath
      FROM video_jobs
      WHERE projectId = ? AND shotSetId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL
      ORDER BY createdAt
    `).all(projectId, currentShotSetId) as VideoJobRow[];

    const safeRows = videoRows
      .map((row) => ({ row, absolutePath: resolveSafeVideoAbsolutePath(storageRoot, row.localVideoPath) }))
      .filter((entry): entry is { row: VideoJobRow; absolutePath: string } => entry.absolutePath !== null);

    // JUDGMENT CALL (JC-2): metadata probing stays inside the request because
    // it is not a transcode/paid task, but it is bounded so a large shot set
    // cannot spawn an ffprobe/ffmpeg process storm.
    const probes = await mapWithConcurrency(
      safeRows,
      MEDIA_PROBE_CONCURRENCY,
      (entry) => probeVideoMedia(entry.absolutePath),
    );

    safeRows.forEach((entry, index) => {
      const probe = probes[index];
      videoAssets.push({
        videoJobId: entry.row.videoJobId,
        shotSetId: entry.row.shotSetId,
        filename: entry.row.filename || entry.row.videoJobId,
        durationUs: probe.durationUs,
        width: probe.width,
        height: probe.height,
        thumbnailUrl: `/api/projects/${encodeURIComponent(projectId)}/final-edit/shot-sets/${encodeURIComponent(currentShotSetId)}/module4-assets/${encodeURIComponent(entry.row.videoJobId)}/thumbnail`,
        source: 'module4',
      });
    });
  }

  return {
    project: {
      id: projectRow.id,
      name: projectRow.name,
      productName: projectRow.productName || '',
      // Redline (plan §11.1 / ExportIdentity.productCode JSDoc in types.ts /
      // Task 2 contract test): productCode must come from projects.productCode,
      // NEVER projects.model (that's the image-generation provider's model).
      // This module never reads projectRow.model anywhere.
      productCode: projectRow.productCode || '',
      createdAt: projectRow.createdAt,
    },
    shotSets,
    currentShotSetId,
    drafts,
    videoAssets,
  };
}
