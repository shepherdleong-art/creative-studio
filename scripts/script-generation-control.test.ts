import assert from 'node:assert/strict';
import {
  cancelScriptGeneration,
  finishScriptGeneration,
  registerScriptGeneration,
} from '../lib/script-generation-control.ts';

const active = registerScriptGeneration('generation-a', 'project-a');
assert.equal(active.signal.aborted, false);
assert.equal(cancelScriptGeneration('generation-a', 'project-b'), false, '不能跨项目取消生成');
assert.equal(active.signal.aborted, false);
assert.equal(cancelScriptGeneration('generation-a', 'project-a'), true);
assert.equal(active.signal.aborted, true, '取消接口必须真正中断服务端控制器');

finishScriptGeneration('generation-a', active);
assert.equal(cancelScriptGeneration('generation-a', 'project-a'), false, '完成后的请求必须从活动表移除');

console.log('script generation control tests passed');
