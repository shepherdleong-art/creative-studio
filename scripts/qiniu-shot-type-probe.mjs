// One explicitly authorized 5-second comparison. Default is dry-run; a saved
// submission intent prevents an ambiguous request from being submitted twice.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const jobId = process.argv.find(arg => arg.startsWith('--job='))?.slice(6);
const multiShot = process.argv.includes('--multi-shot');
const probeName = multiShot ? 'multi-shot' : 'single-shot';
if (!jobId || !/^[a-f0-9-]{36}$/.test(jobId)) throw new Error('Provide --job=<existing failed job UUID>');
const { dataRoot } = await import('../lib/data-root.ts');
const root = dataRoot();
if (fs.existsSync(path.join(root, '.env.local'))) process.loadEnvFile(path.join(root, '.env.local'));
const db = new Database(path.join(root, 'data', 'workbench.db'), { readonly: true });
const job = db.prepare('SELECT * FROM video_jobs WHERE id=?').get(jobId);
if (!job || job.model !== 'qiniuyun/kling-3.0' || job.status !== 'failed' || job.durationSec !== 5) {
  throw new Error('Only an existing failed qiniuyun/kling-3.0 5-second task is eligible');
}
const provider = db.prepare('SELECT * FROM video_providers WHERE id=?').get(job.providerId);
const source = db.prepare('SELECT * FROM image_assets WHERE id=?').get(job.sourceImageId);
const tail = job.tailImageId ? db.prepare('SELECT * FROM image_assets WHERE id=?').get(job.tailImageId) : null;
db.close();
if (!provider || !source || (job.tailImageId && !tail)) throw new Error('Missing frozen input/provider');
const { resolveVideoProviderRuntimeConfig } = await import('../lib/video-auth.ts');
const runtime = resolveVideoProviderRuntimeConfig(provider);
if (!runtime.enabled || !runtime.configured || !/^http:\/\/127\.0\.0\.1:4000\/?$/.test(runtime.baseUrl)) {
  throw new Error('Expected configured local company proxy on port 4000');
}
const imagePath = image => image.originalPath || image.processedPath || image.path;
const mime = image => /\.jpe?g$/i.test(imagePath(image)) ? 'image/jpeg' : /\.webp$/i.test(imagePath(image)) ? 'image/webp' : image.mimeType;
const request = {
  model: job.model, prompt: job.prompt, durationSec: 5, multiShot,
  sourceImagePath: imagePath(source), sourceMimeType: mime(source),
  ...(tail ? { tailImagePath: imagePath(tail), tailMimeType: mime(tail) } : {}),
};
const summary = { jobId, model: job.model, seconds: 5, multiShot, tailFrame: !!tail };
console.log(JSON.stringify({ dryRun: !process.argv.includes('--execute'), ...summary }));
if (!process.argv.includes('--execute')) process.exit(0);

const outputDir = path.join(root, 'outputs', 'qiniu-shot-type-probe', jobId);
fs.mkdirSync(outputDir, { recursive: true });
const receiptPath = path.join(outputDir, `${probeName}-receipt.json`);
let receipt;
if (fs.existsSync(receiptPath)) {
  receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (receipt.status === 'completed' || receipt.status === 'failed') {
    console.log(JSON.stringify({ status: receipt.status, alreadyFinished: true }));
    process.exit(0);
  }
  if (!receipt.taskId) throw new Error('Prior intent without receipt; do not resubmit. Check upstream manually.');
} else {
  receipt = { ...summary, status: 'submitting', startedAt: new Date().toISOString() };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
}
const save = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
const { openaiVideoAdapter } = await import('../lib/video-providers/openai-video.ts');
const { sanitizeMessage } = await import('../lib/log-sanitize.ts');
if (!receipt.taskId) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (String(input).replace(/\/$/, '').endsWith('/v1/videos') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.model !== summary.model || body.multi_shot !== multiShot || body.shot_type !== (multiShot ? 'intelligence' : undefined)) {
        throw new Error('Probe request differs from authorized comparison');
      }
      receipt.sent = { model: body.model, multi_shot: body.multi_shot, shot_type: body.shot_type ?? null, seconds: body.seconds, size: body.size, images: body.images?.length, tailFrame: !!body.end_image_url };
      save();
      console.log(JSON.stringify({ submitting: receipt.sent }));
    }
    return originalFetch(input, init);
  };
  try {
    const result = await openaiVideoAdapter.submit(request, runtime.apiKey, runtime.baseUrl);
    if (!result.providerTaskId) throw new Error('No remote task ID; do not submit again');
    receipt.taskId = result.providerTaskId;
    receipt.status = 'submitted';
    save();
    console.log('Submitted once; receipt saved.');
  } catch (error) {
    receipt.error = sanitizeMessage(String(error)); save();
    throw new Error(receipt.error);
  } finally { globalThis.fetch = originalFetch; }
}
const deadline = Date.now() + 12 * 60_000;
let lastStatus;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 10_000));
  const result = await openaiVideoAdapter.poll(receipt.taskId, runtime.apiKey, runtime.baseUrl);
  receipt.status = result.status;
  receipt.lastCheckedAt = new Date().toISOString();
  save();
  if (result.status !== lastStatus) console.log(JSON.stringify({ status: result.status }));
  lastStatus = result.status;
  if (result.status === 'failed') {
    receipt.error = sanitizeMessage(result.errorMessage || 'unknown'); save();
    console.log(JSON.stringify({ status: 'failed', error: receipt.error }));
    process.exitCode = 1; break;
  }
  if (result.status === 'succeeded' && result.videoUrl) {
    const { downloadVideoMediaForProvider } = await import('../lib/media-download-policy.ts');
    const download = await downloadVideoMediaForProvider({ providerType: provider.type, url: result.videoUrl, baseUrl: runtime.baseUrl, apiKey: runtime.apiKey });
    if (!download.ok) throw new Error('Download failed; retain receipt and resume, never resubmit');
    const outputPath = path.join(outputDir, `${probeName}.mp4`);
    fs.writeFileSync(outputPath, download.buffer);
    receipt.status = 'completed'; receipt.outputPath = outputPath; save();
    console.log(JSON.stringify({ status: 'completed', outputPath }));
    break;
  }
}
if (!['completed', 'failed'].includes(receipt.status)) {
  console.log('Polling stopped; task receipt retained. Execute again to poll without resubmitting.');
  process.exitCode = 2;
}
