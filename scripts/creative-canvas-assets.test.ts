import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ensureCreativeCanvasSchemaReady } from '../lib/creative-canvas/schema.ts';
import {
  CANVAS_ASSET_MAX_BYTES,
  canvasStorageRoot,
  getCanvasAsset,
  importCanvasAsset,
  parseCanvasByteRange,
  readCanvasAsset,
  requireCanvasAsset,
} from '../lib/creative-canvas/assets.ts';
import { createCanvas, requireCanvas } from '../lib/creative-canvas/repository.ts';
import {
  CANVAS_DELIVERY_LIMITS,
  createDefaultCanvasDeliverer,
  precheckCanvasDeliveryMedia,
} from '../lib/creative-canvas/adapters/media-delivery.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-assets-'));
const storageRoot = canvasStorageRoot(root);
const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-source-'));

const db = new Database(path.join(root, 'workbench.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const migrated = await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'backups') });
assert.equal(migrated.state, 'ready');

const canvas = createCanvas(db, { name: '沙发场景探索' });
const otherCanvas = createCanvas(db, { name: '另一个主题' });

const pngBuffer = await sharp({
  create: { width: 12, height: 8, channels: 3, background: '#336699' },
}).png().toBuffer();

function mp4Buffer(size = 256): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(24, 0);
  header.write('ftypisom', 4, 'latin1');
  return Buffer.concat([header, Buffer.alloc(size - header.length, 7)]);
}

// --- 导入图片：落盘副本、登记尺寸、来源文件移动不影响 --------------------------

let pngAssetId = '';
{
  const sourcePath = path.join(sourceDirectory, '沙发.png');
  fs.writeFileSync(sourcePath, pngBuffer);

  const asset = await importCanvasAsset({
    db,
    canvasId: canvas.id,
    storageRoot,
    filename: '沙发.png',
    mimeType: 'image/png',
    data: fs.readFileSync(sourcePath),
  });
  pngAssetId = asset.id;
  assert.equal(asset.mediaKind, 'image');
  assert.equal(asset.mimeType, 'image/png');
  assert.equal(asset.byteSize, pngBuffer.byteLength);
  assert.equal(asset.width, 12);
  assert.equal(asset.height, 8);
  assert.equal(asset.ready, true);
  assert.match(asset.relativePath, new RegExp(`^canvas/${canvas.id}/assets/[0-9a-f-]+\\.png$`));

  const absolutePath = path.join(storageRoot, asset.relativePath);
  assert.equal(fs.existsSync(absolutePath), true);
  assert.deepEqual(fs.readFileSync(absolutePath), pngBuffer);

  // 源文件被移动／删除，已导入素材仍可读
  fs.rmSync(sourcePath);
  const read = readCanvasAsset({ db, storageRoot, assetId: asset.id });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, pngBuffer);

  // 同内容重复导入复用同一资产身份，不重复占用磁盘
  const second = await importCanvasAsset({
    db,
    canvasId: canvas.id,
    storageRoot,
    filename: '沙发副本.png',
    mimeType: 'image/png',
    data: pngBuffer,
  });
  assert.equal(second.id, asset.id);
  assert.equal(
    fs.readdirSync(path.join(storageRoot, 'canvas', canvas.id, 'assets')).length,
    1,
  );

  // 文件名里的路径片段不能影响落盘位置
  const traversal = await importCanvasAsset({
    db,
    canvasId: canvas.id,
    storageRoot,
    filename: '../../evil.png',
    mimeType: 'image/png',
    data: await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer(),
  });
  assert.match(traversal.relativePath, new RegExp(`^canvas/${canvas.id}/assets/`));
  assert.equal(fs.existsSync(path.join(storageRoot, 'evil.png')), false);
  assert.equal(fs.existsSync(path.join(root, 'evil.png')), false);
}

// --- 导入校验 ---------------------------------------------------------------

