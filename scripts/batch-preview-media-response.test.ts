import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMediaEtag,
  projectAssetMediaResponse,
  type ProjectAssetMediaResponseOptions,
} from '../lib/batch-production/project-asset-media-response.ts';

// 共享流式媒体服务的扩展能力测试:ETag 条件请求(304 / If-Range)、onClose 生命周期、
// 背压(零消费/慢消费/取消)、以及不传 options 时与旧实现的逐字节兼容。

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-preview-media-'));
const mediaPath = path.join(root, 'media.mp4');
const mediaBytes = Buffer.alloc(64 * 1024, 7);
mediaBytes.write('ftypisom', 0, 'ascii');
fs.writeFileSync(mediaPath, mediaBytes);
const mediaSize = mediaBytes.length;

// 固定预读上界:不随文件大小或 Range 长度增长。基线无包装分支只预读约 128 KiB,
// 这里留出余量,同时远低于 64 MiB。
const FIXED_PRELOAD_BOUND = 512 * 1024;

function requestFor(headers: Record<string, string>): Request {
  return new Request('http://localhost/preview', { headers });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 等待源流 close；超时视为失败，确保生命周期断言不依赖固定 delay。 */
function waitForStreamClose(stream: fs.ReadStream, timeoutMs = 2000): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.off('close', onClose);
      reject(new Error('等待源流 close 超时'));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    stream.once('close', onClose);
  });
}

/** 在给定窗口内等待 close（用于“零消费时不得关闭”的反向断言），超时清理监听器。 */
function closeWithin(stream: fs.ReadStream, ms: number): Promise<boolean> {
  if (stream.closed) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      stream.off('close', onClose);
      resolve(false);
    }, ms);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    stream.once('close', onClose);
  });
}

function writeSyntheticFile(filePath: string, mib: number): void {
  const chunk = Buffer.alloc(1024 * 1024, 7);
  const fd = fs.openSync(filePath, 'w');
  try {
    for (let index = 0; index < mib; index += 1) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }
}

/** 响应函数同步创建源文件流;在调用期间捕获流引用,便于观察真实读取字节与销毁状态。 */
function responseCapturingSourceStreams(
  request: Request,
  filePath: string,
  options: ProjectAssetMediaResponseOptions,
): { response: Response; streams: fs.ReadStream[] } {
  const originalCreateReadStream = fs.createReadStream;
  const streams: fs.ReadStream[] = [];
  fs.createReadStream = function patchedCreateReadStream(...args: unknown[]) {
    const stream = (originalCreateReadStream as (...rest: unknown[]) => fs.ReadStream).apply(fs, args);
    streams.push(stream);
    return stream;
  } as typeof fs.createReadStream;
  try {
    return {
      response: projectAssetMediaResponse(request, filePath, 'video/mp4', {}, undefined, options),
      streams,
    };
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }
}

