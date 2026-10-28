import assert from 'node:assert/strict';
import { selectFormulaScript } from '../lib/live-mixcut/formula/script-selection.ts';
import { rotationIndex } from '../lib/live-mixcut/scheduling/text.ts';

// 选片是纯函数：编造绑定，不连数据库、不调服务。
const binding = (logicalCode: string | null, assetId: string, fileName = `${logicalCode ?? 'X'}.mp4`, extra: Partial<{ available: boolean; excludedReason: string | null }> = {}) => ({
  logicalCode, assetId, contentFingerprint: `sha256:${assetId}`, fileName,
  available: extra.available ?? true, excludedReason: extra.excludedReason ?? null,
});

// 1. 缺号不停：没有文件也照常通过，缺的编号按公式顺序去重记下来。
const missing = selectFormulaScript({
  scriptNumber: '7', copyIndex: 1, codes: ['G1', 'P100', 'G2', 'S29', 'P100'],
  bindings: [binding('G1', 'a'), binding('G2', 'b')],
});
assert.equal(missing.status, 'selected', '缺号也不停下等人');
assert.deepEqual(missing.missingCodes, ['P100', 'S29']);
assert.deepEqual(missing.codes.map(code => [code.logicalCode, code.missing]), [['G1', false], ['P100', true], ['G2', false], ['S29', true]],
  '公式里重复的编号只列一次，顺序按第一次出现');
assert.equal(missing.codes.find(code => code.logicalCode === 'P100')!.file, null);

// 2. 同号轮换：用 (原脚本号 + 份次) mod 文件数，从 0 数；份次从 1 数传进来。
const three = ['a', 'b', 'c'].map(id => binding('G1', id));
for (const [scriptNumber, copyIndex] of [['18', 1], ['49', 1], ['889', 3], ['0', 1]] as const) {
  const selected = selectFormulaScript({ scriptNumber, copyIndex, codes: ['G1'], bindings: three });
  const expected = three[rotationIndex(scriptNumber, copyIndex - 1, 3)].assetId;
  assert.equal(selected.codes[0].file!.assetId, expected, `脚本 ${scriptNumber} 第 ${copyIndex} 份`);
}
assert.equal(selectFormulaScript({ scriptNumber: '18', copyIndex: 1, codes: ['G1'], bindings: three }).codes[0].file!.assetId, 'a');
assert.equal(selectFormulaScript({ scriptNumber: '49', copyIndex: 1, codes: ['G1'], bindings: three }).codes[0].file!.assetId, 'b');
assert.equal(selectFormulaScript({ scriptNumber: '49', copyIndex: 2, codes: ['G1'], bindings: three }).codes[0].file!.assetId, 'c');
assert.equal(selectFormulaScript({ scriptNumber: '49', copyIndex: 4, codes: ['G1'], bindings: three }).codes[0].file!.assetId, 'b',
  '轮转一圈回到同一份');

// 3. 不可用、被排除、没有编号的绑定都不参与选片；同一文件重复登记只算一次。
const filtered = selectFormulaScript({
  scriptNumber: '3', copyIndex: 1, codes: ['G1', 'VO1'],
  bindings: [
    binding('G1', 'a'),
    binding('G1', 'a', 'G1_dup.mp4'),
    binding('G1', 'b', 'G1_预览.mp4', { excludedReason: 'preview' }),
    binding('G1', 'c', 'G1_掉线.mp4', { available: false }),
    binding(null, 'd', '没有编号.mp4'),
    binding('VO1', 'e', 'VO1_口播_“来，看看这张沙发。”.mp4'),
  ],
});
assert.deepEqual(filtered.codes[0].files.map(file => file.assetId), ['a'], '只留可用、没被排除的文件，重复只算一次');
assert.equal(filtered.codes[0].missing, false);
assert.deepEqual(filtered.codes[1].files.map(file => file.assetId), ['e']);

// 4. 文件名里的标记跟着选中的文件走。
const marked = selectFormulaScript({
  scriptNumber: '5', copyIndex: 1, codes: ['S1', 'P3', 'S11'],
  bindings: [
    binding('S1', 'a', 'S1_产品卖点展示_整体外观_全平台_无人出镜.mp4'),
    binding('P3', 'b', 'P3_人物使用-体验_全景_小红书_单人出镜.mp4'),
    binding('S11', 'c', 'S11_产品卖点展示_整体外观_小红书_单人出镜_全景.mp4'),
  ],
});
const [wide, wideExperience, neither] = marked.codes;
assert.deepEqual([wide.logicalCode, wide.kind, wide.isVo, wide.wide, wide.wideExperience], ['S1', 'S', false, true, false]);
assert.deepEqual([wideExperience.logicalCode, wideExperience.kind, wideExperience.wideExperience], ['P3', 'P', true]);
assert.deepEqual([neither.logicalCode, neither.wide, neither.wideExperience], ['S11', false, false], '有人出镜不算全景展示，S 镜头不算全景体验');
assert.equal(wideExperience.voLine, null);

// 5. 口播编号与台词：VO 编号标成口播并读出引号里的台词。
const vo = selectFormulaScript({
  scriptNumber: '1', copyIndex: 1, codes: ['VO7'],
  bindings: [binding('VO7', 'a', 'VO7_口播_真人_“养猫三年，我终于敢买真皮沙发了。”.mp4')],
});
assert.equal(vo.codes[0].isVo, true);
assert.equal(vo.codes[0].kind, 'VO');
assert.equal(vo.codes[0].voLine, '养猫三年，我终于敢买真皮沙发了。');

// 6. 空公式：没有编号也没有缺号，仍然是通过状态。
const empty = selectFormulaScript({ scriptNumber: '9', copyIndex: 1, codes: [], bindings: [binding('G1', 'a')] });
assert.deepEqual([empty.status, empty.codes.length, empty.missingCodes.length], ['selected', 0, 0]);

console.log('formula-script-selection: 缺号不停、同号轮换、绑定过滤、文件名标记和口播台词通过');
