import assert from 'node:assert/strict';
import { buildVideoAnalysisPrompt, buildVideoFrameSamples } from '../lib/media-core/adapters/video-analysis-prompt.ts';

const prompt = buildVideoAnalysisPrompt([{ startUs: 0, endUs: 5_000_000 }], 5);
assert.ok(prompt.includes('json'), 'OpenAI-compatible json_object 请求的 user message 必须显式包含小写 json 关键字');
assert.match(prompt, /scenes/);
assert.match(prompt, /5000000/);

// P1 是 6.72 秒单镜头，前 2 秒为空沙发，后半段才有人落座。
const scenes = [{ startUs: 0, endUs: 6_720_000 }];
const frames = buildVideoFrameSamples(scenes);
assert(frames.some(frame => frame.timeUs < 2_000_000));
assert(frames.some(frame => frame.timeUs > 3_000_000 && frame.timeUs < 4_000_000));
assert(frames.some(frame => frame.timeUs > 6_000_000));
assert(frames.length <= 12);
const multiPrompt = buildVideoAnalysisPrompt(scenes, 6.72, frames);
assert(multiPrompt.includes(JSON.stringify(frames)), '提示词必须携带图片顺序和实际取帧时间');
assert(!multiPrompt.includes('每个场景在 30% 位置抽一帧'));
const manyScenes = Array.from({ length: 20 }, (_, i) => ({ startUs: i * 10_000_000, endUs: (i + 1) * 10_000_000 }));
const bounded = buildVideoFrameSamples(manyScenes);
assert(bounded.length <= 48, '多镜头总采样预算有界');
assert.equal(new Set(bounded.map(frame => frame.sceneIndex)).size, 20, '每个已检测场景都要有画面证据');
assert(bounded.every((frame, i) => !i || frame.timeUs > bounded[i - 1].timeUs));
const short = buildVideoFrameSamples([{ startUs: 0, endUs: 40_000 }]);
assert(short.length === 1 && short[0].timeUs >= 0 && short[0].timeUs < 40_000);

console.log('final-edit video analysis prompt tests passed');
