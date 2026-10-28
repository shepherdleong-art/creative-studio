/**
 * 排片计算（任务 03）的自动测试。
 * 只用编造的脚本和素材，不放真实文案；不起数据库、不调模型。
 */
import assert from 'node:assert/strict';
import {
  arrangeFormulaTime, assignFormulaVoice, estimatedSpeechUs, framesToMicroseconds, microsecondsToFrames,
  rotationIndex, validateFormulaShortFilm,
  type NarrationTake, type SchedulingFile, type SchedulingInput, type SchedulingJudgment,
  type SchedulingSlotMaterial, type SchedulingSpeech, type SchedulingWord,
} from '../lib/live-mixcut/scheduling/index.ts';

const US = 1_000_000;

function file(assetId: string, options: { in?: number; out?: number; duration?: number; speech?: SchedulingSpeech | null } = {}): SchedulingFile {
  return {
    assetId, contentFingerprint: `fp-${assetId}`, fileName: `${assetId}.mp4`, logicalCode: assetId,
    durationUs: Math.round((options.duration ?? 6) * US),
    usableInUs: Math.round((options.in ?? 1) * US),
    usableOutUs: Math.round((options.out ?? 5) * US),
    speech: options.speech ?? null,
  };
}

function material(code: string, files: SchedulingFile[], options: {
  voLine?: string; wide?: boolean; wideExperience?: boolean;
} = {}): SchedulingSlotMaterial {
  return { logicalCode: code, kind: code.replace(/\d+$/, ''), files, isVo: /^VO/i.test(code),
    voLine: options.voLine ?? null, wide: options.wide ?? false, wideExperience: options.wideExperience ?? false };
}

function words(text: string, startUs: number, endUs: number): SchedulingWord[] {
  const pieces = [...text];
  const step = Math.max(1, Math.round((endUs - startUs) / Math.max(1, pieces.length)));
  return pieces.map((piece, index) => ({ text: piece, startUs: startUs + index * step,
    endUs: index === pieces.length - 1 ? endUs : startUs + (index + 1) * step }));
}

function speech(text: string, start: number, end: number, extra: { head?: number; tail?: number } = {}): SchedulingSpeech {
  return { text, startUs: Math.round(start * US), endUs: Math.round(end * US),
    words: words(text, Math.round(start * US), Math.round(end * US)),
    headCutEndUs: extra.head === undefined ? null : Math.round(extra.head * US),
    tailCutStartUs: extra.tail === undefined ? null : Math.round(extra.tail * US) };
}

function takes(plan: ReturnType<typeof assignFormulaVoice>, seconds: number | ((lineIndex: number) => number)): NarrationTake[] {
  return plan.lines.filter(line => !line.fate).map(line => ({
    lineIndex: line.index, text: line.text,
    durationUs: Math.round((typeof seconds === 'number' ? seconds : seconds(line.index)) * US),
    words: [],
  }));
}

function build(input: SchedulingInput, seconds: number | ((lineIndex: number) => number)) {
  const plan = assignFormulaVoice(input);
  const timeline = arrangeFormulaTime({ plan, materials: input.materials, narrations: takes(plan, seconds),
    judgment: input.judgment, scriptNumber: input.script.scriptNumber, copyIndex: input.script.copyIndex });
  const problems = validateFormulaShortFilm({ plan, timeline, materials: input.materials });
  assert.deepEqual(problems, [], '规矩 h 必须全部通过');
  return { plan, timeline };
}

function baseInput(overrides: Partial<SchedulingInput> & Pick<SchedulingInput, 'script' | 'materials'>): SchedulingInput {
  return { judgment: null, voiceMode: 'mixed', ...overrides };
}

// ① 普通的一行一个镜头。
{
  const materials = [material('S1', [file('S1')]), material('S2', [file('S2')]), material('S3', [file('S3')])];
  const input = baseInput({ script: { scriptNumber: '1', copyIndex: 1, lines: ['第一句文案。', '第二句文案。', '第三句文案。'], codes: ['S1', 'S2', 'S3'] }, materials });
  const { plan, timeline } = build(input, 2);
  assert.equal(plan.lines.length, 3);
  assert.ok(plan.lines.every(line => line.fate === null));
  assert.deepEqual(plan.items.map(item => item.kind), ['shot', 'shot', 'shot']);
  assert.deepEqual(timeline.clips.map(clip => clip.logicalCode), ['S1', 'S2', 'S3']);
  assert.equal(timeline.clips.filter(clip => clip.kind === 'filler').length, 0);
  // 3 句 × 2 秒 + 0.75 秒收尾。
  assert.equal(timeline.totalDurationUs, Math.round(6.75 * US), '成片时长以读完为准，最后多放 0.75 秒收尾');
}