{
  await assert.rejects(
    () => importCanvasAsset({
      db,
      canvasId: canvas.id,
      storageRoot,
      filename: '说明.txt',
      mimeType: 'text/plain',
      data: Buffer.from('hello'),
    }),
    (error: unknown) => (error as { code?: string }).code === 'invalid_input',
  );

  await assert.rejects(
    () => importCanvasAsset({
      db,
      canvasId: canvas.id,
      storageRoot,
      filename: '伪装.png',
      mimeType: 'image/png',
      data: Buffer.from('not a real png'),
    }),
    (error: unknown) => (error as { code?: string }).code === 'invalid_input',
  );

  await assert.rejects(
    () => importCanvasAsset({
      db,
      canvasId: canvas.id,
      storageRoot,
      filename: '坏视频.mp4',
      mimeType: 'video/mp4',
      data: Buffer.alloc(64, 1),
    }),
    (error: unknown) => (error as { code?: string }).code === 'invalid_input',
  );

  const oversize = Buffer.alloc(CANVAS_ASSET_MAX_BYTES.image + 1, 0);
  await assert.rejects(
    () => importCanvasAsset({
      db,
      canvasId: canvas.id,
      storageRoot,
      filename: '超大.png',
      mimeType: 'image/png',
      data: oversize,
    }),
    (error: unknown) => (error as { code?: string }).code === 'invalid_input',
  );

  await assert.rejects(
    () => importCanvasAsset({
      db,
      canvasId: 'not-a-canvas',
      storageRoot,
      filename: '沙发.png',
      mimeType: 'image/png',
      data: pngBuffer,
    }),
    (error: unknown) => (error as { code?: string }).code === 'not_found',
  );
}

// --- 视频 Range 读取 --------------------------------------------------------

let videoAssetId = '';
{
  const data = mp4Buffer(256);
  const asset = await importCanvasAsset({
    db,
    canvasId: canvas.id,
    storageRoot,
    filename: '参考视频.mp4',
    mimeType: 'video/mp4',
    data,
  });
  videoAssetId = asset.id;
  assert.equal(asset.mediaKind, 'video');
  assert.equal(asset.mimeType, 'video/mp4');

  const full = readCanvasAsset({ db, storageRoot, assetId: asset.id });
  assert.equal(full.status, 200);
  assert.equal(full.headers['Accept-Ranges'], 'bytes');
  assert.equal(full.headers['Content-Length'], '256');

  const partial = readCanvasAsset({ db, storageRoot, assetId: asset.id, rangeHeader: 'bytes=0-15' });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers['Content-Range'], 'bytes 0-15/256');
  assert.equal(partial.headers['Content-Length'], '16');
  assert.deepEqual(partial.body, data.subarray(0, 16));
  assert.equal(partial.body?.subarray(4, 8).toString('latin1'), 'ftyp');

  const openEnded = readCanvasAsset({ db, storageRoot, assetId: asset.id, rangeHeader: 'bytes=250-' });
  assert.equal(openEnded.status, 206);
  assert.equal(openEnded.headers['Content-Range'], 'bytes 250-255/256');
  assert.equal(openEnded.body?.byteLength, 6);

  const suffix = readCanvasAsset({ db, storageRoot, assetId: asset.id, rangeHeader: 'bytes=-8' });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['Content-Range'], 'bytes 248-255/256');

  const beyondEnd = readCanvasAsset({ db, storageRoot, assetId: asset.id, rangeHeader: 'bytes=0-9999' });
  assert.equal(beyondEnd.status, 206);
  assert.equal(beyondEnd.headers['Content-Range'], 'bytes 0-255/256');

  const invalid = readCanvasAsset({ db, storageRoot, assetId: asset.id, rangeHeader: 'bytes=300-400' });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers['Content-Range'], 'bytes */256');
  assert.equal(invalid.body, null);

  const malformed = readCanvasAsset({ db, storageRoot, assetId: asset.id, rangeHeader: 'items=1-2' });
  assert.equal(malformed.status, 416);

  assert.deepEqual(parseCanvasByteRange(null, 100), null);
  assert.deepEqual(parseCanvasByteRange('bytes=0-9', 100), { start: 0, end: 9 });
}

// --- 归属与文件边界 ---------------------------------------------------------

