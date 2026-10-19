import assert from 'node:assert/strict';
import { buildVideoAnalysisPrompt } from '../lib/final-edit/adapters/video-analysis-prompt.ts';

const prompt = buildVideoAnalysisPrompt([{ startUs: 0, endUs: 5_000_000 }], 5);
assert.ok(prompt.includes('json'), 'OpenAI-compatible json_object 请求的 user message 必须显式包含小写 json 关键字');
assert.match(prompt, /scenes/);
assert.match(prompt, /5000000/);

console.log('final-edit video analysis prompt tests passed');