// ② 文案里逐字写着口播台词：这一行不配音，由那段口播的原片来说。
{
  const vo = material('VO1', [file('VO1', { duration: 8, speech: speech('预算想买真皮沙发的，机会来了。', 2, 5) })],
    { voLine: '预算想买真皮沙发的，机会来了。' });
  const materials = [material('S1', [file('S1')]), vo, material('S2', [file('S2')])];
  const input = baseInput({
    script: { scriptNumber: '2', copyIndex: 1, lines: ['开场先说一句。', '预算想买真皮沙发的，机会来了。', '最后号召下单。'], codes: ['S1', 'VO1', 'S2'] },
    materials,
  });
  const { plan, timeline } = build(input, 2);
  assert.deepEqual(plan.lines[1].fate, { type: 'source', logicalCode: 'VO1', basis: 'planned' });
  assert.deepEqual(timeline.sounds.filter(sound => sound.kind === 'narration').map(sound => sound.lineIndexes[0]), [0, 2]);
  assert.equal(timeline.sounds.filter(sound => sound.kind === 'source').length, 1);
  const voClip = timeline.clips.find(clip => clip.kind === 'vo')!;
  assert.equal(voClip.sourceInUs, framesToMicroseconds(microsecondsToFrames(1.88 * US)), '说话起点前留 0.12 秒');
  assert.equal(voClip.sourceOutUs, framesToMicroseconds(microsecondsToFrames(5.12 * US)), '说话终点后留 0.12 秒');
  assert.ok(timeline.marks.some(mark => mark.type === 'skipped-line' && mark.basis === 'planned' && mark.lineIndex === 1));
}

// ③ AI 判断相近：两段内容不同的口播都放原片，两行都不配音。
{
  const first = material('VO1', [file('VO1', { duration: 8, speech: speech('这个面料摸着很舒服', 1, 4) })], { voLine: '这个面料摸着很舒服' });
  const second = material('VO2', [file('VO2', { duration: 8, speech: speech('靠背角度刚好托住腰', 1, 4) })], { voLine: '靠背角度刚好托住腰' });
  const materials = [material('S1', [file('S1')]), first, material('S2', [file('S2')]), second, material('S3', [file('S3')])];
  const judgment: SchedulingJudgment = { similar: [{ lineIndex: 1, logicalCode: 'VO1' }, { lineIndex: 3, logicalCode: 'VO2' }], bestVo: null, related: [] };
  const input = baseInput({
    script: { scriptNumber: '3', copyIndex: 1, lines: ['先说第一段。', '坐上去像被托住一样。', '再说第二段。', '腰一点都不累。', '最后收尾。'], codes: ['S1', 'VO1', 'S2', 'VO2', 'S3'] },
    materials, judgment,
  });
  const { plan, timeline } = build(input, 2);
  assert.equal(plan.lines[1].fate?.type, 'source');
  assert.equal(plan.lines[3].fate?.type, 'source');
  assert.equal(timeline.sounds.filter(sound => sound.kind === 'source').length, 2, '两段内容不同的口播都放原片');
  assert.equal(timeline.sounds.filter(sound => sound.kind === 'narration').length, 3);
  // 声音顺序仍按文案：第 0 行 → 原声（第 1 行）→ 第 2 行 → 原声（第 3 行）→ 第 4 行。
  const order = timeline.sounds.map(sound => sound.kind === 'source' ? sound.logicalCode : `L${sound.lineIndexes[0]}`);
  assert.deepEqual(order, ['L0', 'VO1', 'L2', 'VO2', 'L4']);
}

// ④ 一段都没对上：AI 挑一段放原片，文案照常全部配音。
{
  const vo = material('VO4', [file('VO4', { duration: 8, speech: speech('随便说了一句现场的话', 1, 4) })], { voLine: '随便说了一句现场的话' });
  const materials = [material('S1', [file('S1')]), vo, material('S2', [file('S2')])];
  const judgment: SchedulingJudgment = { similar: [], bestVo: 'VO4', related: [] };
  const input = baseInput({
    script: { scriptNumber: '4', copyIndex: 1, lines: ['第一句。', '第二句。'], codes: ['S1', 'VO4', 'S2'] }, materials, judgment,
  });
  const { plan, timeline } = build(input, 2);
  assert.ok(plan.lines.every(line => line.fate === null), '文案照常全部配音');
  assert.equal(timeline.sounds.filter(sound => sound.kind === 'source').length, 1, '公式里的口播只挑一段');
  assert.equal(timeline.sounds.filter(sound => sound.kind === 'narration').length, 2);
}

