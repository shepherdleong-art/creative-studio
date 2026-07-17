let tail: Promise<void> = Promise.resolve();

/** Serializes analysis, TTS, proposals and FFmpeg work across the local process. */
export function runFinalEditHeavyJob<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task, task);
  tail = result.then(() => undefined, () => undefined);
  return result;
}
