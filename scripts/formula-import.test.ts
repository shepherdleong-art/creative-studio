import assert from 'node:assert/strict';
import { parseFormula, parseMaterialFilename } from '../lib/batch-production/formula/parse.ts';

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
console.log('formula-import: 编号和公式顺序通过');
