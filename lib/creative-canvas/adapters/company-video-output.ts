import fs from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../../data-root.ts';
import { probeVideoMedia, runFfmpeg } from '../../ffmpeg.ts';
import { withMediaResource } from '../../media-core/media-resource-gate.ts';
import { CanvasAdapterError } from './types.ts';

/** Normalize the video before the canvas stores it, so preview and export use the same file. */
export async function cropCanvasVideoToThreeFour(
  bytes: Buffer, taskId: string, signal?: AbortSignal, mode: 'rounding-only' | 'center-crop' = 'center-crop',
): Promise<Buffer> {
  signal?.throwIfAborted();
  const tempRoot = path.join(dataRoot(), 'storage', 'tmp', 'canvas-video-output');
  await fs.mkdir(tempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, 'crop-'));
  try {
    const inputPath = path.join(tempDir, 'input.mp4');
    const outputPath = path.join(tempDir, 'output.mp4');
    await fs.writeFile(inputPath, bytes, { signal });
    const input = await probeVideoMedia(inputPath, { signal });
    signal?.throwIfAborted();
    const sar = input.sampleAspectRatio ?? 1;
    if (input.width > 0 && input.height > 0 && sar === 1 && input.width * 4 === input.height * 3) return bytes;

    // Convert anamorphic video to square pixels by reducing the appropriate axis.
    const squareWidth = Math.floor(input.width * Math.min(sar, 1));
    const squareHeight = Math.floor(input.height / Math.max(sar, 1));
    // Both dimensions must be even for YUV 4:2:0, so use multiples of 6×8.
    const units = Math.floor(Math.min(squareWidth / 6, squareHeight / 8));
    if (units < 1) throw new Error('Unreadable or undersized video');
    const width = units * 6;
    const height = units * 8;
    // A photo already supplied the composition. Keep the native video if correcting it
    // would remove more than a single 6×8 alignment step from either dimension.
    if (mode === 'rounding-only' && (squareWidth - width > 6 || squareHeight - height > 8)) return bytes;
    const scale = sar === 1 ? '' : `scale=${squareWidth}:${squareHeight},`;
    await withMediaResource({ taskId, step: 'canvas-video-crop', wait: true, signal }, () => runFfmpeg([
      '-i', inputPath, '-map', '0:v:0', '-map', '0:a?',
      '-vf', `${scale}crop=${width}:${height}:exact=1,setsar=1`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough',
      '-c:a', 'copy', '-movflags', '+faststart', '-y', outputPath,
    ], { timeoutMs: 120_000, signal }));
    const output = await probeVideoMedia(outputPath, { signal });
    signal?.throwIfAborted();
    if (output.width !== width || output.height !== height || (output.sampleAspectRatio ?? 1) !== 1) {
      throw new Error('Video crop did not produce the target dimensions');
    }
    return await fs.readFile(outputPath, { signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new CanvasAdapterError('download', '成片画幅处理失败，可重试下载。', { code: 'output_aspect_ratio_failed' });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
