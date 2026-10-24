import assert from 'node:assert/strict';
import { mapFormulaAudio, type FormulaAudioMappingInput } from '../lib/live-mixcut/formula/audio-mapping.ts';

const input: FormulaAudioMappingInput = {
  mode: 'mixed', bodyText: '好擦洗。坐得稳。',
  slots: [
    { slotId: 'spoken', assetId: 'a', contentFingerprint: 'sha256:a', speechStageId: 'speech-a',
      speech: { algorithmVersion: 'formula-source-speech/1', executionReady: false, status: 'transcribed',
        assetId: 'a', contentFingerprint: 'sha256:a', sourceId: 'source-a', mediaDurationUs: 2_000_000,
        reviewStatus: 'pending', text: '好擦洗。', words: [{ text: '好擦洗', startUs: 200_000, endUs: 1_200_000 }],
        audioStreamIndex: 0, transcriptionIdentity: { adapterVersion: 'openai-word-transcription/1', model: 'fixture', endpointHash: 'fixture' } } },
    { slotId: 'display', assetId: 'b', contentFingerprint: 'sha256:b', speechStageId: 'speech-b',
      speech: { algorithmVersion: 'formula-source-speech/1', executionReady: false, status: 'no_audio_stream',
        assetId: 'b', contentFingerprint: 'sha256:b', sourceId: 'source-b', mediaDurationUs: 3_000_000 } },
  ],
};
const model = { id: 'fixture', name: '测试模型', model: 'fixture', async complete() {
  return { blocks: [{ text: '好擦洗。', kind: 'source', slotId: 'spoken' },
    { text: '坐得稳。', kind: 'tts', slotIds: ['display'] }] };
} };
const result = await mapFormulaAudio(input, async () => model, new AbortController().signal);
assert.equal(result.status, 'mapped');
if (result.status !== 'mapped') throw new Error('声音映射未完成');
assert.equal(result.executionReady, false);
assert.deepEqual(result.narrations.map(item => item.text), ['坐得稳。'], '原声已说的句子不重复配音');
assert.deepEqual(result.sources.map(item => [item.slotId, item.speechInUs, item.speechOutUs]), [['spoken', 200_000, 1_200_000]]);
assert.equal(result.blocks.map(item => item.text).join(''), input.bodyText, '原文完整保留');

const humanChecked = structuredClone(input);
humanChecked.slots[1].speech = { algorithmVersion: 'formula-source-speech/1', executionReady: false, status: 'no_speech',
  assetId: 'b', contentFingerprint: 'sha256:b', sourceId: 'source-b', mediaDurationUs: 3_000_000,
  manualVerification: { revisionId: 'manual-b', verifiedAt: '2026-10-23T00:00:00Z', timing: 'manual_segments' } };
const manualWindow = await mapFormulaAudio(humanChecked, async () => model, new AbortController().signal);
assert.equal(manualWindow.status, 'mapped');
if (manualWindow.status !== 'mapped') throw new Error('人工核对窗口未进入声音编排');
assert.deepEqual(manualWindow.narrations.map(item => [item.text, item.slotIds]), [['坐得稳。', ['display']]],
  '人工确认无话语的真实音轨可作为配音窗口，不误当成需要保留的人声');

const proposal = (blocks: unknown) => async () => ({ ...model, async complete() { return { blocks }; } });
const longerSource = structuredClone(input);
if (longerSource.slots[0].speech?.status !== 'transcribed') throw new Error('fixture');
longerSource.slots[0].speech.text = '好擦洗。靠背也舒服。';
longerSource.slots[0].speech.words.push({ text: '靠背也舒服', startUs: 1_300_000, endUs: 1_900_000 });
const partiallyCovered = await mapFormulaAudio(longerSource, async () => model, new AbortController().signal);
assert.equal(partiallyCovered.status, 'mapped', '原声多说一句时，仍能认出其中完整覆盖的脚本句子');
if (partiallyCovered.status !== 'mapped') throw new Error('原声部分覆盖未完成');
assert.deepEqual(partiallyCovered.narrations.map(item => item.text), ['坐得稳。'], '只补配尚未说过的文案');
assert.equal(partiallyCovered.sources[0].text, '好擦洗。靠背也舒服。', '原声多说的句子不能静默删掉');
assert.equal(partiallyCovered.sources[0].speechOutUs, 1_900_000, '保留整段原声的真实结束时间');
assert(partiallyCovered.issues.some(item => item.code === 'additional_source_speech'
  && item.scriptText === '好擦洗。' && item.sourceText === '好擦洗。靠背也舒服。'), '把原文和完整实际台词留给审片对照');
