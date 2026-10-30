import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { CORE_DB_MIGRATIONS } from '../lib/db-migrations.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
interface ResolvedModule { url: string; format?: string | null; shortCircuit?: boolean }
type NextResolve = (specifier: string, context?: unknown) => ResolvedModule;
const { registerHooks } = module as unknown as {
  registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolvedModule }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = path.join(repoRoot, specifier.slice(2));
      const candidate = fs.existsSync(base) && fs.statSync(base).isFile()
        ? base
        : EXTENSIONS.map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
      if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' && !specifier.startsWith('.') && !specifier.startsWith('/')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});

// 旧库只追加新表与索引，不改 video_jobs；外键保证快照顺序和删除语义。
{
  const oldDb = new Database(':memory:');
  oldDb.pragma('foreign_keys = ON');
  oldDb.exec('CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE video_jobs (id TEXT PRIMARY KEY);');
  for (const sql of CORE_DB_MIGRATIONS.filter((migration) => /video_reference_assets|video_job_references/.test(migration))) {
    oldDb.exec(sql);
  }
  oldDb.prepare("INSERT INTO projects VALUES ('legacy-project')").run();
  oldDb.prepare("INSERT INTO video_jobs VALUES ('legacy-job')").run();
  oldDb.prepare(`INSERT INTO video_reference_assets
    (id, projectId, kind, filename, path, mimeType, byteSize)
    VALUES ('legacy-asset', 'legacy-project', 'image', 'old.png', '/old.png', 'image/png', 10)`).run();
  oldDb.prepare("INSERT INTO video_job_references VALUES ('legacy-job', 0, 'legacy-asset')").run();
  assert.throws(
    () => oldDb.prepare("INSERT INTO video_job_references VALUES ('legacy-job', 0, 'legacy-asset')").run(),
    /UNIQUE constraint failed/,
  );
  assert.throws(() => oldDb.prepare("DELETE FROM video_reference_assets WHERE id = 'legacy-asset'").run(), /FOREIGN KEY constraint failed/);
  oldDb.prepare("DELETE FROM video_jobs WHERE id = 'legacy-job'").run();
  assert.deepEqual(oldDb.prepare('SELECT COUNT(*) AS count FROM video_job_references').get(), { count: 0 });
  oldDb.prepare("DELETE FROM video_reference_assets WHERE id = 'legacy-asset'").run();
  oldDb.close();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-reference-assets-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

const { getDb, closeDb } = await import('../lib/db.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
const uploadRoute = await import('../app/api/projects/[id]/video-reference-assets/route.ts');
const assetRoute = await import('../app/api/video-reference-assets/[id]/route.ts');
const projectRoute = await import('../app/api/projects/[id]/route.ts');

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

interface AssetView {
  id: string;
  kind: 'image' | 'video' | 'audio';
  filename: string;
  mimeType: string;
  byteSize: number;
  durationSec: number | null;
  url: string;
}

async function responseJson(response: Response): Promise<{ files?: AssetView[]; error?: string; success?: boolean }> {
  return await response.json() as { files?: AssetView[]; error?: string; success?: boolean };
}

function uploadRequest(projectId: string, files: File[], claimedProjectId?: string) {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  if (claimedProjectId) form.set('projectId', claimedProjectId);
  return uploadRoute.POST(new Request(`http://local/api/projects/${projectId}/video-reference-assets`, {
    method: 'POST',
    body: form,
  }), params(projectId));
}

const db = getDb();
assert.deepEqual(
  (db.prepare('PRAGMA table_info(video_reference_assets)').all() as Array<{ name: string }>).map((column) => column.name),
  ['id', 'projectId', 'kind', 'filename', 'path', 'mimeType', 'byteSize', 'durationSec', 'createdAt'],
  '新库必须直接创建完整参考素材表',
);
const referenceForeignKeys = db.prepare('PRAGMA foreign_key_list(video_job_references)').all() as Array<{ table: string; on_delete: string }>;
assert.ok(referenceForeignKeys.some((key) => key.table === 'video_jobs' && key.on_delete === 'CASCADE'));
assert.ok(referenceForeignKeys.some((key) => key.table === 'video_reference_assets' && key.on_delete === 'RESTRICT'));

db.prepare("INSERT INTO providers (id, name, baseUrl) VALUES ('test-provider', '测试', 'http://local')").run();
db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES
  ('project-a', '项目 A', 'test-provider', 'gpt-image-2', ''),
  ('project-b', '项目 B', 'test-provider', 'gpt-image-2', '')`).run();

const png = await sharp({
  create: { width: 3, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
}).png().toBuffer();

// URL 项目才是归属；伪造的 form projectId 与浏览器 MIME 均不参与真实类型/归属判断。
const imageUpload = await uploadRequest('project-a', [new File([Uint8Array.from(png)], '像素.png', { type: 'video/mp4' })], 'project-b');
const imageBody = await responseJson(imageUpload);
assert.equal(imageUpload.status, 200, JSON.stringify(imageBody));
const image = imageBody.files![0];
assert.equal(image.kind, 'image');
assert.equal(image.mimeType, 'image/png');
assert.equal(image.byteSize, png.length);
assert.equal(image.durationSec, null);
assert.equal(image.url, `/api/video-reference-assets/${image.id}`);
const imageRow = db.prepare('SELECT projectId, path, byteSize FROM video_reference_assets WHERE id = ?').get(image.id) as { projectId: string; path: string; byteSize: number };
assert.equal(imageRow.projectId, 'project-a');
assert.equal(path.dirname(imageRow.path), path.join(root, 'storage', 'video-references', 'project-a'));
assert.deepEqual(fs.readFileSync(imageRow.path), png, '上传图片必须原样保存，不得压缩');

const fullImage = await assetRoute.GET(new Request(`http://local${image.url}`), params(image.id));
assert.equal(fullImage.status, 200);
assert.equal(fullImage.headers.get('content-type'), 'image/png');
assert.equal(fullImage.headers.get('content-length'), String(png.length));
assert.equal(fullImage.headers.get('accept-ranges'), 'bytes');
assert.deepEqual(Buffer.from(await fullImage.arrayBuffer()), png);
const rangeImage = await assetRoute.GET(new Request(`http://local${image.url}`, { headers: { range: 'bytes=1-3' } }), params(image.id));
assert.equal(rangeImage.status, 206);
assert.equal(rangeImage.headers.get('content-range'), `bytes 1-3/${png.length}`);
assert.equal(rangeImage.headers.get('content-length'), '3');
assert.deepEqual(Buffer.from(await rangeImage.arrayBuffer()), png.subarray(1, 4));
assert.equal((await assetRoute.GET(new Request('http://local/api/video-reference-assets/missing'), params('missing'))).status, 404);

const unknownProjectUpload = await uploadRequest('missing-project', [new File([Uint8Array.from(png)], 'unknown.png', { type: 'image/png' })]);
assert.equal(unknownProjectUpload.status, 404);
assert.equal(fs.existsSync(path.join(root, 'storage', 'video-references', 'missing-project')), false);
const invalidUpload = await uploadRequest('project-a', [
  new File([Uint8Array.from(png)], 'rollback.png', { type: 'image/png' }),
  new File([Uint8Array.from(png.subarray(0, 12))], 'truncated.png', { type: 'image/png' }),
]);
assert.equal(invalidUpload.status, 400);
assert.equal((db.prepare('SELECT COUNT(*) AS count FROM video_reference_assets').get() as { count: number }).count, 1, '失败上传不得留下数据库行');
assert.deepEqual(fs.readdirSync(path.join(root, 'storage', 'video-references', 'project-a')), [path.basename(imageRow.path)], '失败上传不得留下临时文件或半成品');

const sampleVideo = path.join(root, 'sample.mp4');
const sampleAudio = path.join(root, 'sample.wav');
await runFfmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=duration=0.25:size=64x64:rate=12',
  '-pix_fmt', 'yuv420p', '-y', sampleVideo,
]);
await runFfmpeg([
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25',
  '-c:a', 'pcm_s16le', '-y', sampleAudio,
]);
const videoBytes = fs.readFileSync(sampleVideo);
const audioBytes = fs.readFileSync(sampleAudio);
const mediaUpload = await uploadRequest('project-a', [
  new File([Uint8Array.from(videoBytes)], '参考.mp4', { type: 'audio/mpeg' }),
  new File([Uint8Array.from(audioBytes)], '参考.wav', { type: 'video/mp4' }),
]);
const mediaBody = await responseJson(mediaUpload);
assert.equal(mediaUpload.status, 200, JSON.stringify(mediaBody));
const [video, audio] = mediaBody.files!;
assert.equal(video.kind, 'video');
assert.equal(video.mimeType, 'video/mp4');
assert.equal(audio.kind, 'audio');
assert.equal(audio.mimeType, 'audio/wav');
assert.ok(video.durationSec! > 0 && video.durationSec! <= 30);
assert.ok(audio.durationSec! > 0 && audio.durationSec! <= 30);
const videoRow = db.prepare('SELECT path FROM video_reference_assets WHERE id = ?').get(video.id) as { path: string };
assert.deepEqual(fs.readFileSync(videoRow.path), videoBytes, '视频必须原样保存');
const videoRange = await assetRoute.GET(new Request(`http://local${video.url}`, { headers: { range: 'bytes=0-15' } }), params(video.id));
assert.equal(videoRange.status, 206);
assert.equal(videoRange.headers.get('content-type'), 'video/mp4');
assert.equal(videoRange.headers.get('content-length'), '16');
assert.equal(videoRange.headers.get('accept-ranges'), 'bytes');
assert.deepEqual(Buffer.from(await videoRange.arrayBuffer()), videoBytes.subarray(0, 16));

