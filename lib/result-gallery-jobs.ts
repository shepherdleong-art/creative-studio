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
};

export function getResultJobKind(job: ResultGalleryJob): ResultJobStatus {
  if (job.status === 'pending') return 'queued';
  if (job.status === 'running' || job.status === 'retrying') return 'generating';
  if (job.status === 'needs_check') return 'checking';
  if (job.status === 'succeeded' && job.outputFilename) return 'succeeded';
  if (job.status === 'failed') return 'failed';
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
