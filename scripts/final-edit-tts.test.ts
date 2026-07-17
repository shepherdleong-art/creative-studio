import assert from 'node:assert/strict';
import { VAPI_VOICES, VAPI_PREVIEW_TEXT, speechUrl, validateVapiAudioUrl } from '../lib/final-edit/adapters/vapi-qwen-tts.ts';

assert.equal(VAPI_VOICES.length, 17);
assert.equal(VAPI_VOICES.find((voice) => voice.label.includes('南京'))?.id, 'li');
assert.equal(VAPI_PREVIEW_TEXT, '你好，我是产品素材工作台语音助手，这是当前音色和语速的试听效果。');
assert.equal(speechUrl('https://api.v3.cm'), 'https://api.v3.cm/v1/audio/speech');
assert.equal(speechUrl('https://api.v3.cm/v1/'), 'https://api.v3.cm/v1/audio/speech');
assert.equal(validateVapiAudioUrl('http://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/a.wav?x=1').protocol, 'https:');
assert.throws(() => validateVapiAudioUrl('https://127.0.0.1/private'));
assert.throws(() => validateVapiAudioUrl('file:///tmp/a.wav'));

console.log('final-edit V-API TTS tests passed');
