import { runFfmpeg } from '../ffmpeg.ts';
import { FINAL_EDIT_FPS } from '../media-core/render-contract.ts';

/** Count decoded pictures on the same 24 fps timeline used by the trim filters. */
export async function countFilmFrames(file: string): Promise<number> {
  let frames = 0;
  await runFfmpeg(['-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', file,
    '-map', '0:v:0', '-an', '-vf', `fps=${FINAL_EDIT_FPS}`, '-f', 'null', '-'],
  { timeoutMs: 180_000, onFrame: (value) => { frames = value; } });
  return frames;
}