assert.deepEqual(partiallyCovered.blocks[0].sourceCoverage, { kind: 'sentences', sourceText: '好擦洗。' });

const duplicateSentence = await mapFormulaAudio({ ...longerSource, bodyText: '好擦洗。靠背也舒服。坐得稳。' },
  proposal([{ text: '好擦洗。', kind: 'source', slotId: 'spoken' },
    { text: '靠背也舒服。坐得稳。', kind: 'tts', slotIds: ['display'] }]), new AbortController().signal);
assert.equal(duplicateSentence.status, 'needs_attention', '原声额外说过的一句，也不能在旁白里重复念');
if (duplicateSentence.status !== 'needs_attention') throw new Error('重复句未拦截');
assert(duplicateSentence.issues.some(item => item.code === 'duplicate_speech' && item.sourceText === '好擦洗。靠背也舒服。'));
const splitDuplicate = await mapFormulaAudio({ ...longerSource, bodyText: '好擦洗。靠背也舒服。坐得稳。' },
  proposal([{ text: '好擦洗。', kind: 'source', slotId: 'spoken' },
    { text: '靠背', kind: 'tts', slotIds: ['display'] },
    { text: '也舒服。坐得稳。', kind: 'tts', slotIds: ['display'] }]), new AbortController().signal);
assert.equal(splitDuplicate.status, 'needs_attention', '把重复句拆成两块也不能绕过同窗口的配音查重');

for (const [script, actual] of [['防水。', '不防水。'], ['减重 15%。', '减重 1.5%。'], ['温度 5 度。', '温度 -5 度。']]) {
  const changed = structuredClone(input);
  changed.bodyText = script + '坐得稳。';
  if (changed.slots[0].speech?.status !== 'transcribed') throw new Error('fixture');
  changed.slots[0].speech.text = actual;
  const mismatch = await mapFormulaAudio(changed, proposal([{ text: script, kind: 'source', slotId: 'spoken' },
    { text: '坐得稳。', kind: 'tts', slotIds: ['display'] }]), new AbortController().signal);
  assert.equal(mismatch.status, 'needs_attention', '词义和数字不同不能认定已覆盖');
}
await assert.rejects(() => mapFormulaAudio(input, proposal([{ text: '好擦洗。', kind: 'source', slotId: 'spoken' }]), new AbortController().signal), /遗漏|改写/);
await assert.rejects(() => mapFormulaAudio(input, proposal([{ text: input.bodyText, kind: 'tts', slotIds: ['spoken', 'display'] }]), new AbortController().signal), /非原声/);
const duplicate = await mapFormulaAudio(input, proposal([{ text: input.bodyText, kind: 'tts', slotIds: ['display'] }]), new AbortController().signal);
assert.equal(duplicate.status, 'needs_attention', '不能整篇配音再叠上原声');
const reference = await mapFormulaAudio({ ...input, mode: 'original' }, async () => null, new AbortController().signal);
assert(reference.status === 'mapped');
assert.equal(reference.narrations.length, 0);
assert.equal(reference.blocks[0].kind, 'reference');
const narration = await mapFormulaAudio({ ...input, mode: 'narration', slots: input.slots.map(slot => ({ ...slot, speech: null, speechStageId: null })) },
  async () => null, new AbortController().signal);
assert(narration.status === 'mapped');
assert.equal(narration.narrations[0].text, input.bodyText);
assert.equal(narration.sources.length, 0);
assert(narration.issues.some(item => item.code === 'speaking_picture_unchecked'));
const pending = await mapFormulaAudio({ ...input, slots: input.slots.map(slot => ({ ...slot, speech: null })) }, async () => null, new AbortController().signal);
assert.equal(pending.status, 'waiting_speech');
const repeatedScript = { ...input, bodyText: '好擦洗。好擦洗。' };
const reusedTwice = await mapFormulaAudio(repeatedScript, proposal([
  { text: '好擦洗。', kind: 'source', slotId: 'spoken' }, { text: '好擦洗。', kind: 'source', slotId: 'spoken' },
]), new AbortController().signal);
assert.equal(reusedTwice.status, 'needs_attention', '一段只播放一次的原声不能证明脚本重复两遍都已说过');

const manualInput = { ...structuredClone(input), bodyText: '容易清洁。坐得稳。拍摄备注。',
  manual: { confirmed: true, blocks: [
    { text: '容易清洁。', kind: 'source', slotId: 'spoken' },
    { text: '坐得稳。', kind: 'tts', slotIds: ['display'] },
    { text: '拍摄备注。', kind: 'reference' },
  ] } };