// ⑤ 会「结两次尾」的公式：最后一行挪到片尾。
{
  const vo = material('VO9', [file('VO9', { duration: 8, speech: speech('现场说的一段话', 1, 4) })], { voLine: '现场说的一段话' });
  const materials = [material('P1', [file('P1')]), material('P2', [file('P2')]), material('P3', [file('P3')]), vo, material('P5', [file('P5')])];
  const judgment: SchedulingJudgment = { similar: [], bestVo: 'VO9', related: [] };
  const input = baseInput({
    script: { scriptNumber: '5', copyIndex: 1, lines: ['第一句。', '第二句。', '同款已上架，趁活动赶紧冲。'], codes: ['P1', 'P2', 'P3', 'VO9', 'P5'] },
    materials, judgment,
  });
  const { plan, timeline } = build(input, 2);
  assert.equal(plan.movedLast, true);
  assert.equal(timeline.sounds.at(-1)!.kind, 'narration');
  assert.deepEqual(timeline.sounds.at(-1)!.lineIndexes, [2], '号召下单那句是最后一句声音');
  assert.ok(timeline.marks.some(mark => mark.type === 'last-line-moved'));
}

// ⑥ 某段口播前文案比镜头多：多出来的行接在这一段最后一个镜头上。
{
  const vo = material('VO2', [file('VO2', { duration: 8, speech: speech('第七行是它的台词', 1, 4) })], { voLine: '第七行是它的台词' });
  const materials = [material('P1', [file('P1')]), vo, material('P2', [file('P2')])];
  const input = baseInput({
    script: { scriptNumber: '6', copyIndex: 1, lines: ['第一句。', '第二句。', '第三句。', '第七行是它的台词'], codes: ['P1', 'VO2', 'P2'] },
    materials,
  });
  const { plan } = build(input, 2);
  const first = plan.items[0];
  assert.equal(first.kind, 'shot');
  if (first.kind === 'shot') assert.deepEqual(first.lineIndexes, [0, 1, 2], '口播前面的三行都接在唯一一个镜头上');
}

// ⑦ 镜头比文案多：多出来的镜头不用，记下原因。
{
  const materials = [material('S1', [file('S1')]), material('S2', [file('S2')]), material('S3', [file('S3')])];
  const input = baseInput({ script: { scriptNumber: '7', copyIndex: 1, lines: ['只有一句。'], codes: ['S1', 'S2', 'S3'] }, materials });
  const { plan, timeline } = build(input, 2);
  assert.deepEqual(timeline.clips.map(clip => clip.logicalCode), ['S1']);
  assert.ok(plan.unusedSlots.some(slot => slot.logicalCode === 'S2'));
  assert.ok(timeline.marks.some(mark => mark.type === 'unused-shot' && mark.logicalCode === 'S3'));
}

// ⑧ 缺号：缺非口播从同一类挑；缺口播先从全景展示挑；排到时文案已读完就不替代。
{
  const materials = [
    material('S1', [file('S1')]),
    material('S2', []),                                        // 缺，且有要读的行
    material('S9', [file('S9')]),                              // 同类的备用
    material('VO1', []),                                       // 缺口播，有要读的行
    material('W1', [file('W1')], { wide: true }),              // 全景展示
    material('S3', []),                                        // 缺，但排到时文案已读完
  ];
  const input = baseInput({
    script: { scriptNumber: '8', copyIndex: 1, lines: ['第一句。', '第二句。', '第三句。'], codes: ['S1', 'S2', 'VO1', 'S3'] },
    materials,
  });
  const { plan, timeline } = build(input, 2);
  const substituted = plan.items.filter(item => item.kind === 'shot' && item.substitution);
  assert.equal(substituted.length, 2, 'S2 和 VO1 都找到了替代');
  const s2 = plan.items.find(item => item.kind === 'shot' && item.logicalCode === 'S2');
  assert.equal(s2?.kind === 'shot' ? s2.substitution?.from : null, 'same-kind');
  const vo1 = plan.items.find(item => item.kind === 'shot' && item.logicalCode === 'VO1');
  assert.equal(vo1?.kind === 'shot' ? vo1.substitution?.from : null, 'wide');
  assert.ok(plan.missingCodes.includes('S2') && plan.missingCodes.includes('VO1') && plan.missingCodes.includes('S3'));
  assert.ok(timeline.marks.some(mark => mark.type === 'substitute' && mark.replacedCode === 'S2'));
  assert.ok(!plan.items.some(item => item.kind === 'shot' && item.logicalCode === 'S3'), '文案读完后的缺号不替代');
}

