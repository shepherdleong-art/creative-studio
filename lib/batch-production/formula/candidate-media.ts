import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { probeVideoMedia, type VideoMediaProbe } from '../../ffmpeg.ts';
import { listAssetSources, resolveSourceFilePath, type BatchAssetSourceView, type ManagedSourceLocation } from '../media-catalog.ts';
import { assertProjectAssetFileIdentity, projectAssetFileIdentity, type ProjectAssetFileIdentity } from '../project-asset-media.ts';

export interface FormulaVerifiedCandidate {
  assetId: string; sourceId: string; contentFingerprint: string; location: ManagedSourceLocation;
  fileIdentity: ProjectAssetFileIdentity; media: VideoMediaProbe;
}
export interface FormulaCandidateSource { id: string; location: BatchAssetSourceView['locationJson'] }

async function hashFile(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath, { signal })) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

/** 人工区间确认与后台选片复用同一实际文件核验；传入的只是受控来源身份。 */
export async function verifyFormulaCandidate(db: Database.Database, projectId: string, assetId: string,
  fingerprint: string, frozenSources: FormulaCandidateSource[], signal: AbortSignal): Promise<FormulaVerifiedCandidate | null> {
  signal.throwIfAborted();
  const current = db.prepare('SELECT contentFingerprint,status,mediaKind FROM batch_assets WHERE id=? AND projectId=?').get(assetId, projectId) as {
    contentFingerprint: string; status: string; mediaKind: string;
  } | undefined;
  if (!current || current.status !== 'online' || current.mediaKind !== 'video' || current.contentFingerprint !== fingerprint) return null;
  const sources = listAssetSources(db, assetId);
  for (const frozen of frozenSources) {
    signal.throwIfAborted();
    if (frozen.location.kind !== 'managed') continue;
    const actual = sources.find(source => source.id === frozen.id && source.sourceKind === 'managed');
    if (!actual || JSON.stringify(actual.locationJson) !== JSON.stringify(frozen.location)) continue;
    try {
      const filePath = resolveSourceFilePath(frozen.location);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) continue;
      const fileIdentity = projectAssetFileIdentity(stat);
      if (await hashFile(filePath, signal) !== fingerprint) continue;
      const media = await probeVideoMedia(filePath, { signal });
      signal.throwIfAborted();
      if (media.errorMessage || !Number.isSafeInteger(media.durationUs) || media.durationUs <= 0
        || media.width <= 0 || media.height <= 0 || !Number.isFinite(media.fps) || media.fps <= 0) continue;
      if (await hashFile(filePath, signal) !== fingerprint) continue;
      assertProjectAssetFileIdentity(filePath, fileIdentity);
      return { assetId, sourceId: frozen.id, contentFingerprint: fingerprint, location: frozen.location, fileIdentity, media };
    } catch { signal.throwIfAborted(); }
  }
  return null;
}

export function recheckFormulaCandidate(db: Database.Database, projectId: string, candidate: FormulaVerifiedCandidate): void {
  if (!db.prepare("SELECT 1 FROM batch_assets WHERE id=? AND projectId=? AND status='online' AND contentFingerprint=?")
    .get(candidate.assetId, projectId, candidate.contentFingerprint)
    || !listAssetSources(db, candidate.assetId).some(source => source.id === candidate.sourceId
      && JSON.stringify(source.locationJson) === JSON.stringify(candidate.location))) throw new Error('选中的素材在核验期间已变化');
  assertProjectAssetFileIdentity(resolveSourceFilePath(candidate.location), candidate.fileIdentity);
}