const manual = await mapFormulaAudio(manualInput, async () => { throw new Error('人工分配不应请求模型'); }, new AbortController().signal);
assert.equal(manual.status, 'mapped', '可显式选择使用实际原声、剩余配音及仅供参考的备注');
if (manual.status !== 'mapped') throw new Error('人工声音用途未完成');
assert.equal(manual.basis, 'manual');
assert.equal(manual.model, null);
assert.deepEqual(manual.narrations.map(item => item.text), ['坐得稳。']);
assert.equal(manual.sources[0].text, '好擦洗。', '不能用脚本文字改写实际台词');
assert(manual.issues.some(item => item.code === 'manual_source_difference' && item.scriptText === '容易清洁。' && item.sourceText === '好擦洗。'));
assert(manual.issues.some(item => item.code === 'manual_reference_text' && item.scriptText === '拍摄备注。'));
await assert.rejects(mapFormulaAudio({ ...manualInput, manual: { ...manualInput.manual, confirmed: false } }, async () => null,
  new AbortController().signal), /确认/);
const wrongOrder = await mapFormulaAudio({ ...manualInput, bodyText: '坐得稳。备注。容易清洁。', manual: { confirmed: true, blocks: [
  { text: '坐得稳。', kind: 'tts', slotIds: ['display'] }, { text: '备注。', kind: 'reference' },
  { text: '容易清洁。', kind: 'source', slotId: 'spoken' },
] } }, async () => null, new AbortController().signal);
assert.equal(wrongOrder.status, 'needs_attention', '参考备注不能重置原声与配音的先后顺序检查');

const semanticInput = { ...structuredClone(input), bodyText: '容易清洁。坐得稳。' };
const semanticPrompts: Array<Record<string, unknown>> = [];
const semanticModel = { ...model, async complete(request: { userPrompt: string }) {
  const prompt = JSON.parse(request.userPrompt); semanticPrompts.push(prompt);
  if (prompt.task === 'verify_source_coverage') return {
    checks: [{ blockId: 'text-1', verdict: 'covered', reason: '好擦洗表达容易清洁，没有增加产品事实。' }], duplicateNarration: false,
  };
  return { blocks: [{ text: '容易清洁。', kind: 'source', slotId: 'spoken', sourceText: '好擦洗。' },
    { text: '坐得稳。', kind: 'tts', slotIds: ['display'] }] };
} };
const semantic = await mapFormulaAudio(semanticInput, async () => semanticModel, new AbortController().signal);
assert.equal(semantic.status, 'mapped', '有真实台词依据且核对通过的同义文案应自动使用原声');
if (semantic.status !== 'mapped') throw new Error('同义原声未对应');
assert.deepEqual(semantic.narrations.map(item => item.text), ['坐得稳。'], '同义文案不再配一次');
assert.equal(semantic.sources[0].text, '好擦洗。', '字幕与声音依据仍使用实际台词');
assert.equal(semantic.blocks[0].sourceCoverage?.kind, 'semantic');
assert.equal(semantic.blocks[0].sourceCoverage?.sourceText, '好擦洗。');
assert(semantic.issues.some(item => item.code === 'semantic_source_coverage'
  && item.scriptText === '容易清洁。' && item.sourceText === '好擦洗。'), '同义判断须有常驻审片对照');
assert(semanticPrompts.some(prompt => prompt.task === 'verify_source_coverage'), '非逐字对应须单独核对完整上下文');

for (const [script, actual] of [['防水。', '不防水。'], ['减重 15%。', '减重 1.5%。'],
  ['温度 5 度。', '温度 -5 度。'], ['承重 100 公斤。', '承重 100 斤。']]) {
  const changed = structuredClone(input); changed.bodyText = script + '坐得稳。';
  if (changed.slots[0].speech?.status !== 'transcribed') throw new Error('fixture');
  changed.slots[0].speech.text = actual;
  const incorrectModel = { ...model, async complete(request: { userPrompt: string }) {
    if (JSON.parse(request.userPrompt).task === 'verify_source_coverage') return {
      checks: [{ blockId: 'text-1', verdict: 'covered', reason: '模型错误地认为一样。' }], duplicateNarration: false,
    };
    return { blocks: [{ text: script, kind: 'source', slotId: 'spoken', sourceText: actual },
      { text: '坐得稳。', kind: 'tts', slotIds: ['display'] }] };
  } };
  const protectedResult = await mapFormulaAudio(changed, async () => incorrectModel, new AbortController().signal);
  assert.equal(protectedResult.status, 'needs_attention', `不能让模型认可覆盖掉明确的否定或数量冲突：${script} / ${actual}`);
}

