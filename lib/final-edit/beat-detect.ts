import { spawn } from 'node:child_process';
import { resolveFfmpegPath } from '../ffmpeg.ts';

export interface BeatDetectionResult {
  pointsUs: number[];
  fallback: boolean;
  errorMessage?: string;
}

export function parseSilencePoints(output: string): number[] {
  const points: number[] = [];
  let pendingStartSec: number | null = null;
  for (const line of output.split(/\r?\n/u)) {
    const start = line.match(/silence_start:\s*([\d.]+)/u);
    if (start) pendingStartSec = Number(start[1]);
    const end = line.match(/silence_end:\s*([\d.]+)(?:\s*\|\s*silence_duration:\s*([\d.]+))?/u);
    if (!end) continue;
    const endSec = Number(end[1]);
    const durationSec = end[2] == null ? Number.NaN : Number(end[2]);
    const startSec = pendingStartSec ?? (Number.isFinite(durationSec) ? Math.max(0, endSec - durationSec) : 0);
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec >= startSec) {
      points.push(Math.round((startSec + endSec) * 500_000));
    }
    pendingStartSec = null;
  }
  return [...new Set(points.filter((point) => point >= 0))].sort((left, right) => left - right);
}

export function uniformBeatFallback(durationUs: number): number[] {
  if (!Number.isFinite(durationUs) || durationUs <= 0) return [];
  return Array.from({ length: 7 }, (_, index) => Math.round(durationUs * (index + 1) / 8));
}

export function detectBeatPoints(input: { audioPath: string; durationUs: number; timeoutMs?: number }): Promise<BeatDetectionResult> {
  return new Promise((resolve) => {
    const child = spawn(resolveFfmpegPath(), [
      '-i', input.audioPath,
      '-af', 'silencedetect=noise=-35dB:d=0.20',
      '-f', 'null', '-',
    ], { windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (result: BeatDetectionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fallback = (message?: string) => finish({
      pointsUs: uniformBeatFallback(input.durationUs),
      fallback: true,
      ...(message ? { errorMessage: message } : {}),
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fallback(`ffmpeg silencedetect timeout after ${input.timeoutMs ?? 60_000}ms`);
    }, input.timeoutMs ?? 60_000);
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-256_000); });
    child.on('error', (error) => fallback(error.message));
    child.on('close', (code) => {
      if (settled) return;
      const pointsUs = parseSilencePoints(stderr).filter((point) => point > 0 && point < input.durationUs);
      if (code === 0 && pointsUs.length > 0) finish({ pointsUs, fallback: false });
      else fallback(code === 0 ? undefined : `ffmpeg silencedetect exited with code ${code}`);
    });
  });
}