{
  // 跨画布访问按未找到处理
  assert.throws(
    () => requireCanvasAsset(db, pngAssetId, otherCanvas.id),
    (error: unknown) => (error as { code?: string }).code === 'not_found',
  );
  assert.equal(requireCanvasAsset(db, pngAssetId, canvas.id).id, pngAssetId);

  // 越界相对路径被拒绝
  db.prepare(`
    INSERT INTO creative_canvas_assets
      (id, canvasId, mediaKind, relativePath, contentHash, mimeType, byteSize, ready, createdAt)
    VALUES ('evil-asset', ?, 'image', '../evil.png', 'x', 'image/png', 1, 1, '2026-09-11T00:00:00.000Z')
  `).run(canvas.id);
  assert.throws(() => readCanvasAsset({ db, storageRoot, assetId: 'evil-asset' }));

  // 磁盘文件缺失 → 明确报错，不返回空内容
  const orphan = await importCanvasAsset({
    db,
    canvasId: canvas.id,
    storageRoot,
    filename: '会被删掉.png',
    mimeType: 'image/png',
    data: await sharp({ create: { width: 5, height: 5, channels: 3, background: '#00ff00' } }).png().toBuffer(),
  });
  fs.rmSync(path.join(storageRoot, orphan.relativePath));
  assert.throws(
    () => readCanvasAsset({ db, storageRoot, assetId: orphan.id }),
    (error: unknown) => (error as { code?: string }).code === 'not_found',
  );
  assert.equal(getCanvasAsset(db, orphan.id)?.id, orphan.id);

  assert.equal(getCanvasAsset(db, 'missing-asset'), null);
  assert.equal(requireCanvas(db, canvas.id).name, '沙发场景探索');
  assert.equal(videoAssetId.length > 0, true);
}

// --- 交付前媒体校验（T4：格式／MIME／大小／时长） ------------------------------

{
  const base = { absolutePath: '/tmp/x.mp4', durationSec: 5, byteSize: 1024 };

  // 通过的组合
  assert.deepEqual(precheckCanvasDeliveryMedia({ ...base, kind: 'video', mimeType: 'video/mp4' }), []);
  assert.deepEqual(precheckCanvasDeliveryMedia({
    kind: 'audio', mimeType: 'audio/mpeg', byteSize: 1024, durationSec: 8, absolutePath: '/tmp/x.mp3',
  }), []);

  // 格式不接受
  assert.match(
    precheckCanvasDeliveryMedia({ ...base, kind: 'video', mimeType: 'image/png' })[0],
    /格式不支持/,
  );
  assert.match(
    precheckCanvasDeliveryMedia({
      kind: 'audio', mimeType: 'audio/aac', byteSize: 1024, durationSec: 3, absolutePath: '/tmp/x.aac',
    })[0],
    /格式不支持/,
  );

  // 超出大小与时长
  assert.match(
    precheckCanvasDeliveryMedia({
      ...base,
      kind: 'video',
      mimeType: 'video/mp4',
      byteSize: CANVAS_DELIVERY_LIMITS.video.maxBytes + 1,
    }).join('；'),
    /超过 200 MiB 上限/,
  );
  assert.match(
    precheckCanvasDeliveryMedia({ ...base, kind: 'video', mimeType: 'video/mp4', durationSec: 30 }).join('；'),
    /超过 15s 上限/,
  );

  // 模型级更严的限制覆盖默认值
  const stricter = precheckCanvasDeliveryMedia(
    { ...base, kind: 'image', mimeType: 'image/png', byteSize: 2 * 1024 * 1024 },
    { maxBytes: 1024 * 1024, mimeTypes: ['image/jpeg'] },
  );
  assert.equal(stricter.length, 2);
  assert.match(stricter.join('；'), /格式不支持/);
  assert.match(stricter.join('；'), /超过 1 MiB 上限/);

  // 时长未知时不误报（探测失败不阻塞导入）
  assert.deepEqual(
    precheckCanvasDeliveryMedia({ ...base, kind: 'video', mimeType: 'video/mp4', durationSec: null }),
    [],
  );
}

// --- 缺 COS 时的交付门禁：视频／音频 fail closed，公司必需 COS 的渠道也 fail closed --

{
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CREATIVE_STUDIO_COS_')) delete process.env[key];
  }
  const deliverer = createDefaultCanvasDeliverer();

  await assert.rejects(
    () => deliverer.deliver({
      kind: 'video',
      absolutePath: path.join(storageRoot, 'whatever.mp4'),
      mimeType: 'video/mp4',
      byteSize: 1024,
      durationSec: 5,
      role: 'reference',
      requireCos: false,
      isFrameImage: false,
    }),
    (error: unknown) => (error as { code?: string }).code === 'cos_required_for_media',
  );

  await assert.rejects(
    () => deliverer.deliver({
      kind: 'image',
      absolutePath: path.join(storageRoot, 'whatever.png'),
      mimeType: 'image/png',
      byteSize: 1024,
      durationSec: null,
      role: 'first-frame',
      requireCos: true,
      isFrameImage: true,
    }),
    (error: unknown) => (error as { code?: string }).code === 'cos_not_configured',
  );
}

db.close();
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(sourceDirectory, { recursive: true, force: true });
console.log('creative-canvas-assets.test.ts 通过');
