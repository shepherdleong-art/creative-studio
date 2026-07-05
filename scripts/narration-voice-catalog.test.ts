import assert from 'node:assert/strict';
import {
  KNOWN_VOICE_CATALOG,
  resolveKnownVoiceCatalog,
  toggleVoiceSelection,
  resolveDefaultVoiceSelection,
} from '../lib/narration-providers/voice-catalog.ts';
import { defaultNarrationProviderConfigs } from '../lib/narration-providers/config.ts';

// KNOWN_VOICE_CATALOG['qwen-tts'] 必须和 defaultNarrationProviderConfigs 里 qwen-tts 的
// defaultVoices 完全一致，防止两处音色定义漂移。
const qwenTtsDefaults = defaultNarrationProviderConfigs.find((c) => c.id === 'qwen-tts');
assert.ok(qwenTtsDefaults, 'defaultNarrationProviderConfigs 应该包含 qwen-tts');
assert.equal(KNOWN_VOICE_CATALOG['qwen-tts'].length, 4);
assert.deepEqual(
  KNOWN_VOICE_CATALOG['qwen-tts'].map((v) => v.id),
  qwenTtsDefaults!.defaultVoices
);

// qwen3-tts-flash 目录：48 个，每条 id/label/description 非空，id 无重复
const flashCatalog = KNOWN_VOICE_CATALOG['qwen3-tts-flash'];
assert.equal(flashCatalog.length, 48);
for (const voice of flashCatalog) {
  assert.ok(voice.id.trim().length > 0, `voice.id 不能为空: ${JSON.stringify(voice)}`);
  assert.ok(voice.label.trim().length > 0, `voice.label 不能为空: ${JSON.stringify(voice)}`);
  assert.ok(voice.description.trim().length > 0, `voice.description 不能为空: ${JSON.stringify(voice)}`);
}
const flashIds = flashCatalog.map((v) => v.id);
assert.equal(new Set(flashIds).size, flashIds.length, 'qwen3-tts-flash 音色 id 不应有重复');

const qwenTtsIds = KNOWN_VOICE_CATALOG['qwen-tts'].map((v) => v.id);
assert.equal(new Set(qwenTtsIds).size, qwenTtsIds.length, 'qwen-tts 音色 id 不应有重复');

// resolveKnownVoiceCatalog：精确匹配、大小写不敏感、日期版本号归一化、未知返回 null
assert.equal(resolveKnownVoiceCatalog('qwen3-tts-flash'), flashCatalog);
assert.equal(resolveKnownVoiceCatalog('QWEN3-TTS-FLASH'), flashCatalog);
assert.equal(resolveKnownVoiceCatalog('  qwen3-tts-flash  '), flashCatalog);
assert.equal(resolveKnownVoiceCatalog('qwen3-tts-flash-2025-11-27'), flashCatalog);
assert.equal(resolveKnownVoiceCatalog('qwen3-tts-flash-2025-09-18'), flashCatalog);
assert.equal(resolveKnownVoiceCatalog('qwen-tts'), KNOWN_VOICE_CATALOG['qwen-tts']);
assert.equal(resolveKnownVoiceCatalog('tts-1'), null);
assert.equal(resolveKnownVoiceCatalog('qwen3-tts-instruct-flash'), null, '不应该误匹配 instruct-flash 系列');
assert.equal(resolveKnownVoiceCatalog(''), null);

// toggleVoiceSelection：勾选/取消、按目录顺序排列、保留目录外音色且不丢失其相对顺序
assert.equal(toggleVoiceSelection('', flashCatalog, 'Ethan'), 'Ethan');
assert.equal(toggleVoiceSelection('Ethan', flashCatalog, 'Cherry'), 'Cherry,Ethan');
assert.equal(toggleVoiceSelection('Cherry,Ethan', flashCatalog, 'Cherry'), 'Ethan');
assert.equal(
  toggleVoiceSelection('Cherry,CustomVoiceX', flashCatalog, 'Ethan'),
  'Cherry,Ethan,CustomVoiceX',
  '勾选已知音色时，不在目录里的 CustomVoiceX 必须原样保留在结尾'
);
assert.equal(
  toggleVoiceSelection('Cherry,CustomVoiceX', flashCatalog, 'Cherry'),
  'CustomVoiceX',
  '取消掉唯一的已知音色后，目录外音色仍然保留'
);
assert.equal(
  toggleVoiceSelection('Zeta,Serena,Alpha', flashCatalog, 'Cherry'),
  'Cherry,Serena,Zeta,Alpha',
  '目录外音色 Zeta、Alpha 必须保持它们在原字符串里的相对顺序（Zeta 在前）'
);

// resolveDefaultVoiceSelection：只在 create 模式且当前音色为空（含纯空白）时返回目录前 4 个；否则 null
assert.deepEqual(
  resolveDefaultVoiceSelection('create', flashCatalog, ''),
  ['Cherry', 'Serena', 'Ethan', 'Chelsie']
);
assert.deepEqual(
  resolveDefaultVoiceSelection('create', flashCatalog, '   '),
  ['Cherry', 'Serena', 'Ethan', 'Chelsie']
);
assert.deepEqual(
  resolveDefaultVoiceSelection('create', KNOWN_VOICE_CATALOG['qwen-tts'], ''),
  ['Cherry', 'Serena', 'Ethan', 'Chelsie']
);
assert.equal(resolveDefaultVoiceSelection('edit', flashCatalog, ''), null);
assert.equal(resolveDefaultVoiceSelection('create', flashCatalog, 'Ethan'), null);

console.log('narration-voice-catalog tests passed');
