import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const MIB = 1024 * 1024;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-reference-preprocess-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });

const {
  prepareVideoJobImage,
  videoImageBudget,
  VideoPreprocessError,
  videoPreprocessErrorCode,
  videoSourceImageLocalLimits,
} = await import('../lib/video-reference-preprocess.ts');

/** 真实 sharp 编码的大图：3200x3000 模糊噪声 PNG，稳定大于 11 MiB。 */
async function writeLargePng(filePath: string): Promise<number> {
  const width = 3200;
  const height = 3000;
  await sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .blur(5)
    .png({ compressionLevel: 6 })
    .toFile(filePath);
  return fs.statSync(filePath).size;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function measure(buffer: Buffer) {
  const metadata = await sharp(buffer).metadata();
  return {
    format: metadata.format,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    hasAlpha: Boolean(metadata.hasAlpha),
  };
}

const deliveryDir = path.join(storageRoot, 'video-derivatives');
function derivativeFiles(): string[] {
  if (!fs.existsSync(deliveryDir)) return [];
  return fs.readdirSync(deliveryDir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => !entry.endsWith('.tmp'));
}

try {
  // ── 预算合同：单一来源，参考/首帧/尾帧各自正确；其他模型保持既有行为 ──
  const h3Reference = videoImageBudget('openai-video', 'minimax-h3', 'reference');
  const wanReference = videoImageBudget('openai-video', 'wan-3.0', 'reference');
  assert.ok(h3Reference && wanReference);
  assert.equal(h3Reference.maxBytes, 10 * MIB, 'H3 全能参考图上游预算 10 MiB');
  assert.equal(wanReference.maxBytes, 10 * MIB, 'Wan 全能参考图上游预算 10 MiB');
  assert.deepEqual([...h3Reference.mimeTypes], ['image/jpeg', 'image/png'], '公司首尾帧/参考只接受 jpeg/png');
  const h3First = videoImageBudget('openai-video', 'minimax-h3', 'first-frame');
  const h3Last = videoImageBudget('openai-video', 'minimax-h3', 'last-frame');
  const wanLast = videoImageBudget('openai-video', 'wan-3.0', 'last-frame');
  assert.ok(h3First && h3Last && wanLast);
  assert.equal(h3First.maxBytes, 10 * MIB, '腾讯 FileInfos 首帧限 10 MiB');
  assert.ok(h3Last.maxBytes < h3First.maxBytes, '尾帧预算必须比首帧更严（LastFrameUrl 限 5M）');
  assert.ok(h3Last.maxBytes <= 5 * 1024 * 1024, '尾帧预算不得高于 5M 硬限');
  assert.equal(wanLast.maxBytes, h3Last.maxBytes, '首尾帧预算按角色而不是按模型分叉');
  assert.deepEqual([...h3Last.mimeTypes], ['image/jpeg', 'image/png']);
  // 非本轮对象：不得凭空给别的模型套严格预算（既有默认处理行为不变）
  for (const [type, model] of [
    ['openai-video', 'kling-3.0'],
    ['openai-video', 'doubao-seedance-2-0-260128'],
    ['jimeng', 'doubao-seedance-2-5-260628'],
    ['kling', 'kling-v3'],
  ] as const) {
    assert.equal(videoImageBudget(type, model, 'reference'), null, `${type}/${model} 不得获得参考图严格预算`);
    assert.equal(videoImageBudget(type, model, 'first-frame'), null, `${type}/${model} 不得获得首帧严格预算`);
    assert.equal(videoImageBudget(type, model, 'last-frame'), null, `${type}/${model} 不得获得尾帧严格预算`);
  }

  // ── 11 MiB 以上真实图片：压到参考预算内，输出以实际 MIME/大小/尺寸验证 ──
  const largePath = path.join(storageRoot, 'large.png');
  const largeBytes = await writeLargePng(largePath);
  assert.ok(largeBytes > 11 * MIB, `测试素材必须是 11 MiB 以上真实图片，实得 ${largeBytes}`);
  const largeHash = sha256File(largePath);
  const largeMtime = fs.statSync(largePath).mtimeMs;

  const preparedLarge = await prepareVideoJobImage({
    providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: largePath,
  });
  assert.ok(preparedLarge, 'H3 参考图必须返回预处理结果');
  const prepared = preparedLarge.prepared;
  assert.equal(prepared.derived, true, '超预算原图必须生成派生副本');
  assert.notEqual(prepared.absolutePath, largePath, '不得就地改写原图');
  assert.ok(prepared.byteSize <= h3Reference.maxBytes, `派生副本必须真正满足预算，实得 ${prepared.byteSize}`);
  const preparedBuffer = fs.readFileSync(prepared.absolutePath);
  assert.equal(preparedBuffer.byteLength, prepared.byteSize, '返回的字节数必须等于磁盘实际字节数');
  const preparedFiles = derivativeFiles();
  assert.ok(preparedFiles.length > 0, '派生物必须落在 dataRoot 下的 storage');
  assert.ok(prepared.absolutePath.startsWith(storageRoot), '派生物路径必须基于 dataRoot');
  const measuredPrepared = await measure(preparedBuffer);
  assert.equal(`image/${measuredPrepared.format === 'jpeg' ? 'jpeg' : measuredPrepared.format}`, prepared.mimeType,
    '输出 MIME 必须与实际字节格式一致');
  assert.ok(h3Reference.mimeTypes.includes(prepared.mimeType), '输出格式必须在上游允许格式内');
  assert.ok(measuredPrepared.width <= h3Reference.maxDimension && measuredPrepared.height <= h3Reference.maxDimension,
    '输出尺寸必须在预算内');
  assert.equal(prepared.width, measuredPrepared.width);
  assert.equal(prepared.height, measuredPrepared.height);
  // 源图身份不变：字节、mtime、哈希都不改
  assert.equal(sha256File(largePath), largeHash, '原图字节不得被修改');
  assert.equal(fs.statSync(largePath).mtimeMs, largeMtime, '原图不得被重写');
  assert.equal(fs.statSync(largePath).size, largeBytes);
  // 安全指标：只含来源/交付的字节与尺寸，不含路径
  assert.deepEqual(prepared.metrics, {
    sourceByteSize: largeBytes,
    sourceWidth: 3200,
    sourceHeight: 3000,
    deliveredByteSize: prepared.byteSize,
    deliveredWidth: prepared.width,
    deliveredHeight: prepared.height,
    deliveredMimeType: prepared.mimeType,
    derived: true,
  });
  assert.equal(JSON.stringify(prepared.metrics).includes(storageRoot), false, '指标不得包含本地路径');

  // ── 幂等：同源图第二次调用命中同一派生物，不重复编码出新文件 ──
  const again = await prepareVideoJobImage({
    providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: largePath,
  });
  assert.ok(again);
  assert.equal(again.prepared.absolutePath, prepared.absolutePath, '同源图 + 同预算必须复用缓存派生物');
  assert.equal(again.prepared.byteSize, prepared.byteSize);

  // ── 小型合规图片：原样交付，不做无谓的有损重编码 ──
  const smallPath = path.join(storageRoot, 'small.jpg');
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#336699' } })
    .jpeg({ quality: 88 }).toFile(smallPath);
  const smallBytes = fs.statSync(smallPath).size;
  assert.ok(smallBytes < 400 * 1024, '小图测试素材应为远低于预算的合规图片');
  const smallHash = sha256File(smallPath);
  const preparedSmall = await prepareVideoJobImage({
    providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: smallPath,
  });
  assert.ok(preparedSmall);
  assert.equal(preparedSmall.prepared.derived, false, '合规小图不得重编码');
  assert.equal(preparedSmall.prepared.absolutePath, smallPath, '合规小图必须原样交付');
  assert.equal(preparedSmall.prepared.byteSize, smallBytes);
  assert.equal(preparedSmall.prepared.mimeType, 'image/jpeg');
  assert.equal(sha256File(smallPath), smallHash, '原图字节不得被修改');

  // ── PNG 透明通道：预算允许 png 时保留透明通道（无损优先），不许静默压成黑底 ──
  const alphaWidth = 1800;
  const alphaHeight = 1800;
  const alphaPath = path.join(storageRoot, 'alpha.png');
  await sharp(crypto.randomBytes(alphaWidth * alphaHeight * 4), {
    raw: { width: alphaWidth, height: alphaHeight, channels: 4 },
  }).png({ compressionLevel: 6 }).toFile(alphaPath);
  assert.ok(fs.statSync(alphaPath).size > 10 * MIB, '透明 PNG 素材必须先超预算');
  const preparedAlpha = await prepareVideoJobImage({
    providerType: 'openai-video', model: 'wan-3.0', role: 'first-frame', absolutePath: alphaPath,
  });
  assert.ok(preparedAlpha);
  assert.equal(preparedAlpha.prepared.mimeType, 'image/png', '预算允许 png 时透明图必须保留 png');
  assert.ok(preparedAlpha.prepared.byteSize <= h3First.maxBytes);
  const alphaMeasured = await measure(fs.readFileSync(preparedAlpha.prepared.absolutePath));
  assert.equal(alphaMeasured.format, 'png');
  assert.equal(alphaMeasured.hasAlpha, true, '保留 png 时必须保留透明通道');
  assert.ok(alphaMeasured.width <= h3First.maxDimension && alphaMeasured.height <= h3First.maxDimension);

  // ── jpeg-only 预算：透明图必须压平为 jpeg，且不得残留 alpha ──
  const preparedAlphaJpeg = await prepareVideoJobImage({
    providerType: 'openai-video', model: 'minimax-h3', role: 'reference',
    absolutePath: alphaPath,
    budget: { maxBytes: 2 * MIB, maxDimension: 2048, mimeTypes: ['image/jpeg'] },
  });
  assert.ok(preparedAlphaJpeg);
  assert.equal(preparedAlphaJpeg.prepared.mimeType, 'image/jpeg', 'jpeg-only 预算下透明图必须压平为 jpeg');
  const alphaJpegMeasured = await measure(fs.readFileSync(preparedAlphaJpeg.prepared.absolutePath));
  assert.equal(alphaJpegMeasured.format, 'jpeg');
  assert.equal(alphaJpegMeasured.hasAlpha, false, '压平后不得残留透明通道');
  assert.ok(preparedAlphaJpeg.prepared.byteSize <= 2 * MIB);

  // ── WebP 源图在只接受 png/jpeg 的预算下必须转成受支持格式 ──
  const webpPath = path.join(storageRoot, 'source.webp');
  await sharp({ create: { width: 900, height: 700, channels: 3, background: '#993366' } })
    .webp({ quality: 90 }).toFile(webpPath);
  const preparedWebp = await prepareVideoJobImage({
    providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: webpPath,
  });
  assert.ok(preparedWebp);
  assert.equal(preparedWebp.prepared.derived, true, 'webp 不在上游允许格式内，必须转码');
  assert.ok(['image/jpeg', 'image/png'].includes(preparedWebp.prepared.mimeType));
  assert.equal(
    `image/${(await measure(fs.readFileSync(preparedWebp.prepared.absolutePath))).format}`,
    preparedWebp.prepared.mimeType,
  );

  // ── 损坏图：明确错误，不回退原图 ──
  const corruptPath = path.join(storageRoot, 'corrupt.png');
  fs.writeFileSync(corruptPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4000, 7)]));
  await assert.rejects(
    () => prepareVideoJobImage({
      providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: corruptPath,
    }),
    (error: unknown) => {
      assert.ok(error instanceof VideoPreprocessError);
      assert.equal(error.code, 'source_unreadable');
      assert.equal(videoPreprocessErrorCode(error), 'source_unreadable');
      return true;
    },
  );

  // ── 动画图：明确拒绝，不静态化 ──
  const frames = await Promise.all(['#ff0000', '#00ff00'].map((background) =>
    sharp({ create: { width: 320, height: 240, channels: 3, background } }).png().toBuffer()));
  const animatedPath = path.join(storageRoot, 'animated.webp');
  fs.writeFileSync(animatedPath, await sharp(frames, { join: { animated: true } }).webp().toBuffer());
  await assert.rejects(
    () => prepareVideoJobImage({
      providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: animatedPath,
    }),
    (error: unknown) => {
      assert.ok(error instanceof VideoPreprocessError);
      assert.equal(error.code, 'source_animated');
      return true;
    },
  );

  // ── 超出本机像素保护上限：明确拒绝 ──
  const pixelPath = path.join(storageRoot, 'pixels.png');
  await sharp({ create: { width: 2000, height: 1600, channels: 3, background: '#123456' } }).png().toFile(pixelPath);
  process.env.CREATIVE_STUDIO_VIDEO_SOURCE_MAX_PIXELS = '1000000';
  try {
    assert.equal(videoSourceImageLocalLimits().maxPixels, 1_000_000);
    await assert.rejects(
      () => prepareVideoJobImage({
        providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: pixelPath,
      }),
      (error: unknown) => {
        assert.ok(error instanceof VideoPreprocessError);
        assert.equal(error.code, 'source_pixels_exceeded');
        return true;
      },
    );
  } finally {
    delete process.env.CREATIVE_STUDIO_VIDEO_SOURCE_MAX_PIXELS;
  }

  // ── 超出本机文件大小保护上限：明确拒绝 ──
  process.env.CREATIVE_STUDIO_VIDEO_SOURCE_MAX_BYTES = '1024';
  try {
    await assert.rejects(
      () => prepareVideoJobImage({
        providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: smallPath,
      }),
      (error: unknown) => {
        assert.ok(error instanceof VideoPreprocessError);
        assert.equal(error.code, 'source_too_large');
        return true;
      },
    );
  } finally {
    delete process.env.CREATIVE_STUDIO_VIDEO_SOURCE_MAX_BYTES;
  }

  // ── 有限阶梯压不到预算：抛错，绝不回退发送不合格原图 ──
  const noisePath = path.join(storageRoot, 'noise.png');
  await sharp(crypto.randomBytes(1600 * 1200 * 3), { raw: { width: 1600, height: 1200, channels: 3 } })
    .png({ compressionLevel: 3 }).toFile(noisePath);
  await assert.rejects(
    () => prepareVideoJobImage({
      providerType: 'openai-video', model: 'minimax-h3', role: 'last-frame',
      absolutePath: noisePath,
      budget: { maxBytes: 2048, maxDimension: 4096, mimeTypes: ['image/jpeg'] },
    }),
    (error: unknown) => {
      assert.ok(error instanceof VideoPreprocessError);
      assert.equal(error.code, 'budget_unreachable');
      return true;
    },
  );

  // ── 取消：预处理在读字节/编码之间就停，不产生派生物 ──
  const abortController = new AbortController();
  abortController.abort();
  const beforeAbortFiles = derivativeFiles().length;
  await assert.rejects(
    () => prepareVideoJobImage({
      providerType: 'openai-video', model: 'minimax-h3', role: 'reference',
      absolutePath: largePath, signal: abortController.signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof VideoPreprocessError);
      assert.equal(error.code, 'aborted');
      return true;
    },
  );
  assert.equal(derivativeFiles().length, beforeAbortFiles, '取消不得留下派生物');
  for (const file of derivativeFiles()) {
    assert.ok(!file.endsWith('.tmp'), `不得留下临时文件：${file}`);
  }

  // ── 文件不存在：明确错误 ──
  await assert.rejects(
    () => prepareVideoJobImage({
      providerType: 'openai-video', model: 'minimax-h3', role: 'reference',
      absolutePath: path.join(storageRoot, 'missing.png'),
    }),
    (error: unknown) => {
      assert.ok(error instanceof VideoPreprocessError);
      assert.equal(error.code, 'source_missing');
      return true;
    },
  );

  // ── 没有严格预算的模型：调用方必须自己判断，不得伪造结果 ──
  assert.equal(await prepareVideoJobImage({
    providerType: 'openai-video', model: 'kling-3.0', role: 'first-frame', absolutePath: largePath,
  }), null);

  console.log('video reference preprocess tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
