import assert from 'node:assert/strict';
import {
  ScriptGenerationStreamError,
  readScriptGenerationStream,
} from '../lib/script-generation-stream.ts';

const encoder = new TextEncoder();
const response = new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode('{"type":"progress","progress":{"phase":"preparing","percent":18,"message":"正在处理分镜图片（1/2）"}}\n{"type":"pro'));
    controller.enqueue(encoder.encode('gress","progress":{"phase":"generating","percent":32,"message":"模型正在生成脚本","attempt":1}}\n'));
    controller.enqueue(encoder.encode('{"type":"result","status":200,"body":{"draftId":"draft-a","script":{"version":3}}}\n'));
    controller.close();
  },
}));

const progress: Array<{ phase: string; percent: number }> = [];
const result = await readScriptGenerationStream(response, (event) => progress.push(event));
assert.deepEqual(progress, [
  { phase: 'preparing', percent: 18, message: '正在处理分镜图片（1/2）' },
  { phase: 'generating', percent: 32, message: '模型正在生成脚本', attempt: 1 },
]);
assert.deepEqual(result, { status: 200, body: { draftId: 'draft-a', script: { version: 3 } } });

const errorResponse = new Response(`${JSON.stringify({
  type: 'error', status: 422, body: { error: 'script_contract_invalid', message: '脚本结构无效' },
})}\n`);
await assert.rejects(
  readScriptGenerationStream(errorResponse, () => undefined),
  (error: unknown) => {
    assert.ok(error instanceof ScriptGenerationStreamError);
    assert.equal(error.status, 422);
    assert.deepEqual(error.body, { error: 'script_contract_invalid', message: '脚本结构无效' });
    return true;
  },
);

console.log('script generation stream tests passed');