const phraseInput = structuredClone(input);
if (phraseInput.slots[0].speech?.status !== 'transcribed') throw new Error('fixture');
phraseInput.slots[0].speech.text = '坐垫好擦洗，靠背也舒服。';
phraseInput.slots[0].speech.words[0].text = '坐垫好擦洗，靠背也舒服';
let phraseContext: unknown;
const phrase = await mapFormulaAudio(phraseInput, async () => ({ ...model, async complete(request) {
  const prompt = JSON.parse(request.userPrompt);
  if (prompt.task === 'verify_source_coverage') {
    phraseContext = prompt.candidates[0].fullSourceText;
    return { checks: [{ blockId: 'text-1', verdict: 'covered', reason: '完整句子中明确说坐垫好擦洗。' }], duplicateNarration: false };
  }
  return { blocks: [{ text: '好擦洗。', kind: 'source', slotId: 'spoken', sourceText: '坐垫好擦洗，靠背也舒服。' },
    { text: '坐得稳。', kind: 'tts', slotIds: ['display'] }] };
} }), new AbortController().signal);
assert.equal(phrase.status, 'mapped', '句内一部分含义也可在完整上下文核对后使用原声');
assert.equal(phraseContext, '坐垫好擦洗，靠背也舒服。');
if (phrase.status !== 'mapped') throw new Error('句内含义未对应');
assert.equal(phrase.sources[0].text, '坐垫好擦洗，靠背也舒服。');
assert.equal(phrase.sources[0].speechOutUs, 1_200_000, '语义引用不裁切声音、不猜测词组的音频边界');

for (const response of [
  { checks: [{ blockId: 'text-1', verdict: 'uncertain', reason: '无法确定。' }], duplicateNarration: false },
  { checks: [{ blockId: 'text-1', verdict: 'different', reason: '产品事实不同。' }], duplicateNarration: false },
  { checks: [], duplicateNarration: false },
  { checks: [{ blockId: 'other', verdict: 'covered', reason: '无效引用。' }], duplicateNarration: false },
  { checks: [{ blockId: 'text-1', verdict: 'covered', reason: '同义。' }], duplicateNarration: true },
]) {
  const refused = await mapFormulaAudio(semanticInput, async () => ({ ...semanticModel, async complete(request) {
    return JSON.parse(request.userPrompt).task === 'verify_source_coverage' ? response : semanticModel.complete(request);
  } }), new AbortController().signal);
  assert.equal(refused.status, 'needs_attention', '不完整、冲突或重复旁白不能以核对成功继续制作');
}
const inventedQuote = await mapFormulaAudio(semanticInput, proposal([
  { text: '容易清洁。', kind: 'source', slotId: 'spoken', sourceText: '轻松擦净。' },
  { text: '坐得稳。', kind: 'tts', slotIds: ['display'] },
]), new AbortController().signal);
assert.equal(inventedQuote.status, 'needs_attention', '不能拿不存在的台词当同义依据');

