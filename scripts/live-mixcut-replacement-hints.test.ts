import assert from 'node:assert/strict';
import { parseFormulaReplacementHints } from '../lib/live-mixcut/formula/replacement-hints.ts';

const parse = (filename: string, content: string) => parseFormulaReplacementHints(filename, Buffer.from(content));
const json = parse('substitutions.json', JSON.stringify({
  VO49: { kind: 'vo', sub: 'VO13', line: '买沙发先看这里。', group: '绿幕', line_index: 1 },
  G24: { kind: 'vis', sub: 'G15', orig_group: '开箱', orig_shot: '特写', sub_group: '开箱', sub_shot: '中景' },
}));
assert.deepEqual(json.hints.map(hint => [hint.originalCode, hint.replacementCode]), [['VO49', 'VO13'], ['G24', 'G15']]);
assert.ok(json.hints[0].note.includes('绿幕'));
assert.match(json.fingerprint, /^[a-f0-9]{64}$/);
const txt = parse('substitutions.txt', `==============================================================================
缺失素材替换方案
--- A. VO 缺失 ---
VO49 [组:绿幕 第1句] 买沙发先看这里。 -> 替身 VO13 (站沙发旁)
--- B. 视觉缺失 ---
G24 原: [开箱] 特写
   -> 替身 G15 [开箱] 中景
      备选 G1 [整体] 全景
--- C. 一镜多文件 ---
G15 2 个:
 G15_产品.mp4
 G15_产品2.mp4`);
assert.deepEqual(txt.hints.map(hint => [hint.originalCode, hint.replacementCode]), [['VO49', 'VO13'], ['G24', 'G15']]);
assert.equal(txt.hints[1].sourceLine, 6);
assert.ok(txt.hints[1].note.includes('备选 G1'), '备选说明保留，但不能变成强制替换规则');
assert.equal(parse('same.txt', 'Ｓ２９ -> 替身 Ｓ２５').hints[0].originalCode, 'S29');
for (const content of [
  '{"G1":{"sub":"G2"},"G1":{"sub":"G3"}}',
  '{"G1":{"sub":"G2","sub":"G3"}}',
  '{"g1":{"sub":"G2"},"Ｇ１":{"sub":"G3"}}',
  '{"G1":{"sub":"G1"}}',
  '{"G1":{"sub":"G2"},"G2":{"sub":"G3"}}',
  '{"G1":{"sub":"G2"},"G2":{"sub":"G1"}}',
  '{"G1":{"sub":"G100junk"}}',
]) assert.throws(() => parse('bad.json', content));
assert.throws(() => parse('bad.txt', 'G24 原: 特写\nS29 -> 替身 S25'), /G24|不完整/);
assert.throws(() => parse('bad.txt', 'G24 -> 替身 G15\nG24 -> 替身 G1'), /重复/);
assert.throws(() => parse('bad.txt', 'G24 -> 替身 G15junk'), /编号|格式/);
assert.throws(() => parse('bad.exe', 'G24 -> 替身 G15'), /JSON|TXT/);
assert.throws(() => parse('big.txt', 'x'.repeat(256 * 1024 + 1)), /256/);
assert.throws(() => parse('empty.json', '{}'), /没有/);
console.log('替换建议解析：JSON/TXT 主建议一致、原说明保留、编号/重复/多跳拒绝通过');
