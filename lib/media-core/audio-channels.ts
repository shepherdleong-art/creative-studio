import { spawn } from 'node:child_process';
import { resolveFfprobePath } from './../ffmpeg.ts';

const CHANNEL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Read the channel count of a file's first audio stream.
 *
 * Audio-only inputs (narration WAVs, music beds) have no video stream, so
 * `probeVideoMedia` rejects them. The upmix chain needs a real count to pick
 * between duplicating a mono source and passing a stereo pair through, so this
 * probe stays deliberately narrow. Returns 0 when the count cannot be read.
 */
export function probeAudioChannels(filePath: string, options: { signal?: AbortSignal } = {}): Promise<number> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveFfprobePath(), ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=channels', '-of', 'csv=p=0', filePath], { windowsHide: true });
    } catch { resolve(0); return; }
    let out = '';
    let settled = false;
    const finish = (channels: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(channels);
    };
    const onAbort = () => { child.kill('SIGKILL'); finish(0); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(0); }, CHANNEL_PROBE_TIMEOUT_MS);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => finish(0));
    child.on('close', () => {
      const channels = Number.parseInt(out.trim(), 10);
      finish(Number.isFinite(channels) && channels > 0 ? channels : 0);
    });
  });
}
