import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canvasApi } from '../components/creative-canvas/api.ts';

const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const root = { dataset: { deploymentMode: 'server' } };
Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } });
try {
  for (const [name, type, mediaKind] of [['桌子.png', 'image/png', 'image'], ['开场.mov', '', 'video'], ['口播.wav', 'audio/wav', 'audio']]) {
    const file = new File(['0123456789'], name, { type, lastModified: 1234 });
    const parts: Uint8Array[] = [];
    let completed = false;
    let created: Record<string, unknown> = {};
    globalThis.fetch = async (url, init) => {
      if (url === '/api/team/uploads') {
        created = JSON.parse(String(init?.body));
        assert.equal(created.targetKind, 'canvas_asset');
        assert.deepEqual(created.targetScope, { resourceType: 'canvas', resourceId: 'canvas-test' });
        assert.equal(created.usage, 'canvas_asset');
        assert.equal(created.expectedSha256, createHash('sha256').update('0123456789').digest('hex'));
        return Response.json({ uploadId: 'upload-test', partSize: 4, missingParts: [1, 2, 3] });
      }
      if (String(url).includes('/parts/')) {
        assert.equal(init?.method, 'PUT');
        assert.equal(new Headers(init?.headers).get('content-type'), 'application/octet-stream');
        parts.push(new Uint8Array(await (init?.body as Blob).arrayBuffer()));
        return Response.json({});
      }
      if (String(url).endsWith('/complete')) {
        assert.equal(Buffer.concat(parts).toString(), '0123456789');
        completed = true;
        return Response.json({ state: 'ready', resultResourceType: 'canvas_asset', resultResourceId: 'asset-test' });
      }
      assert.equal(url, '/api/canvas/canvas-test/assets');
      assert.ok(completed, '服务器模式必须先走分片归库，不能发 multipart 到旧入口');
      assert.equal(init?.method ?? 'GET', 'GET');
      return Response.json({ assets: [{ id: 'asset-test', canvasId: 'canvas-test', mediaKind, ready: true }] });
    };
    assert.equal((await canvasApi.uploadAsset('canvas-test', file)).asset.mediaKind, mediaKind);
  }
  let completedAfterFailure = false;
  globalThis.fetch = async (url) => {
    if (url === '/api/team/uploads') return Response.json({ uploadId: 'failed', partSize: 4, missingParts: [1] });
    if (String(url).endsWith('/complete')) completedAfterFailure = true;
    return Response.json({ error: 'upload_unavailable', message: '上传暂时不可用' }, { status: 503 });
  };
  await assert.rejects(() => canvasApi.uploadAsset('canvas-test', new File(['data'], 'x.png')), /上传暂时不可用/);
  assert.equal(completedAfterFailure, false, '分片失败不能继续归库或附加素材');
  root.dataset.deploymentMode = 'local';
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/canvas/local/assets');
    assert.ok(init?.body instanceof FormData);
    return Response.json({ asset: { id: 'local' } });
  };
  assert.equal((await canvasApi.uploadAsset('local', new File(['x'], 'x.png'))).asset.id, 'local');
  console.log('creative canvas upload client tests passed');
} finally {
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
}