await assert.rejects(mapFormulaAudio(semanticInput, async () => ({ ...semanticModel, async complete(request) {
  if (JSON.parse(request.userPrompt).task === 'verify_source_coverage') throw new Error('service unavailable');
  return semanticModel.complete(request);
} }), new AbortController().signal), /含义核对失败/, '核对服务失败不能假装对应成功');
const cancelled = new AbortController();
await assert.rejects(mapFormulaAudio(semanticInput, async () => ({ ...semanticModel, async complete(request) {
  if (JSON.parse(request.userPrompt).task === 'verify_source_coverage') cancelled.abort();
  return semanticModel.complete(request);
} }), cancelled.signal), /abort/i, '核对返回时已取消的任务不能提交结果');
const roleText = '好擦洗。坐得稳。【花字：加宽坐面】【备注：镜头慢推】';
const roleModel = { ...model, async complete(request: { userPrompt: string }) {
  const prompt = JSON.parse(request.userPrompt);
  if (prompt.task === 'verify_text_roles') return { checks: [], duplicateNarration: false, roleChecks: [
    { blockId: 'text-3', kind: 'on_screen', verdict: 'confirmed', reason: '原文明确标为花字。' },
    { blockId: 'text-4', kind: 'reference', verdict: 'confirmed', reason: '原文是拍摄备注。' },
  ] };
  return { blocks: [{ text: '好擦洗。', kind: 'source', slotId: 'spoken' },
    { text: '坐得稳。', kind: 'tts', slotIds: ['display'] },
    { text: '【花字：加宽坐面】', kind: 'on_screen', slotId: 'display', displayText: '加宽坐面' },
    { text: '【备注：镜头慢推】', kind: 'reference' }] };
} };
const roles = await mapFormulaAudio({ ...input, bodyText: roleText }, async () => roleModel, new AbortController().signal);
assert.equal(roles.status, 'mapped', '花字和拍摄备注可以自动分配，不应混入配音');
if (roles.status !== 'mapped') throw new Error('文字用途未分配');
assert.deepEqual(roles.narrations.map(item => item.text), ['坐得稳。']);
assert.equal(roles.blocks.map(block => block.text).join(''), roleText, '保留标签及备注原文以供核对');
assert.deepEqual(roles.blocks.map(block => block.kind), ['source', 'tts', 'on_screen', 'reference']);
assert.equal(roles.blocks[2].displayText, '加宽坐面');
for (const response of [
  { checks: [], duplicateNarration: false, roleChecks: [] },
  { checks: [], duplicateNarration: false, roleChecks: [
    { blockId: 'text-3', kind: 'on_screen', verdict: 'uncertain', reason: '无法确定是否为花字。' },
    { blockId: 'text-4', kind: 'reference', verdict: 'confirmed', reason: '拍摄备注。' },
  ] },
  { checks: [], duplicateNarration: false, roleChecks: [
    { blockId: 'unknown', kind: 'on_screen', verdict: 'confirmed', reason: '未知引用。' },
    { blockId: 'text-4', kind: 'reference', verdict: 'confirmed', reason: '拍摄备注。' },
  ] },
]) {
  const rejected = await mapFormulaAudio({ ...input, bodyText: roleText }, async () => ({ ...roleModel, async complete(request) {
    return JSON.parse(request.userPrompt).task === 'verify_text_roles' ? response : roleModel.complete(request);
  } }), new AbortController().signal);
  assert.equal(rejected.status, 'needs_attention', '用途未完整核对时不能跳过原文的朗读');
}
const disabledPackaging = await mapFormulaAudio({ ...input, bodyText: roleText, packagingEnabled: false }, async () => roleModel, new AbortController().signal);
assert.equal(disabledPackaging.status, 'needs_attention', '花字不能在包装关闭时悄悄丢失');
for (const [text, displayText] of [['不防水', '防水'], ['承重 100 公斤', '100'], ['温度 -5 度', '5 度'], ['减重 1.5%', '5%']]) {
  const original = `【花字：${text}】`;
  const changed = await mapFormulaAudio({ ...input, bodyText: original }, async () => ({ ...model, async complete(request) {
    if (JSON.parse(request.userPrompt).task === 'verify_text_roles') return { checks: [], duplicateNarration: false,
      roleChecks: [{ blockId: 'text-1', kind: 'on_screen', verdict: 'confirmed', reason: '模型误判为相同。' }] };
    return { blocks: [{ text: original, kind: 'on_screen', slotId: 'display', displayText }] };
  } }), new AbortController().signal);
  assert.equal(changed.status, 'needs_attention', `自动花字不能截掉否定、数量或单位：${text}`);
}
for (const mode of ['mixed', 'narration'] as const) {
  const noSourceInput = { mode, bodyText: '坐得稳。【花字：加宽坐面】【备注：镜头慢推】', slots: [input.slots[1]] };
  const noSource = await mapFormulaAudio(noSourceInput, async () => ({ ...model, async complete(request) {
    if (JSON.parse(request.userPrompt).task === 'verify_text_roles') return { checks: [], duplicateNarration: false, roleChecks: [
      { blockId: 'text-2', kind: 'on_screen', verdict: 'confirmed', reason: '原文花字。' },
      { blockId: 'text-3', kind: 'reference', verdict: 'confirmed', reason: '拍摄备注。' },
    ] };
    return { blocks: [{ text: '坐得稳。', kind: 'tts', slotIds: ['display'] },
      { text: '【花字：加宽坐面】', kind: 'on_screen', slotId: 'display', displayText: '加宽坐面' },
      { text: '【备注：镜头慢推】', kind: 'reference' }] };
  } }), new AbortController().signal);
  assert(noSource.status === 'mapped');
  assert.deepEqual(noSource.narrations.map(item => item.text), ['坐得稳。'], '全是无原声画面时也不能把花字和备注念出来');
  const unavailable = await mapFormulaAudio(noSourceInput, async () => null, new AbortController().signal);
  assert.equal(unavailable.status, 'needs_attention', '带明确用途标记但缺模型时不能悄悄整篇配音');
}
console.log('formula audio mapping tests passed');
