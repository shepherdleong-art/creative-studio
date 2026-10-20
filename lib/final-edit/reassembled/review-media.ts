import type Database from 'better-sqlite3';
import { FinalEditError } from '../errors.ts';

/** Select an immutable published cover by identity; never accept a client file path. */
export function filmReviewCover(db: Database.Database, bindingId: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new FinalEditError('review_version_invalid', '交付版本无效', 400);
  const binding = db.prepare('SELECT managedRootRelative,manifestJson FROM final_edit_film_bindings WHERE id=?').get(bindingId) as { managedRootRelative: string; manifestJson: string } | undefined;
  const delivery = db.prepare("SELECT jobId FROM final_edit_film_deliveries WHERE bindingId=? AND version=? AND status='published'").get(bindingId, version) as { jobId: string | null } | undefined;
  if (!binding || !delivery) throw new FinalEditError('film_delivery_not_found', '该交付版本不存在', 404);
  let file: unknown;
  if (version === 1 && (!delivery.jobId || delivery.jobId === `import:${bindingId}`)) {
    const initial = JSON.parse(binding.manifestJson) as { initialFiles?: { cover?: string } };
    if (initial.initialFiles?.cover) file = `${binding.managedRootRelative}/${initial.initialFiles.cover}`;
  } else if (delivery.jobId) {
    const job = db.prepare("SELECT outputJson FROM final_edit_jobs WHERE id=? AND kind='render' AND status='succeeded'").get(delivery.jobId) as { outputJson: string | null } | undefined;
    if (job?.outputJson) file = (JSON.parse(job.outputJson) as { coverRelativePath?: string }).coverRelativePath;
  }
  if (typeof file !== 'string' || !/\.jpe?g$/i.test(file)) throw new FinalEditError('film_cover_unavailable', '该交付版本的封面不可用', 404);
  return file;
}
