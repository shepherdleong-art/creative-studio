import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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
  cleanupVideoDerivatives,
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

  // ── 扩展名与内容一致：交付物不会出现「jpeg 字节写成 .png」的错扩展名 ──
  const deliveredExt = path.extname(prepared.absolutePath).toLowerCase();
  const deliveredFormat = (await measure(preparedBuffer)).format;
  const extMatchesFormat = deliveredFormat === 'jpeg'
    ? ['.jpg', '.jpeg'].includes(deliveredExt)
    : deliveredExt === `.${deliveredFormat}`;
  assert.ok(extMatchesFormat, `派生物扩展名 ${deliveredExt} 必须与实际格式 ${deliveredFormat} 一致`);

  // ── 并发：同一源图并行请求只落一份派生物，不串项目、不改原图 ──
  const concurrencySource = path.join(storageRoot, 'concurrent.png');
  await writeLargePng(concurrencySource);
  const concurrencyHash = sha256File(concurrencySource);
  const concurrentResults = await Promise.all([
    prepareVideoJobImage({ providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: concurrencySource }),
    prepareVideoJobImage({ providerType: 'openai-video', model: 'wan-3.0', role: 'reference', absolutePath: concurrencySource }),
    // 尾帧预算（4.8MB）比参考/首帧（10 MiB）严，必须各自物化。
    prepareVideoJobImage({ providerType: 'openai-video', model: 'minimax-h3', role: 'last-frame', absolutePath: concurrencySource }),
  ]);
  assert.ok(concurrentResults.every((entry) => entry !== null));
  // H3 参考与 Wan 参考预算相同 → 同一份派生物；尾帧预算不同 → 不同派生物。
  assert.equal(concurrentResults[0]!.prepared.absolutePath, concurrentResults[1]!.prepared.absolutePath,
    '同预算的两个模型必须复用同一份派生物');
  assert.notEqual(concurrentResults[0]!.prepared.absolutePath, concurrentResults[2]!.prepared.absolutePath,
    '不同预算必须各自物化，不能互相覆盖');
  assert.ok(concurrentResults[2]!.prepared.byteSize <= 4_800_000, '尾帧派生物必须满足更严的尾帧预算');
  assert.equal(sha256File(concurrencySource), concurrencyHash, '并发不得修改原图');

  // 同字节但不同来源（例如两个项目各自上传）必须隔离派生物身份、来源路径与取消状态。
  const sameBytesSourceA = path.join(storageRoot, 'same-bytes-a.png');
  const sameBytesSourceB = path.join(storageRoot, 'same-bytes-b.png');
  fs.copyFileSync(concurrencySource, sameBytesSourceA);
  fs.copyFileSync(concurrencySource, sameBytesSourceB);
  const [sameBytesA, sameBytesB] = await Promise.all([
    prepareVideoJobImage({ providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: sameBytesSourceA }),
    prepareVideoJobImage({ providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: sameBytesSourceB }),
  ]);
  assert.ok(sameBytesA && sameBytesB);
  assert.notEqual(sameBytesA.prepared.absolutePath, sameBytesB.prepared.absolutePath,
    '不同来源不得共享只能绑定一个 derivedFromFileId 的派生物');
  assert.equal(sameBytesA.prepared.sourcePath, sameBytesSourceA, '来源 A 不得继承来源 B 的路径');
  assert.equal(sameBytesB.prepared.sourcePath, sameBytesSourceB, '来源 B 不得继承来源 A 的路径');

  // 同源并发也不能共享首个调用的取消状态：前者取消后，后者必须独立复用或重做成功。
  const cancelSource = path.join(storageRoot, 'cancel-shared-source.png');
  fs.copyFileSync(concurrencySource, cancelSource);
  const cancelController = new AbortController();
  const cancelled = prepareVideoJobImage({
    providerType: 'openai-video', model: 'minimax-h3', role: 'reference',
    absolutePath: cancelSource, signal: cancelController.signal,
  });
  const waiting = prepareVideoJobImage({
    providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: cancelSource,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  cancelController.abort();
  await assert.rejects(cancelled, (error: unknown) => videoPreprocessErrorCode(error) === 'aborted');
  const waited = await waiting;
  assert.ok(waited?.prepared.derived, '前一个调用取消不得让后一个调用失败');
  assert.equal(waited.prepared.sourcePath, cancelSource);

  // 只留下上面两份派生物，没有半成品或临时文件。
  for (const file of derivativeFiles()) {
    assert.ok(!file.endsWith('.tmp'), `并发不得留下临时文件：${file}`);
  }

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

  // ── 关闭可选 COS 压缩不得绕过硬性模型限制 ──
  // CREATIVE_STUDIO_COS_COMPRESS=0 只管 COS 上传那一步；预算判断在预处理阶段，
  // 因此超限图仍然必须得到合规副本（或明确拒绝），不会因为关了 COS 压缩就放行。
  process.env.CREATIVE_STUDIO_COS_COMPRESS = '0';
  try {
    const withCompressOff = await prepareVideoJobImage({
      providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: largePath,
    });
    assert.ok(withCompressOff, '关闭 COS 压缩不得让预处理跳过预算');
    assert.equal(withCompressOff.prepared.derived, true, '超限图仍必须物化合规副本');
    assert.ok(withCompressOff.prepared.byteSize <= 10 * MIB, '关闭 COS 压缩时副本仍必须满足上游预算');
    const compressOffMeasured = await measure(fs.readFileSync(withCompressOff.prepared.absolutePath));
    assert.ok(['jpeg', 'png'].includes(String(compressOffMeasured.format)));
  } finally {
    delete process.env.CREATIVE_STUDIO_COS_COMPRESS;
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

  // ── 派生物有界回收（规格 §7「并发、取消与清理有界」）──────────────────
  const derivativeDir = path.join(storageRoot, 'video-derivatives');
  fs.rmSync(derivativeDir, { recursive: true, force: true });
  // 目录不存在时安全返回，不抛错。
  assert.deepEqual(cleanupVideoDerivatives(), { scanned: 0, deleted: 0, freedBytes: 0 });

  fs.mkdirSync(derivativeDir, { recursive: true });
  const nowMs = Date.UTC(2026, 10, 5, 12, 0, 0);
  const makeDerivative = (name: string, bytes: number, ageMs: number) => {
    const filePath = path.join(derivativeDir, name);
    fs.writeFileSync(filePath, Buffer.alloc(bytes, 7));
    const stamp = new Date(nowMs - ageMs);
    fs.utimesSync(filePath, stamp, stamp);
    return filePath;
  };
  const day = 24 * 60 * 60 * 1000;
  const stale = makeDerivative('stale.bin', 100, 30 * day);      // 超龄
  const fresh = makeDerivative('fresh.bin', 100, 1 * day);       // 未超龄
  // 只按龄回收：超龄的删掉，未超龄的留下。
  const aged = cleanupVideoDerivatives({ maxAgeMs: 7 * day, maxBytes: 1_000_000, now: () => nowMs });
  assert.equal(aged.deleted, 1);
  assert.equal(fs.existsSync(stale), false, '超龄派生物必须被回收');
  assert.equal(fs.existsSync(fresh), true, '未超龄派生物不得被删');

  // 总量超限：从最旧的开始删，删到回落到上限内就停（不是一次清空）。
  const older = makeDerivative('older.bin', 400, 6 * day);
  const newer = makeDerivative('newer.bin', 400, 5 * day);
  // 当前总量 100(fresh)+400(older)+400(newer)=900，上限 500 → 删掉最旧的 older 后恰好 500，停。
  const bySize = cleanupVideoDerivatives({ maxAgeMs: 365 * day, maxBytes: 500, now: () => nowMs });
  assert.equal(bySize.deleted, 1, '超总量时从最旧删起，回落到上限即停');
  assert.equal(fs.existsSync(older), false, '最旧的先删');
  assert.equal(fs.existsSync(newer), true, '已回落到上限内，较新的保留');
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(bySize.freedBytes, 400);

  // 正在进行中的编码不得被删（inFlight 保护）——用同名 .tmp 之外的正式文件模拟：
  // 这里只断言 .tmp 文件不会被当作派生物统计（取消时的半成品不属于交付物）。
  const halfWritten = path.join(derivativeDir, 'in-flight.tmp');
  fs.writeFileSync(halfWritten, Buffer.alloc(10, 1));
  const withTmp = cleanupVideoDerivatives({ maxAgeMs: 0, maxBytes: 0, now: () => nowMs + 365 * day });
  assert.equal(fs.existsSync(halfWritten), true, '.tmp 半成品不参与派生物回收');
  // 此时正式派生物还剩 fresh.bin 与 newer.bin 两个（older.bin 已回收），.tmp 不计入。
  assert.equal(withTmp.scanned, 2, '只统计正式派生物，不含 .tmp 半成品');
  assert.equal(withTmp.deleted, 2, 'maxAgeMs=0 时两个正式派生物都算超龄');

  // server 启动清理必须同时删除派生物登记，并避让正在走团队生命周期的文件。
  const db = new Database(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE team_files (
        id TEXT PRIMARY KEY, relativePath TEXT UNIQUE, state TEXT NOT NULL, derivedFromFileId TEXT
      );
      CREATE TABLE team_file_references (
        fileId TEXT NOT NULL, pinKind TEXT NOT NULL DEFAULT 'entity', releasedAt TEXT,
        FOREIGN KEY (fileId) REFERENCES team_files(id) ON DELETE CASCADE
      );
      CREATE TABLE team_cleanup_files (
        jobId TEXT NOT NULL, fileId TEXT NOT NULL,
        PRIMARY KEY (jobId, fileId),
        FOREIGN KEY (fileId) REFERENCES team_files(id)
      );
    `);
    const registeredPath = makeDerivative('registered.bin', 100, 30 * day);
    db.prepare("INSERT INTO team_files (id, relativePath, state, derivedFromFileId) VALUES ('derived', 'video-derivatives/registered.bin', 'ready', 'source')").run();
    db.prepare("INSERT INTO team_file_references (fileId) VALUES ('derived')").run();
    const lifecyclePath = makeDerivative('lifecycle.bin', 100, 30 * day);
    db.prepare("INSERT INTO team_files (id, relativePath, state, derivedFromFileId) VALUES ('lifecycle', 'video-derivatives/lifecycle.bin', 'ready', 'source')").run();
    db.prepare("INSERT INTO team_cleanup_files (jobId, fileId) VALUES ('cleanup-1', 'lifecycle')").run();
    const acceptedPath = makeDerivative('accepted.bin', 100, 30 * day);
    db.prepare("INSERT INTO team_files (id, relativePath, state, derivedFromFileId) VALUES ('accepted', 'video-derivatives/accepted.bin', 'ready', 'source')").run();
    db.prepare("INSERT INTO team_file_references (fileId, pinKind) VALUES ('accepted', 'accepted_task')").run();
    const registeredCleanup = cleanupVideoDerivatives({ db, maxAgeMs: 0, maxBytes: 0, now: () => nowMs + 400 * day });
    assert.equal(registeredCleanup.deleted, 1, '只有未进入生命周期的派生物被清理');
    assert.equal(fs.existsSync(registeredPath), false, '已清理派生物的磁盘副本必须删除');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM team_files WHERE id = 'derived'").pluck().get(), 0, '派生物登记必须同步删除');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM team_file_references WHERE fileId = 'derived'").pluck().get(), 0, '派生物引用应随登记级联删除');
    assert.equal(fs.existsSync(lifecyclePath), true, '生命周期清理中的文件不得被启动回收重复删除');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM team_files WHERE id = 'lifecycle'").pluck().get(), 1);
    assert.equal(fs.existsSync(acceptedPath), true, '已受理任务引用的派生物不得被启动回收删除');
  } finally {
    db.close();
  }

  // 正在进行中的编码/交付不得被删（inFlight 保护）。
  // 真的并发跑：先物化一份大图派生物，再对同一源图重复 prepare（命中复用校验路径，
  // 该路径会在 inFlight 里挂住 targetPath），同时不断以「全部超龄」的激进参数回收。
  // 保护生效时派生物始终在盘上且复用返回的仍是同一个可读文件；缺保护则会被删掉。
  fs.mkdirSync(derivativeDir, { recursive: true });
  const largeCleanupSource = path.join(storageRoot, 'cleanup-large.png');
  await writeLargePng(largeCleanupSource);
  const seeded = await prepareVideoJobImage({
    providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: largeCleanupSource,
  });
  assert.ok(seeded?.prepared.derived);
  const derivativePath = seeded.prepared.absolutePath;
  const derivativeBytes = seeded.prepared.byteSize;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inflight = prepareVideoJobImage({
      providerType: 'openai-video', model: 'minimax-h3', role: 'reference', absolutePath: largeCleanupSource,
    });
    // 回收循环与 prepare 并发；每次都用「全部超龄 + 零字节上限」的最激进策略。
    const aggressive = setInterval(() => {
      try {
        cleanupVideoDerivatives({ maxAgeMs: 0, maxBytes: 0, now: () => nowMs + 400 * day });
      } catch { /* 回收失败不影响这里的断言 */ }
    }, 1);
    let reused: Awaited<ReturnType<typeof prepareVideoJobImage>>;
    try {
      reused = await inflight;
    } finally {
      clearInterval(aggressive);
    }
    assert.equal(reused?.prepared.absolutePath, derivativePath, '复用必须仍指向同一份派生物');
    assert.equal(fs.existsSync(derivativePath), true, `第 ${attempt + 1} 次：inFlight 中的派生物不得被回收`);
    assert.equal(fs.statSync(derivativePath).size, derivativeBytes, 'inFlight 中的派生物字节不得被改动');
  }

  console.log('video reference preprocess tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
