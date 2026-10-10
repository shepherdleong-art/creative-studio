import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { dataRoot } from '../../lib/data-root.ts';
import { submitGatewayTaskImage, pollGatewayTaskImage } from '../../lib/providers/gateway-task-image.ts';
import { openaiVideoAdapter } from '../../lib/video-providers/openai-video.ts';
import { downloadGatewayMedia, sanitizeGatewayMediaDiagnostic } from '../../lib/gateway-media-url.ts';
import { local } from './runtime.mjs';

export function companyAdapter(project) {
  try { process.loadEnvFile(path.join(process.cwd(), '.env.local')); } catch {}
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = new URL(String(url));
    if (init?.method === 'POST' && u.hostname === '127.0.0.1' && u.pathname.startsWith('/v1/')) {
      const body = JSON.parse(init.body), values = body.image || body.images || [];
      const refs = Array.isArray(values) ? values : [values];
      if (refs.some(ref => !String(ref).startsWith('https://') && !(body.model.startsWith('qiniuyun/') && String(ref).startsWith('data:image/')))) throw new Error('COS delivery failed; local reference fallback blocked before submission');
    }
    return realFetch(url, init);
  };
  const credentials = new Map();
  function provider(job) {
    const id = `${job.kind}:${job.providerId}`;
    if (!credentials.has(id)) {
      const db = new Database(path.join(dataRoot(), 'data/workbench.db'), { readonly: true, fileMustExist: true });
      let row;
      try { row = db.prepare(`SELECT apiKey, baseUrl FROM ${job.kind === 'image' ? 'providers' : 'video_providers'} WHERE id = ?`).get(job.providerId); } finally { db.close(); }
      const u = row && new URL(row.baseUrl);
      if (!row || u.hostname !== '127.0.0.1' || u.protocol !== 'http:') throw new Error('Expected configured loopback company provider');
      credentials.set(id, row);
    }
    return credentials.get(id);
  }
  async function safe(job, action) {
    const p = provider(job);
    try { return await action(p); } catch (e) { throw new Error(sanitizeGatewayMediaDiagnostic(String(e.message), p.apiKey)); }
  }
  const mime = file => file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return {
    submit: job => safe(job, async p => {
      const prompt = fs.readFileSync(local(project, job.prompt), 'utf8');
      if (job.kind === 'image') {
        const refs = (job.references || []).map(f => local(project, f));
        const r = await submitGatewayTaskImage({ model: job.model, prompt, inputImagePath: local(project, job.input), inputMimeType: mime(job.input), referenceImagePaths: refs, referenceMimeTypes: refs.map(mime), size: '1728x2304', quality: 'medium' }, p.apiKey, p.baseUrl, { timeoutMs: 600000 });
        return { taskId: r.taskId, mediaUrl: r.immediateImageUrl, transports: r.imageTransports };
      }
      const r = await openaiVideoAdapter.submit({ model: job.model, prompt, sourceImagePath: local(project, job.input), sourceMimeType: mime(job.input), durationSec: job.durationSec, multiShot: false, ...(job.tailInput ? { tailImagePath: local(project, job.tailInput), tailMimeType: mime(job.tailInput) } : {}) }, p.apiKey, p.baseUrl);
      return { taskId: r.providerTaskId, mediaUrl: r.immediateVideoUrl };
    }),
    poll: (job, id) => safe(job, async p => {
      const r = job.kind === 'image' ? await pollGatewayTaskImage(id, p.apiKey, p.baseUrl) : await openaiVideoAdapter.poll(id, p.apiKey, p.baseUrl);
      return { status: r.status, mediaUrl: r.imageUrl || r.videoUrl, error: r.errorMessage && sanitizeGatewayMediaDiagnostic(r.errorMessage, p.apiKey) };
    }),
    download: (job, url) => safe(job, async p => {
      const result = await downloadGatewayMedia(url, p.baseUrl, p.apiKey);
      if (!result.ok) throw new Error(result.errorMessage);
      if (job.kind !== 'image') return { buffer: result.buffer };
      const meta = await sharp(result.buffer).metadata();
      return { buffer: await sharp(result.buffer).png().toBuffer(), dimensions: [meta.width, meta.height] };
    }),
    close() { globalThis.fetch = realFetch; },
  };
}
