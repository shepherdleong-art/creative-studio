/**
 * 一次批量里同一份素材只核验一次：300 条成片会反复用到同样的原片，
 * 每条都重新做「两次全文件哈希 + ffprobe」既慢又没必要。
 *
 * 只缓存到进程内，按数据库连接隔离；内容变化或提交前复核失败时立即作废，
 * 下次重试重新核验，绝不拿旧的核验结果当新的文件身份。
 */
import type Database from 'better-sqlite3';
import { verifyFormulaCandidate, recheckFormulaCandidate,
  type FormulaCandidateSource, type FormulaVerifiedCandidate } from './candidate-media.ts';

const caches = new WeakMap<Database.Database, Map<string, Promise<FormulaVerifiedCandidate | null>>>();

function cacheFor(db: Database.Database): Map<string, Promise<FormulaVerifiedCandidate | null>> {
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  return cache;
}

function key(projectId: string, assetId: string, contentFingerprint: string): string {
  return `${projectId}\u0000${assetId}\u0000${contentFingerprint}`;
}

export function verifyFormulaCandidateCached(db: Database.Database, projectId: string, assetId: string,
  contentFingerprint: string, sources: FormulaCandidateSource[], signal: AbortSignal): Promise<FormulaVerifiedCandidate | null> {
  const cache = cacheFor(db);
  const cacheKey = key(projectId, assetId, contentFingerprint);
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const pending = verifyFormulaCandidate(db, projectId, assetId, contentFingerprint, sources, signal)
    .then(candidate => {
      // 核验不过的文件不作长期缓存：补回原片后重试能重新核验。
      if (!candidate) cache.delete(cacheKey);
      return candidate;
    })
    .catch(error => { cache.delete(cacheKey); throw error; });
  cache.set(cacheKey, pending);
  return pending;
}

export function recheckFormulaCandidateCached(db: Database.Database, projectId: string, candidate: FormulaVerifiedCandidate): void {
  try {
    recheckFormulaCandidate(db, projectId, candidate);
  } catch (error) {
    cacheFor(db).delete(key(projectId, candidate.assetId, candidate.contentFingerprint));
    throw error;
  }
}