// 未被快照引用的素材可删；DB 提交后才删文件，重复删除是清楚的 404。
const audioRow = db.prepare('SELECT path FROM video_reference_assets WHERE id = ?').get(audio.id) as { path: string };
assert.equal((await assetRoute.DELETE(new Request(`http://local${audio.url}`, { method: 'DELETE' }), params(audio.id))).status, 200);
assert.equal(fs.existsSync(audioRow.path), false);
assert.equal(db.prepare('SELECT 1 FROM video_reference_assets WHERE id = ?').get(audio.id), undefined);
assert.equal((await assetRoute.DELETE(new Request(`http://local${audio.url}`, { method: 'DELETE' }), params(audio.id))).status, 404);

// 有任务快照的素材禁止单删；项目删除先解除有序引用，再返回全部待删路径。
db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path)
  VALUES ('source-image', 'project-a', 'input', 'source.png', ?)`).run(imageRow.path);
const videoProvider = db.prepare('SELECT id FROM video_providers LIMIT 1').get() as { id: string };
db.prepare(`INSERT INTO video_jobs (id, projectId, sourceImageId, providerId, model, prompt)
  VALUES ('reference-job', 'project-a', 'source-image', ?, 'test-model', 'test')`).run(videoProvider.id);
db.prepare("INSERT INTO video_job_references VALUES ('reference-job', 0, ?), ('reference-job', 1, ?)").run(image.id, video.id);
assert.equal((await assetRoute.DELETE(new Request(`http://local${image.url}`, { method: 'DELETE' }), params(image.id))).status, 409);
assert.equal(fs.existsSync(imageRow.path), true);

const projectDeleteRequest = new Request('http://local/api/projects/project-a', { method: 'DELETE' }) as Parameters<typeof projectRoute.DELETE>[0];
const projectDelete = await projectRoute.DELETE(projectDeleteRequest, params('project-a'));
assert.equal(projectDelete.status, 200, JSON.stringify(await responseJson(projectDelete)));
assert.equal(db.prepare("SELECT 1 FROM projects WHERE id = 'project-a'").get(), undefined);
assert.equal(db.prepare("SELECT 1 FROM projects WHERE id = 'project-b'").get() !== undefined, true);
assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM video_job_references WHERE jobId = 'reference-job'").get(), { count: 0 });
assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM video_reference_assets').get(), { count: 0 });
assert.equal(fs.existsSync(imageRow.path), false);
assert.equal(fs.existsSync(videoRow.path), false);
assert.equal((await assetRoute.GET(new Request(`http://local${image.url}`), params(image.id))).status, 404);

closeDb();
fs.rmSync(root, { recursive: true, force: true });
console.log('video-reference-assets tests passed');