// ⑨ 有效片段太短：差半秒以内多用原片；超过半秒插补镜，补镜至少 1 秒。
{
  const materials = [material('P1', [file('P1', { in: 1, out: 3 })]), material('P9', [file('P9', { in: 0, out: 4 })])];
  // 配音 2.4 秒，比有效片段长 0.4 秒：多用原片。
  {
    const input = baseInput({ script: { scriptNumber: '9', copyIndex: 1, lines: ['这一行要读两秒四。'], codes: ['P1'] }, materials });
    const { timeline } = build(input, 2.4);
    // 这个镜头多用原片：58 帧配音 + 18 帧收尾，没有补镜。
    assert.equal(timeline.clips.length, 1);
    assert.equal(timeline.clips[0].timelineEndFrame - timeline.clips[0].timelineStartFrame, Math.round(2.4 * 24) + 18);
    assert.equal(timeline.clips.filter(clip => clip.kind === 'filler').length, 0);
  }
  // 配音 3.6 秒：P1 放满有效片段，后面插补镜。
  {
    const input = baseInput({ script: { scriptNumber: '9', copyIndex: 1, lines: ['这一行要读三秒六。'], codes: ['P1'] }, materials,
      judgment: { similar: [], bestVo: null, related: [{ lineIndex: 0, assetIds: ['P9'] }] } });
    const { timeline } = build(input, 3.6);
    const filler = timeline.clips.filter(clip => clip.kind === 'filler');
    assert.equal(filler.length, 1);
    assert.ok((filler[0].timelineEndFrame - filler[0].timelineStartFrame) >= 24, '补镜至少 1 秒');
  }
  // 只差 0.2 秒、原片后面也没余量：仍旧插 1 秒补镜，不会一闪而过。
  {
    const tight = [material('P1', [file('P1', { in: 1, out: 3, duration: 3 })]), material('P9', [file('P9', { in: 0, out: 4 })])];
    const input = baseInput({ script: { scriptNumber: '9', copyIndex: 1, lines: ['这一行读两秒二。'], codes: ['P1'] }, materials: tight,
      judgment: { similar: [], bestVo: null, related: [{ lineIndex: 0, assetIds: ['P9'] }] } });
    const { timeline } = build(input, 2.2);
    const filler = timeline.clips.filter(clip => clip.kind === 'filler');
    assert.equal(filler.length, 1);
    assert.ok((filler[0].timelineEndFrame - filler[0].timelineStartFrame) >= 24);
  }
}

// ⑩ 结尾镜头：先用公式里没用上的镜头（从靠后的开始），再全景展示，再全景体验。
{
  // 最后一行挪到片尾，公式里剩下没用上的镜头。
  const vo = material('VO1', [file('VO1', { duration: 8, speech: speech('现场的话', 1, 4) })], { voLine: '现场的话' });
  const materials = [material('P1', [file('P1')]), material('P2', [file('P2')]), vo, material('P3', [file('P3')]),
    material('W1', [file('W1')], { wide: true }), material('E1', [file('E1')], { wideExperience: true })];
  const judgment: SchedulingJudgment = { similar: [], bestVo: 'VO1', related: [] };
  const input = baseInput({
    script: { scriptNumber: '10', copyIndex: 1, lines: ['第一句。', '第二句。', '最后一句。'], codes: ['P1', 'P2', 'P3', 'VO1'] },
    materials, judgment,
  });
  const { timeline } = build(input, 2);
  const ending = timeline.clips.filter(clip => clip.kind === 'filler' && clip.fillerCause === 'ending');
  assert.ok(ending.length > 0);
  assert.equal(ending[0].logicalCode, 'P3', '公式里没用上的镜头从靠后的开始挑（P3 因最后一行挪走而空出来）');
}
{
  // 没有空出来的公式镜头时，用全景展示。
  const materials = [material('P1', [file('P1')]), material('P2', [file('P2')]), material('W1', [file('W1')], { wide: true }),
    material('E1', [file('E1')], { wideExperience: true })];
  const input = baseInput({ script: { scriptNumber: '11', copyIndex: 1, lines: ['第一句。', '第二句。', '最后一句。'], codes: ['P1', 'P2'] }, materials });
  const { timeline } = build(input, 2);
  const ending = timeline.clips.filter(clip => clip.kind === 'filler' && clip.fillerCause === 'ending');
  assert.equal(ending[0].logicalCode, 'W1', '公式镜头用完了就用全景展示');
}

