import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMediaEtag,
  projectAssetMediaResponse,
} from '../lib/batch-production/project-asset-media-response.ts';

// 共享流式媒体服务的扩展能力测试:ETag 条件请求(304 / If-Range)、onClose 生命周期、
// 以及不传 options 时与旧实现的逐字节兼容。

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-preview-media-'));
const mediaPath = path.join(root, 'media.mp4');
const mediaBytes = Buffer.alloc(64 * 1024, 7);
mediaBytes.write('ftypisom', 0, 'ascii');
fs.writeFileSync(mediaPath, mediaBytes);
const mediaSize = mediaBytes.length;

function requestFor(headers: Record<string, string>): Request {
  return new Request('http://localhost/preview', { headers });
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

  // --- onClose:流读完后恰好调用一次 ---
  let closeCount = 0;
  const streamed = projectAssetMediaResponse(
    requestFor({ Range: 'bytes=0-15' }),
    mediaPath,
    'video/mp4',
    {},
    undefined,
    { etag, onClose: () => { closeCount += 1; } },
  );
  assert.equal(streamed.status, 206);
  assert.equal((await streamed.arrayBuffer()).byteLength, 16);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCount, 1, 'onClose 在流结束后必须恰好调用一次');

  let fullCloseCount = 0;
  const fullStreamed = projectAssetMediaResponse(
    requestFor({}),
    mediaPath,
    'video/mp4',
    {},
    undefined,
    { etag, onClose: () => { fullCloseCount += 1; } },
  );
  await fullStreamed.arrayBuffer();
  await new Promise((resolve) => setImmediate(resolve));
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

  // --- 路由级源码契约(Node 无法加载 @/ 别名的 Next 路由,沿用 batch-manual-script-route 的分层验证):
  // 代理分支的读取租约必须活到流结束——200/206 只经 onClose 释放;finally 在 return 的响应
  // 开始流动之前就会执行,在里面无条件 release 等于没租约(2026-08-26 评审发现)。
  const previewRoute = fs.readFileSync('app/api/batch-production/preview/[assetId]/route.ts', 'utf8');
  assert.match(previewRoute, /onClose:\s*releaseOnce/, '代理分支必须把租约交给 onClose 活到流结束');
  assert.match(previewRoute, /streaming = response\.status === 200 \|\| response\.status === 206/, '只有 200/206 才算流式响应');
  assert.match(previewRoute, /finally\s*\{\s*if \(!streaming\) releaseOnce\(\);?\s*\}/, 'finally 不得无条件释放租约');
  assert.doesNotMatch(previewRoute, /response\.status !== 200 && response\.status !== 206/, 'finally 之外的重复释放是死代码,不得保留');

  console.log('batch preview media response tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
