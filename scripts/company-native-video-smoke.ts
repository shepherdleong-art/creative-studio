/** Paid smoke test. Submit exactly once per model; later invocations only resume polling. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const { dataRoot } = await import('../lib/data-root.ts');
const { openaiVideoAdapter } = await import('../lib/video-providers/openai-video.ts');
const { downloadGatewayMedia, sanitizeGatewayMediaDiagnostic } = await import('../lib/gateway-media-url.ts');
const directory = path.join(dataRoot(), 'outputs', 'company-native-video-smoke-2026-10-28');
fs.mkdirSync(directory, { recursive: true });
const stateFile = path.join(directory, 'state.json');
type Job = {
  model: string; providerId: string; durationSec: number; resolution: string;
  status: string; taskId?: string; submittedAt?: string; finishedAt?: string;
  error?: string; videoPath?: string; media?: unknown;
  rejectedAttempts?: Array<{ submittedAt?: string; error?: string }>;
};
const jobs: Job[] = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : [
  { model: 'minimax-h3', providerId: 'company-minimax-h3', durationSec: 4, resolution: '2K', status: 'prepared' },
  { model: 'wan-3.0', providerId: 'company-wan-3-0', durationSec: 2, resolution: '1080P', status: 'prepared' },
];
function save() {
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(jobs, null, 2));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
}
const firstFrame = path.join(directory, 'input-first.png');
const lastFrame = path.join(directory, 'input-last.png');
const prompt = 'A single continuous product animation. Keep the exact wooden lounge chair, cream cushion, room, lighting and printed markers from the supplied frames. Begin exactly at the first image, smoothly slide the chair from left to right across the floor, and finish exactly at the last image. The red ball stays on the left, the blue cube stays on the right. Locked camera, no cuts, no new objects, no text changes.';

function fixture(chairX: number) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768" viewBox="0 0 1024 768">
  <defs><linearGradient id="wall" x2="0" y2="1"><stop stop-color="#e9e3d9"/><stop offset="1" stop-color="#d8cebd"/></linearGradient>
  <linearGradient id="wood"><stop stop-color="#7a4b2e"/><stop offset=".5" stop-color="#ba8050"/><stop offset="1" stop-color="#805432"/></linearGradient>
  <radialGradient id="ball" cx=".3" cy=".25"><stop stop-color="#f57a63"/><stop offset="1" stop-color="#ae382b"/></radialGradient></defs>
  <rect width="1024" height="768" fill="url(#wall)"/><path d="M0 540H1024V768H0Z" fill="#c2b39b"/>
  <path d="M0 540H1024M0 630H1024M0 720H1024" stroke="#b09e83" stroke-width="2"/>
  <rect x="48" y="48" width="928" height="672" rx="12" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="3"/>
  <text x="72" y="104" font-family="sans-serif" font-size="28" fill="#4f483e">FRAME CONTROL / 4:3</text>
  <circle cx="115" cy="604" r="36" fill="url(#ball)"/><text x="105" y="614" font-family="sans-serif" font-size="26" fill="white">A</text>
  <rect x="865" y="570" width="70" height="70" rx="6" fill="#326b91"/><text x="889" y="616" font-family="sans-serif" font-size="28" fill="white">B</text>
  <g transform="translate(${chairX} 0)"><ellipse cx="135" cy="628" rx="138" ry="19" fill="#6d5844" opacity=".2"/>
  <path d="M45 610L75 383M240 614L208 382" stroke="url(#wood)" stroke-width="24" stroke-linecap="round"/>
  <path d="M61 470L208 470L238 532L44 532Z" fill="url(#wood)"/>
  <path d="M72 276Q137 252 203 276L215 447Q139 468 61 447Z" fill="url(#wood)"/>
  <path d="M84 289Q137 269 190 289L202 431Q137 446 76 431Z" fill="#faf2df" stroke="#e1d4bb" stroke-width="4"/>
  <path d="M63 461Q137 444 211 461L227 502Q137 521 53 502Z" fill="#f5ead4" stroke="#dfcfb2" stroke-width="4"/>
  <path d="M47 421L67 525M225 421L218 525M42 415L84 415M197 415L239 415" stroke="url(#wood)" stroke-width="15" stroke-linecap="round"/>
  </g></svg>`);
}

const mode = process.argv[2] ?? 'status';
if (mode === 'prepare') {
  if (jobs.some(job => job.status !== 'prepared')) throw new Error('Cannot replace inputs after a submission attempt');
  await sharp(fixture(170)).png().toFile(firstFrame);
  await sharp(fixture(550)).png().toFile(lastFrame);
  fs.writeFileSync(path.join(directory, 'prompt.txt'), prompt);
  save();
  console.log(JSON.stringify({ directory, firstFrame, lastFrame }));
} else if (mode === 'submit' || mode === 'poll') {
  if (mode === 'submit' && !process.argv.includes('--confirm-paid')) throw new Error('Paid submission requires --confirm-paid and user authorization');
  const db = new Database(path.join(dataRoot(), 'data', 'workbench.db'), { readonly: true });
  try {
    for (const job of jobs) {
      const provider = db.prepare('SELECT apiKey, baseUrl, defaultModel FROM video_providers WHERE id = ?').get(job.providerId) as { apiKey: string; baseUrl: string; defaultModel: string };
      if (!provider || provider.defaultModel !== job.model) throw new Error('Provider configuration changed');
      try {
        if (mode === 'submit' && process.argv.includes('--retry-rejected') && job.status === 'submission_error'
          && !job.taskId && job.error?.startsWith('Video gateway submit error 400:')) {
          job.rejectedAttempts = [...(job.rejectedAttempts ?? []), { submittedAt: job.submittedAt, error: job.error }];
          delete job.error;
          job.status = 'prepared'; save();
        }
        if (mode === 'submit' && job.status === 'prepared') {
          if (!fs.existsSync(firstFrame) || !fs.existsSync(lastFrame)) throw new Error('Run prepare first');
          // Durable marker is written before uploads/POST: uncertain submission is never resent.
          job.status = 'submitting'; job.submittedAt = new Date().toISOString(); save();
          const result = await openaiVideoAdapter.submit({
            model: job.model, durationSec: job.durationSec, prompt,
            sourceImagePath: firstFrame, sourceMimeType: 'image/png',
            tailImagePath: lastFrame, tailMimeType: 'image/png',
          }, provider.apiKey, provider.baseUrl);
          if (!result.providerTaskId) throw new Error('Submission returned no task ID; do not resend');
          job.taskId = result.providerTaskId; job.status = 'pending'; save();
        } else if (mode === 'poll' && job.taskId && !['downloaded', 'failed'].includes(job.status)) {
          const result = await openaiVideoAdapter.poll(job.taskId, provider.apiKey, provider.baseUrl);
          job.status = result.status;
          if (result.errorMessage) job.error = result.errorMessage;
          else delete job.error;
          save();
          if (result.status === 'succeeded' && result.videoUrl) {
            const download = await downloadGatewayMedia(result.videoUrl, provider.baseUrl, provider.apiKey);
            if (!download.ok) throw new Error(download.errorMessage);
            job.videoPath = path.join(directory, `${job.model}.mp4`);
            fs.writeFileSync(job.videoPath, download.buffer);
            job.status = 'downloaded'; job.finishedAt = new Date().toISOString(); save();
          }
        }
      } catch (error) {
        job.error = sanitizeGatewayMediaDiagnostic(error instanceof Error ? error.message : String(error), provider.apiKey).slice(0, 1000);
        if (job.status === 'submitting') job.status = 'submission_error';
        save();
      }
      console.log(JSON.stringify(job));
    }
  } finally { db.close(); }
} else if (mode === 'inspect') {
  const { probeVideoMedia, runFfmpeg } = await import('../lib/ffmpeg.ts');
  for (const job of jobs) {
    if (job.status !== 'downloaded' || !job.videoPath) continue;
    const media = await probeVideoMedia(job.videoPath);
    if (!media.width || !media.height) throw new Error('Unable to probe downloaded video');
    job.media = media; save();
    for (const [name, seconds] of [['first', 0], ['middle', media.durationUs / 2e6], ['last', null]] as const) {
      const output = path.join(directory, `${job.model}-${name}.png`);
      // These short smoke clips fit in memory. Decode to the actual last video
      // frame: container/audio duration can extend beyond its timestamp.
      await runFfmpeg(['-y', '-i', job.videoPath, ...(seconds === null ? ['-vf', 'reverse'] : ['-ss', String(seconds)]), '-frames:v', '1', output], { timeoutMs: 30000 });
      if (!fs.existsSync(output)) throw new Error(`No ${name} frame extracted for ${job.model}`);
    }
    console.log(JSON.stringify(job));
  }
} else if (mode === 'status') {
  console.log(JSON.stringify(jobs, null, 2));
} else throw new Error('Use prepare, submit --confirm-paid, poll, inspect, or status');
