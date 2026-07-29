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

assert.equal(cancelScriptGeneration('generation-before-register', 'project-a'), true);
const preCancelled = registerScriptGeneration('generation-before-register', 'project-a');
assert.equal(preCancelled.signal.aborted, true, '先于任务注册到达的取消请求也必须生效');
finishScriptGeneration('generation-before-register', preCancelled);

console.log('script generation control tests passed');
