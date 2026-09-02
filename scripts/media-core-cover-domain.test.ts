import assert from 'node:assert/strict';
import { defaultTextStyle, resolveDefaultCjkFontFamily, setDefaultCjkFontFamily } from '../lib/media-core/cover-domain.ts';

// lib/media-core/cover-domain.ts 默认字体兜底的冒烟测试（技术计划 §1 问题一 F3）。
// defaultTextStyle 的默认 fontFamily 必须是真实可用的系统字体，而不是写死一个
// 可能不存在的名字（如审计机 macOS 26 上没有 PingFang.ttc）。

const chain = process.platform === 'darwin'
  ? ['PingFang SC', 'Heiti SC', 'Hiragino Sans GB']
  : ['Microsoft YaHei', 'SimHei'];

const style = defaultTextStyle('coverPrimary', 1080);
assert.ok(style.fontFamily && typeof style.fontFamily === 'string', '默认样式 fontFamily 必须非空');
assert.equal(style.fontFamily, chain[0], '未注入可用列表时默认取平台候选链首个');

// 候选链解析：第一个可用项被选中。
assert.equal(resolveDefaultCjkFontFamily(new Set([chain[0]])), chain[0], '候选链首个可用即命中');
assert.equal(resolveDefaultCjkFontFamily(new Set([chain[1]])), chain[1], '首个候选缺失时回落到链上第一个可用项');
assert.equal(resolveDefaultCjkFontFamily(new Set([chain[1], 'Some Other Font'])), chain[1]);
assert.equal(resolveDefaultCjkFontFamily(new Set(['Some Other Font'])), 'sans-serif', '候选链全部缺失时回落 sans-serif');
assert.equal(resolveDefaultCjkFontFamily(undefined), chain[0], '不传 available 时返回平台首个候选');

// setDefaultCjkFontFamily 覆盖默认值（服务端注入真实可用字体）。
const previous = defaultTextStyle('coverPrimary', 1080).fontFamily;
setDefaultCjkFontFamily(chain[1]);
assert.equal(defaultTextStyle('coverPrimary', 1080).fontFamily, chain[1], '服务端注入的默认字体必须生效');
setDefaultCjkFontFamily(previous);

console.log('media-core-cover-domain tests passed');
