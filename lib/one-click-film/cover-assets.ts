import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { authorizeManagedFileRead, requireAccessContext } from '../media-core/access-context.ts';
import type { CoreUsageSnapshotV1 } from '../usage-pricing.ts';
import { filmStoragePath } from './composition.ts';
import type { FilmCoverCandidate } from './cover-generation-types.ts';
import type { OneClickFilmRun } from './store.ts';

export interface CoverReference {
  id: string;
  sha256: string;
}

export interface FilmCoverAsset extends Pick<FilmCoverCandidate, 'id' | 'entryCode' | 'status' | 'message' | 'createdAt'> {
  projectId: string;
  runId: string;
  entryId: string;
  requestKey: string;
  requestHash: string;
  providerId: string;
  model: string;
  referenceImagesJson: string;
  prompt: string;
  requestedSize: string;
  providerFingerprint: string;
  usageSnapshotJson: string | null;
  operationId: string | null;
  remoteId: string | null;
  submittedAt: string | null;
  nextAttemptAt: string | null;
  relativePath: string | null;
  width: number | null;
  height: number | null;
  errorCode: string | null;
}

export interface FilmCoverAssetInput extends Pick<FilmCoverAsset, 'id' | 'projectId' | 'runId' | 'entryId' | 'entryCode'
  | 'requestKey' | 'requestHash' | 'providerId' | 'model' | 'prompt' | 'requestedSize' | 'providerFingerprint' | 'createdAt'> {
  references: CoverReference[];
  usageSnapshot: CoreUsageSnapshotV1;
}

export function filmCoverCandidate(asset: FilmCoverAsset): FilmCoverCandidate {
  const result: FilmCoverCandidate = {
    id: asset.id, entryCode: asset.entryCode, status: asset.status,
    channel: asset.model.endsWith('-flare') ? 'Flare' : 'Sunburst', message: asset.message, createdAt: asset.createdAt,
    ...(asset.errorCode === 'submission_unknown' ? { submissionUnconfirmed: true } : {}),
  };
  if (asset.status === 'ready') {
    result.imageUrl = `/api/one-click-film/${encodeURIComponent(asset.projectId)}/cover-assets/${encodeURIComponent(asset.id)}?entryCode=${encodeURIComponent(asset.entryCode)}`;
    result.thumbnailUrl = `${result.imageUrl}&thumbnail=1`;
  }
  return result;
}

export function listFilmCoverCandidates(db: Database.Database, run: OneClickFilmRun, entryId?: string): FilmCoverCandidate[] {
  requireAccessContext().assertAccess('project', run.projectId, 'read');
  const assets = entryId === undefined
    ? db.prepare(`SELECT * FROM one_click_film_cover_assets WHERE projectId=? AND runId=? ORDER BY rowid`).all(run.projectId, run.id)
    : db.prepare(`SELECT * FROM one_click_film_cover_assets WHERE projectId=? AND runId=? AND entryId=? ORDER BY rowid`).all(run.projectId, run.id, entryId);
  return (assets as FilmCoverAsset[]).map(filmCoverCandidate);
}

export function resolveGeneratedFilmCoverPath(db: Database.Database, run: OneClickFilmRun, entryId: string, assetId: string): string | null {
  const access = requireAccessContext();
  access.assertAccess('project', run.projectId, 'read');
  const asset = db.prepare(`SELECT relativePath FROM one_click_film_cover_assets
    WHERE id=? AND projectId=? AND runId=? AND entryId=? AND status='ready'`).get(assetId, run.projectId, run.id, entryId) as { relativePath: string } | undefined;
  if (!asset?.relativePath) return null;
  const file = filmStoragePath(asset.relativePath);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  authorizeManagedFileRead(file);
  return file;
}