// ⑪ 同号轮换：脚本 18 用第 1 份，脚本 49 用第 2 份（份次从 0 数）。
{
  assert.equal(rotationIndex('18', 0, 2), 0);
  assert.equal(rotationIndex('49', 0, 2), 1);
  const files = [file('S32a'), file('S32b')];
  for (const [scriptNumber, expected] of [['18', 'S32a'], ['49', 'S32b']] as const) {
    const input = baseInput({ script: { scriptNumber, copyIndex: 1, lines: ['一句。'], codes: ['S32'] }, materials: [material('S32', files)] });
    const { timeline } = build(input, 2);
    assert.equal(timeline.clips[0].assetId, expected);
  }
}

// ⑫ 统一配音：全部配音，口播只留一段、静音，只当画面。
{
  const vo1 = material('VO1', [file('VO1', { duration: 8, speech: speech('第一段口播', 1, 4) })], { voLine: '第一段口播' });
  const vo2 = material('VO2', [file('VO2', { duration: 8, speech: speech('第二段口播', 1, 4) })], { voLine: '第二段口播' });
  const materials = [material('S1', [file('S1')]), vo1, material('S2', [file('S2')]), vo2];
  const judgment: SchedulingJudgment = { similar: [], bestVo: 'VO2', related: [] };
  const input = baseInput({
    script: { scriptNumber: '12', copyIndex: 1, lines: ['第一句。', '第二句。', '第三句。', '第四句。'], codes: ['S1', 'VO1', 'S2', 'VO2'] },
    materials, judgment, voiceMode: 'narration',
  });
  const { plan, timeline } = build(input, 2);
  assert.ok(plan.lines.every(line => line.fate === null));
  assert.equal(timeline.sounds.filter(sound => sound.kind === 'source').length, 0, '统一配音时口播静音');
  assert.equal(timeline.sounds.filter(sound => sound.kind === 'narration').length, 4);
  assert.ok(plan.unusedSlots.some(slot => slot.logicalCode === 'VO1'));
  assert.ok(timeline.marks.some(mark => mark.type === 'muted-vo' && mark.logicalCode === 'VO2'));
  assert.ok(plan.items.some(item => item.kind === 'shot' && item.logicalCode === 'VO2'), '留下的口播当一个普通镜头用');
}

// ⑬ 恢复一行：AI 判断相近的行改回配音；那段口播不再顶任何行时按「一段都没用上」处理。
{
  const vo = material('VO1', [file('VO1', { duration: 8, speech: speech('意思相近的一段话', 1, 4) })], { voLine: '意思相近的一段话' });
  const materials = [material('S1', [file('S1')]), vo, material('S2', [file('S2')])];
  const judgment: SchedulingJudgment = { similar: [{ lineIndex: 1, logicalCode: 'VO1' }], bestVo: 'VO1', related: [] };
  const script = { scriptNumber: '13', copyIndex: 1, lines: ['第一句。', '第二句要恢复。', '第三句。'], codes: ['S1', 'VO1', 'S2'] };
  const before = build(baseInput({ script, materials, judgment }), 2);
  assert.equal(before.plan.lines[1].fate?.type, 'source');
  const after = build(baseInput({ script, materials, judgment, restoredLines: [1] }), 2);
  assert.equal(after.plan.lines[1].fate, null, '恢复后这一行重新配音');
  assert.equal(after.timeline.sounds.filter(sound => sound.kind === 'narration').length, 3);
  assert.equal(after.timeline.sounds.filter(sound => sound.kind === 'source').length, 1, '那段口播按「一段都没用上」被挑中');
}

