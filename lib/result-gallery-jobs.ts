export type ResultJobStatus =
  | 'queued'
  | 'generating'
  | 'checking'
  | 'succeeded'
  | 'failed'
  | 'empty';

export type ResultGalleryJob = {
  id: string;
  status: string;
  outputFilename?: string;
  outputImageId?: string;
};

export type SceneReferenceRecord = {
  id: string;
  name: string;
  imageAssetId: string;
  imageFilename?: string;
  status?: string;
};

export type SceneReferenceSummary = {
  id: string;
  name: string;
  imageFilename?: string;
};

export function getResultJobKind(job: ResultGalleryJob): ResultJobStatus {
  if (job.status === 'pending') return 'queued';
  if (job.status === 'running' || job.status === 'retrying') return 'generating';
  if (job.status === 'needs_check') return 'checking';
  if (job.status === 'succeeded' && (job.outputFilename || job.outputImageId)) return 'succeeded';
  if (job.status === 'failed' || job.status === 'succeeded') return 'failed';
  return 'empty';
}

export function getSelectableResultJobs<T extends ResultGalleryJob>(jobs: T[]): T[] {
  return jobs.filter((job) => {
    const kind = getResultJobKind(job);
    return kind === 'succeeded' || kind === 'failed';
  });
}

export function getResultGalleryCounts(jobs: ResultGalleryJob[]) {
  return jobs.reduce(
    (counts, job) => {
      const kind = getResultJobKind(job);
      counts.total += 1;
      if (kind === 'succeeded') counts.succeeded += 1;
      if (kind === 'failed') counts.failed += 1;
      if (kind === 'queued' || kind === 'generating' || kind === 'checking') counts.active += 1;
      return counts;
    },
    { total: 0, active: 0, succeeded: 0, failed: 0 },
  );
}

export function buildSceneReferenceByImageId(refs: SceneReferenceRecord[]): Map<string, SceneReferenceSummary> {
  return getActiveSceneReferences(refs).reduce((map, ref) => {
    if (!ref.imageAssetId) return map;
    map.set(ref.imageAssetId, {
      id: ref.id,
      name: ref.name,
      imageFilename: ref.imageFilename,
    });
    return map;
  }, new Map<string, SceneReferenceSummary>());
}

export function getSceneReferenceBadgeLabel(ref?: SceneReferenceSummary): string {
  return ref?.name ? `场景参考：${ref.name}` : '已设为场景参考';
}

export function getActiveSceneReferences(refs: SceneReferenceRecord[]): SceneReferenceRecord[] {
  return refs.filter((ref) => !ref.status || ref.status === 'active');
}