try {
  // --- buildMediaEtag:确定性与差异性 ---
  assert.equal(buildMediaEtag(['a', 'b']), buildMediaEtag(['a', 'b']), '同输入必须同输出');
  assert.notEqual(buildMediaEtag(['a', 'b']), buildMediaEtag(['a', 'c']), '任一输入变化必须改变 ETag');
  assert.match(buildMediaEtag(['a']), /^"[0-9a-f]{40}"$/, '必须是带双引号的强 ETag(sha1 hex)');
  assert.ok(!buildMediaEtag(['a']).startsWith('W/'), 'Range 不接受弱验证器,不许发 W/ 前缀');

  // --- 无 options:默认行为与改造前一致 ---
  const plain = projectAssetMediaResponse(requestFor({}), mediaPath, 'video/mp4');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('cache-control'), 'no-store, private');
  assert.equal(plain.headers.get('etag'), null, '未传 etag 时不得出现 ETag 头');
  assert.equal(plain.headers.get('content-length'), String(mediaSize));
  assert.deepEqual(Buffer.from(await plain.arrayBuffer()), mediaBytes, '全量响应字节不变');

  const plainRange = projectAssetMediaResponse(requestFor({ Range: 'bytes=0-7' }), mediaPath, 'video/mp4');
  assert.equal(plainRange.status, 206);
  assert.equal(plainRange.headers.get('content-range'), `bytes 0-7/${mediaSize}`);
  assert.equal(plainRange.headers.get('etag'), null);

  // --- etag + If-None-Match 命中 → 304 空 body ---
  const etag = buildMediaEtag(['proxy', 'fp', 'v1']);
  const notModified = projectAssetMediaResponse(
    requestFor({ 'If-None-Match': etag }),
    mediaPath,
    'video/mp4',
    {},
    undefined,
    { cacheControl: 'private, max-age=0, must-revalidate', etag },
  );
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.arrayBuffer().then((buffer) => buffer.byteLength), 0, '304 body 必须为空');
  assert.equal(notModified.headers.get('etag'), etag);
  assert.equal(notModified.headers.get('cache-control'), 'private, max-age=0, must-revalidate');
  assert.equal(notModified.headers.get('accept-ranges'), 'bytes');
  assert.equal(notModified.headers.get('content-length'), null, '304 不带 Content-Length');
  assert.equal(notModified.headers.get('content-range'), null, '304 不带 Content-Range');

  // If-None-Match: `*` 与逗号列表命中
  assert.equal(
    projectAssetMediaResponse(
      requestFor({ 'If-None-Match': '*' }),
      mediaPath, 'video/mp4', {}, undefined, { etag },
    ).status,
    304,
    'If-None-Match: * 必须命中',
  );
  assert.equal(
    projectAssetMediaResponse(
      requestFor({ 'If-None-Match': `"other", ${etag}` }),
      mediaPath, 'video/mp4', {}, undefined, { etag },
    ).status,
    304,
    '逗号列表中存在相等项必须命中',
  );
  assert.equal(
    projectAssetMediaResponse(
      requestFor({ 'If-None-Match': '"stale"' }),
      mediaPath, 'video/mp4', {}, undefined, { etag },
    ).status,
    200,
    '不相等的 If-None-Match 走正常响应',
  );

  // --- If-Range 不匹配 + Range → 200 全量流 ---
  const fullOnStaleIfRange = projectAssetMediaResponse(
    requestFor({ Range: 'bytes=0-7', 'If-Range': '"stale"' }),
    mediaPath,
    'video/mp4',
    {},
    undefined,
    { etag },
  );
  assert.equal(fullOnStaleIfRange.status, 200, 'If-Range 不匹配必须忽略 Range 回 200,而不是 416');
  assert.equal(fullOnStaleIfRange.headers.get('content-range'), null);
  assert.deepEqual(Buffer.from(await fullOnStaleIfRange.arrayBuffer()), mediaBytes, '200 分支必须给全量');

  // --- If-Range 匹配 + Range → 206 ---
  const partialOnFreshIfRange = projectAssetMediaResponse(
    requestFor({ Range: 'bytes=8-15', 'If-Range': etag }),
    mediaPath,
    'video/mp4',
    {},
    undefined,
    { etag },
  );
  assert.equal(partialOnFreshIfRange.status, 206);
  assert.equal(partialOnFreshIfRange.headers.get('content-range'), `bytes 8-15/${mediaSize}`);
  assert.equal((await partialOnFreshIfRange.arrayBuffer()).byteLength, 8);
  // 没有 If-Range 头时 Range 照常生效
  const plainRangeWithEtag = projectAssetMediaResponse(
    requestFor({ Range: 'bytes=0-7' }),
    mediaPath,
    'video/mp4',
    {},
    undefined,
    { etag },
  );
  assert.equal(plainRangeWithEtag.status, 206);
  assert.equal(plainRangeWithEtag.headers.get('etag'), etag, '206 也必须带 ETag 供后续条件请求');

  // 后缀 Range 与开放区间 Range 保持 206 字节语义
  const suffixRange = projectAssetMediaResponse(requestFor({ Range: 'bytes=-8' }), mediaPath, 'video/mp4');
  assert.equal(suffixRange.status, 206);
  assert.equal(suffixRange.headers.get('content-range'), `bytes ${mediaSize - 8}-${mediaSize - 1}/${mediaSize}`);
  assert.deepEqual(Buffer.from(await suffixRange.arrayBuffer()), mediaBytes.subarray(mediaSize - 8));
  const openEndedRange = projectAssetMediaResponse(requestFor({ Range: 'bytes=8-' }), mediaPath, 'video/mp4');
  assert.equal(openEndedRange.status, 206);
  assert.equal(openEndedRange.headers.get('content-range'), `bytes 8-${mediaSize - 1}/${mediaSize}`);
  assert.deepEqual(Buffer.from(await openEndedRange.arrayBuffer()), mediaBytes.subarray(8));

  // --- 非法 Range 仍 416 ---
  const invalidRange = projectAssetMediaResponse(
    requestFor({ Range: 'bytes=-0' }),
    mediaPath,
    'video/mp4',
    {},
    undefined,
    { etag },
  );
  assert.equal(invalidRange.status, 416, 'bytes=-0 必须拒绝');
  assert.equal(
    projectAssetMediaResponse(
      requestFor({ Range: `bytes=${mediaSize}-${mediaSize + 10}` }),
      mediaPath, 'video/mp4', {}, undefined, { etag },
    ).status,
    416,
    '起点越界必须 416',
  );

  // --- HEAD:复用 GET 的状态/头语义,但不创建源流、不保留 fd、不触发 onClose ---
  let headCloseCount = 0;
  const headOptions: ProjectAssetMediaResponseOptions = {
    cacheControl: 'private, max-age=0, must-revalidate',
    etag,
    onClose: () => { headCloseCount += 1; },
  };
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  let headOpened = 0;
  let headClosed = 0;
  fs.openSync = function patchedOpenSync(filePath: fs.PathLike, flags: string | number, mode?: number): number {
    headOpened += 1;
    return originalOpenSync(filePath, flags, mode);
  } as typeof fs.openSync;
  fs.closeSync = function patchedCloseSync(fd: number): void {
    headClosed += 1;
    originalCloseSync(fd);
  } as typeof fs.closeSync;
  try {
    const headRequest = (headers: Record<string, string> = {}) => new Request(
      'http://localhost/preview',
      { method: 'HEAD', headers },
    );

    const head200 = responseCapturingSourceStreams(headRequest(), mediaPath, headOptions);
    assert.equal(head200.response.status, 200);
    assert.equal(head200.response.headers.get('content-length'), String(mediaSize));
    assert.equal(head200.response.headers.get('content-type'), 'video/mp4');
    assert.equal(head200.response.headers.get('etag'), etag);
    assert.equal(head200.response.body, null, 'HEAD 200 不得返回响应体');
    assert.equal(head200.streams.length, 0, 'HEAD 不得创建源文件流');

    const head206 = responseCapturingSourceStreams(headRequest({ Range: 'bytes=8-15' }), mediaPath, headOptions);
    assert.equal(head206.response.status, 206);
    assert.equal(head206.response.headers.get('content-range'), `bytes 8-15/${mediaSize}`);
    assert.equal(head206.response.headers.get('content-length'), '8');
    assert.equal(head206.response.body, null, 'HEAD 206 不得返回响应体');
    assert.equal(head206.streams.length, 0, 'HEAD 206 不得创建源文件流');

    const head304 = responseCapturingSourceStreams(
      headRequest({ 'If-None-Match': etag }),
      mediaPath,
      headOptions,
    );
    assert.equal(head304.response.status, 304);
    assert.equal(head304.response.headers.get('etag'), etag);
    assert.equal(head304.response.headers.get('content-length'), null);
    assert.equal(head304.response.body, null, 'HEAD 304 不得返回响应体');
    assert.equal(head304.streams.length, 0);

    const head416 = responseCapturingSourceStreams(
      headRequest({ Range: 'bytes=-0' }),
      mediaPath,
      headOptions,
    );
    assert.equal(head416.response.status, 416);
    assert.equal(head416.response.headers.get('content-range'), `bytes */${mediaSize}`);
    assert.equal(head416.response.body, null, 'HEAD 416 不得返回响应体');
    assert.equal(head416.streams.length, 0);

    assert.equal(headOpened, headClosed, '每个 HEAD 都必须同步关闭 fd,不得泄漏');
    assert.equal(headOpened, 4, '四个 HEAD 请求各自只打开一个 fd');
  } finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(headCloseCount, 0, 'HEAD 不经过流,onClose 不得触发');

  // --- onClose:流读完后恰好调用一次 ---
  let closeCount = 0;
  const streamedCapture = responseCapturingSourceStreams(
    requestFor({ Range: 'bytes=0-15' }),
    mediaPath,
    { etag, onClose: () => { closeCount += 1; } },
  );
  assert.equal(streamedCapture.response.status, 206);
  assert.equal((await streamedCapture.response.arrayBuffer()).byteLength, 16);
  await waitForStreamClose(streamedCapture.streams[0]);
  assert.equal(closeCount, 1, 'onClose 在流结束后必须恰好调用一次');

  let fullCloseCount = 0;
  const fullCapture = responseCapturingSourceStreams(
    requestFor({}),
    mediaPath,
    { etag, onClose: () => { fullCloseCount += 1; } },
  );
  await fullCapture.response.arrayBuffer();
  await waitForStreamClose(fullCapture.streams[0]);
  assert.equal(fullCloseCount, 1, '全量流结束后 onClose 恰好一次');

  // 304/416 早退分支不经流,onClose 不触发,由调用方自行同步释放
  let earlyExitCloseCount = 0;
  projectAssetMediaResponse(
    requestFor({ 'If-None-Match': etag }),
    mediaPath, 'video/mp4', {}, undefined,
    { etag, onClose: () => { earlyExitCloseCount += 1; } },
  );
  projectAssetMediaResponse(
    requestFor({ Range: 'bytes=-0' }),
    mediaPath, 'video/mp4', {}, undefined,
    { etag, onClose: () => { earlyExitCloseCount += 1; } },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(earlyExitCloseCount, 0, '早退分支不经过流,onClose 不得触发');

  // --- 慢消费:读取随消费推进,读盘量始终不超过已消费量 + 固定上界 ---
  const slowPath = path.join(root, 'slow-64.mp4');
  writeSyntheticFile(slowPath, 64);
  let slowCloseCount = 0;
  const { response: slowResponse, streams: slowStreams } = responseCapturingSourceStreams(
    // Range 长度等于整个 64 MiB 文件,预读上界不得随 Range 长度线性增长
    requestFor({ Range: 'bytes=0-67108863' }),
    slowPath,
    { onClose: () => { slowCloseCount += 1; } },
  );
  assert.equal(slowResponse.status, 206);
  assert.equal(slowResponse.headers.get('content-range'), `bytes 0-67108863/${64 * 1024 * 1024}`);
  const slowSource = slowStreams[0];
  assert.ok(slowSource, '必须创建源文件流');
  const reader = slowResponse.body!.getReader();
  let consumed = 0;
  for (let index = 0; index < 8; index += 1) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    assert.ok(value && value.byteLength > 0, '缓读必须持续推进');
    consumed += value.byteLength;
    assert.ok(
      slowSource.bytesRead - consumed <= FIXED_PRELOAD_BOUND,
      `已消费 ${consumed} 字节时读盘 ${slowSource.bytesRead} 字节,超出固定预读上界`,
    );
    await delay(10);
  }
  assert.ok(consumed > 0, '慢消费必须真正收到数据');
  await reader.cancel('slow client stopped');
  await waitForStreamClose(slowSource);
  assert.equal(slowCloseCount, 1, '慢消费取消后 onClose 必须恰好一次');
  assert.equal(slowSource.destroyed, true, '慢消费取消后必须销毁源文件流');
  assert.equal(slowSource.closed, true, '慢消费取消后必须关闭源文件流');

  // --- 读取错误:onClose 恰好一次,错误传给消费者 ---
  let errorCloseCount = 0;
  const { response: brokenResponse, streams: brokenStreams } = responseCapturingSourceStreams(
    requestFor({}),
    mediaPath,
    { onClose: () => { errorCloseCount += 1; } },
  );
  const brokenSource = brokenStreams[0];
  assert.ok(brokenSource, '必须创建源文件流');
  brokenSource.destroy(new Error('synthetic read failure'));
  await assert.rejects(brokenResponse.arrayBuffer(), '读取错误必须传给响应消费者');
  await waitForStreamClose(brokenSource);
  assert.equal(errorCloseCount, 1, '读取错误时 onClose 必须恰好一次');
  assert.equal(brokenSource.destroyed, true);
  assert.equal(brokenSource.closed, true);

  // --- 背压回归:客户端零消费时只能有限预读,且预读不随文件大小线性增长 ---
  for (const mib of [64, 128]) {
    const bigPath = path.join(root, `backpressure-${mib}.mp4`);
    writeSyntheticFile(bigPath, mib);
    let idleCloseCount = 0;
    const { response: idleResponse, streams } = responseCapturingSourceStreams(
      requestFor({}),
      bigPath,
      { onClose: () => { idleCloseCount += 1; } },
    );
    assert.equal(idleResponse.status, 200);
    const source = streams[0];
    assert.ok(source, '必须创建源文件流');
    await closeWithin(source, 250);
    const bytesReadBeforeConsumption = source.bytesRead;
    assert.ok(
      bytesReadBeforeConsumption <= FIXED_PRELOAD_BOUND,
      `${mib} MiB 文件零消费时预读 ${bytesReadBeforeConsumption} 字节,超出固定上界 ${FIXED_PRELOAD_BOUND}`,
    );
    assert.equal(idleCloseCount, 0, '客户端未消费时不得触发 onClose');
    assert.equal(source.destroyed, false, '客户端未消费时源流不得自行结束');
    await idleResponse.body!.cancel('client aborted');
    await waitForStreamClose(source);
    assert.equal(idleCloseCount, 1, '取消后 onClose 必须恰好一次');
    assert.equal(source.destroyed, true, '取消必须销毁源文件流');
    assert.equal(source.closed, true, '取消必须关闭源文件流');
    assert.equal(source.bytesRead, bytesReadBeforeConsumption, '取消后不得继续读取源文件');
  }

  // --- 路由级源码契约(Node 无法加载 @/ 别名的 Next 路由,沿用 batch-manual-script-route 的分层验证):
  // 代理分支的读取租约必须活到流结束——200/206 只经 onClose 释放;finally 在 return 的响应
  // 开始流动之前就会执行,在里面无条件 release 等于没租约(2026-08-26 评审发现)。
  const previewRoute = fs.readFileSync('app/api/batch-production/preview/[assetId]/route.ts', 'utf8');
  assert.match(previewRoute, /onClose:\s*releaseOnce/, '代理分支必须把租约交给 onClose 活到流结束');
  assert.match(
    previewRoute,
    /streaming = \(response\.status === 200 \|\| response\.status === 206\) && response\.body !== null/,
    '只有带响应体的 200/206 才算流式响应,HEAD(响应体为 null)必须走 finally 释放',
  );
  assert.match(previewRoute, /finally\s*\{\s*if \(!streaming\) releaseOnce\(\);?\s*\}/, 'finally 不得无条件释放租约');
  assert.doesNotMatch(previewRoute, /response\.status !== 200 && response\.status !== 206/, 'finally 之外的重复释放是死代码,不得保留');

  console.log('batch preview media response tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