// ⑭ 有替换表：按表替代，不按同类的相关排序。
{
  const materials = [material('S1', [file('S1')]), material('S9', [file('S9')])];
  const input = baseInput({
    script: { scriptNumber: '14', copyIndex: 1, lines: ['第一句。', '第二句。'], codes: ['S1', 'S2'] },
    materials, replacements: { S2: 'S9' },
  });
  const { plan } = build(input, 2);
  const second = plan.items[1];
  assert.equal(second.kind, 'shot');
  if (second.kind === 'shot') {
    assert.equal(second.substitution?.from, 'replacement-table');
    assert.equal(second.file.assetId, 'S9');
  }
}

// ⑮ 口播余量不能伸进被剪掉的倒数和口令。
{
  const vo = material('VO1', [file('VO1', { duration: 8, speech: speech('开始说正事', 1.0, 4.0, { head: 0.95, tail: 4.1 }) })], { voLine: '开始说正事' });
  const materials = [material('S1', [file('S1')]), vo];
  const input = baseInput({ script: { scriptNumber: '15', copyIndex: 1, lines: ['开始说正事'], codes: ['VO1'] }, materials });
  const { timeline } = build(input, 2);
  const clip = timeline.clips.find(item => item.kind === 'vo')!;
  assert.equal(clip.sourceInUs, framesToMicroseconds(microsecondsToFrames(0.95 * US)), '余量停在被剪掉的倒数结束处');
  assert.equal(clip.sourceOutUs, framesToMicroseconds(microsecondsToFrames(4.1 * US)), '余量停在被剪掉的口令开始处');
}

// ⑯ 随机生成一批脚本，逐条检查规矩 h。
{
  let seed = 20_261_028;
  const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const pick = <T,>(list: T[]): T => list[Math.floor(random() * list.length)];
  const lineWords = ['先看一眼。', '这个细节很扎实。', '坐上去很舒服。', '颜色也好看。', '同款已上架。', '快来看看。'];
  for (let round = 0; round < 120; round += 1) {
    const voSpeech = speech('演员现场说的这句话', 0.8, 0.8 + random() * 2.4);
    const materials: SchedulingSlotMaterial[] = [
      material('S1', [file('S1', { in: random() * 1, out: 2 + random() * 3 })]),
      material('S2', [file('S2', { in: random() * 1, out: 2 + random() * 3 })]),
      material('P1', [file('P1', { in: random() * 1, out: 2 + random() * 3 })]),
      material('VO1', [file('VO1', { duration: 9, speech: voSpeech })], { voLine: '演员现场说的这句话' }),
      material('VO2', [file('VO2', { duration: 9, speech: speech('另一段现场的话', 1, 3) })], { voLine: '另一段现场的话' }),
      material('VO3', []),
      material('W1', [file('W1', { in: 0, out: 3 })], { wide: true }),
      material('E1', [file('E1', { in: 0, out: 3 })], { wideExperience: true }),
    ];
    const codes = Array.from({ length: 3 + Math.floor(random() * 5) }, () => pick(['S1', 'S2', 'P1', 'VO1', 'VO2', 'VO3', 'W1', 'E1']));
    const lines = Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(lineWords));
    if (random() < 0.4) lines.push('演员现场说的这句话');
    const judgment: SchedulingJudgment = {
      similar: random() < 0.4 && lines.length > 2 ? [{ lineIndex: 1, logicalCode: 'VO2' }] : [],
      bestVo: pick(['VO1', 'VO2', null]),
      related: lines.map((_, lineIndex) => ({ lineIndex, assetIds: ['P1', 'S2', 'W1', 'E1'] })),
    };
    const input = baseInput({
      script: { scriptNumber: String(1 + Math.floor(random() * 300)), copyIndex: 1 + Math.floor(random() * 3), lines, codes },
      materials, judgment, voiceMode: random() < 0.3 ? 'narration' : 'mixed',
    });
    const plan = assignFormulaVoice(input);
    const timeline = arrangeFormulaTime({ plan, materials, narrations: takes(plan, () => 1 + random() * 3),
      judgment, scriptNumber: input.script.scriptNumber, copyIndex: input.script.copyIndex });
    const problems = validateFormulaShortFilm({ plan, timeline, materials });
    assert.deepEqual(problems, [], `第 ${round} 轮随机脚本：${problems.join('；')}`);
  }
}

// 估算时长只作参考：字数为 0 时也给一个最短时长。
assert.ok(estimatedSpeechUs('') >= 600_000);

console.log('live-mixcut scheduling tests passed');
