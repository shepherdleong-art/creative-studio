import { withMediaResource } from '../media-core/media-resource-gate.ts';

/** Serializes analysis, TTS, proposals and FFmpeg work through the shared media lease. */
export function runFinalEditHeavyJob<T>(task: () => Promise<T>): Promise<T> {
  return withMediaResource({ taskId: 'final-edit-heavy', step: 'heavy-job', wait: true }, task);
}
