import { spawn } from 'node:child_process';
import { resolveFfmpegPath } from '../ffmpeg.ts';

export interface DetectedSceneRange { startUs: number; endUs: number }

export function parseSceneCutTimes(stdout: string, stderr: string): number[] {
  const values: number[] = [];
  for (const output of [stdout, stderr]) {
    const pattern = /pts_time:([\d.]+)/gu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const timeUs = Math.round(Number(match[1]) * 1_000_000);
      if (Number.isFinite(timeUs) && timeUs > 100_000) values.push(timeUs);
    }
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

export function buildSceneRanges(durationUs: number, cutsUs: number[], minimumDurationUs = 300_000): DetectedSceneRange[] {
  if (!Number.isFinite(durationUs) || durationUs <= 0) return [];
  const boundaries = [0];
  for (const cutUs of [...cutsUs].sort((left, right) => left - right)) {
    const normalized = Math.round(cutUs);
    if (normalized <= 100_000 || normalized >= durationUs) continue;
    if (normalized - boundaries.at(-1)! < minimumDurationUs) continue;
    boundaries.push(normalized);
  }
  if (durationUs - boundaries.at(-1)! < minimumDurationUs && boundaries.length > 1) boundaries.pop();
  boundaries.push(Math.round(durationUs));
  return boundaries.slice(0, -1).map((startUs, index) => ({ startUs, endUs: boundaries[index + 1] }));
}

export function detectVideoScenes(input: {
  filePath: string;
  durationUs: number;
  threshold?: number;
  minimumDurationUs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DetectedSceneRange[]> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const threshold = Math.max(0, Math.min(100, input.threshold ?? 20)) / 100;
    const child = spawn(resolveFfmpegPath(), [
      '-i', input.filePath,
      '-vf', `select='gt(scene,${threshold.toFixed(2)})',metadata=print:file=-`,
      '-an', '-f', 'null', '-',
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ranges: DetectedSceneRange[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve(ranges.length ? ranges : [{ startUs: 0, endUs: input.durationUs }]);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      input.signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish([{ startUs: 0, endUs: input.durationUs }]);
    }, input.timeoutMs ?? 120_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-512_000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-512_000); });
    child.on('error', () => finish([{ startUs: 0, endUs: input.durationUs }]));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) finish([{ startUs: 0, endUs: input.durationUs }]);
      else finish(buildSceneRanges(input.durationUs, parseSceneCutTimes(stdout, stderr), input.minimumDurationUs));
    });
  });
}
