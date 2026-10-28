import assert from 'node:assert/strict';
import { parseFormula, parseMaterialFilename } from '../lib/live-mixcut/formula/parse.ts';

// A01/A02: 真实脚本 1 的顺序必须完整保留，不能使用语义分配重排。
assert.deepEqual(parseFormula('【S14】【P1】【VO1】【P2】【VO2】【VO3】【VO4】', 7),
  ['S14', 'P1', 'VO1', 'P2', 'VO2', 'VO3', 'VO4']);
assert.equal(parseMaterialFilename('GB9_产品展示.mp4').logicalCode, 'GB9');
// 显式分隔符、全角及重复编号均保留；不从部分合法片段拼出新公式。
assert.deepEqual(parseFormula(' ｇ１ → Ｇ１０ + VO13，G1 ', 4), ['G1', 'G10', 'VO13', 'G1']);
assert.deepEqual(parseFormula('G1 P100\nVO1'), ['G1', 'P100', 'VO1']);
assert.deepEqual(parseFormula('【 G1 】 → 【P1】'), ['G1', 'P1']);
for (const invalid of ['', 'G1或者G10', 'G1/G10', 'G1→', 'G1,,G2', '【G1】【】', '【【G1】】', '=G1+G2', 'G1; rm -rf', 'G1P1']) {
  assert.throws(() => parseFormula(invalid), invalid);
}
assert.throws(() => parseFormula('G1 G2', 3), /不一致/);
assert.throws(() => parseFormula('G1', 0), /镜头数/);
assert.equal(parseMaterialFilename('G10_大景.mp4').logicalCode, 'G10');
assert.equal(parseMaterialFilename('P100abc.mp4').logicalCode, null);
assert.equal(parseMaterialFilename('定格布置.mp4').logicalCode, null);
assert.equal(parseMaterialFilename('GB9_demo.preview.mp4').excludedReason, 'preview');
// 口播台词：只取 “ ” 中间的字；台词本身是英文时保留原大小写。
assert.equal(parseMaterialFilename('VO7_口播_单人出镜_“客厅不大，还想放真皮沙发？”.mp4').voLine, '客厅不大，还想放真皮沙发？');
assert.equal(parseMaterialFilename('VO8_口播_(无钩子，正式开场)“这款是我们家的 PS866 钢琴键沙发。”.mp4').voLine, '这款是我们家的 PS866 钢琴键沙发。');
assert.equal(parseMaterialFilename('VO9_口播_"Sit down, please.".mp4').voLine, 'Sit down, please.');
assert.equal(parseMaterialFilename('VO9_口播_没有台词.mp4').voLine, null);
assert.equal(parseMaterialFilename('P1_展示.mp4').voLine, null);
// 全景展示：文件名同时含「整体外观」和「无人出镜」，两条都满足才算。
const wideNames = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'P3'];
const wideFlags = wideNames.filter(code => parseMaterialFilename(code === 'S11'
  ? `${code}_整体外观_全平台_单人出镜.mp4` : `${code}_整体外观_全平台_无人出镜.mp4`).wide);
assert.deepEqual(wideFlags, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S12', 'P3']);
assert.equal(parseMaterialFilename('P3_全景_产品展示.mp4').wide, false);
// 全景体验：P 镜头，并且文件名含「全景」；S 镜头带全景不算。
const experienceNames = ['P1', 'P3', 'P19', 'P26', 'P51', 'P54', 'P56', 'P58', 'P61', 'P66', 'P74', 'P76', 'S3'];
const experienceFlags = experienceNames.filter(code => parseMaterialFilename(code === 'P1'
  ? `${code}_外观_单人出镜.mp4` : `${code}_全景_产品展示_单人出镜.mp4`).wideExperience);
assert.deepEqual(experienceFlags, ['P3', 'P19', 'P26', 'P51', 'P54', 'P56', 'P58', 'P61', 'P66', 'P74', 'P76']);
assert.equal(parseMaterialFilename('S3_全景_产品展示.mp4').wideExperience, false);
console.log('formula-import: 编号、公式顺序、口播台词与两种全景标记通过');
