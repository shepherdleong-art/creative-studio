/**
 * F4 纯函数测试：identity 归一、去重、搜索、收藏优先排序、归并。
 * 这些函数不访问 DOM，Node 直接覆盖。
 */
import assert from 'node:assert/strict';
import {
  dedupeFontFamilies,
  filterFontsByQuery,
  fontIdentity,
  mergeFontSources,
  normalizeFavorites,
  sortFontFamilies,
} from '../lib/media-core/font-identity.ts';

// ---- identity：混合大小写 / 前后空格 / 全半角用同一 identity ----
assert.equal(fontIdentity('PingFang SC'), 'pingfang sc');
assert.equal(fontIdentity('  PingFang SC  '), 'pingfang sc');
assert.equal(fontIdentity('ＰｉｎｇＦａｎｇ ＳＣ'), 'pingfang sc', '全角字符 NFKC 归一后应命中同一 identity');
assert.equal(fontIdentity('Alibaba PuHuiTi 3.0'), fontIdentity('ALIBABA PUHUITI 3.0'));

// ---- 去重：按 identity 去重，保留第一次出现的原字符串，忽略空串 ----
assert.deepEqual(
  dedupeFontFamilies(['PingFang SC', 'pingfang sc', '', '   ', 'Arial', 'arial']),
  ['PingFang SC', 'Arial'],
);

// ---- 归并：当前值 → 服务端 → queryLocalFonts() → 收藏，同 identity 保留第一个原值 ----
const merged = mergeFontSources([
  ['PingFang SC'],
  ['PingFang SC', 'Arial'],
  ['arial', 'Noto Sans CJK SC'],
  ['PINGFANG SC'],
]);
assert.deepEqual(merged, ['PingFang SC', 'Arial', 'Noto Sans CJK SC'], '同 identity 时保留第一个原值');

// ---- 搜索：identity 包含匹配，空查询返回原列表 ----
assert.deepEqual(filterFontsByQuery(['PingFang SC', 'Arial', 'Noto Sans CJK SC'], 'PINGFANG'), ['PingFang SC']);
assert.deepEqual(filterFontsByQuery(['PingFang SC', 'Arial'], 'sans'), [], '无匹配返回空');
assert.deepEqual(filterFontsByQuery(['PingFang SC', 'Arial'], ''), ['PingFang SC', 'Arial'], '空查询返回完整列表');
assert.deepEqual(filterFontsByQuery(['Arial'], '   '), ['Arial'], '纯空白查询按空处理');

// ---- 收藏优先排序：收藏按偏好数组顺序（最近在前），非收藏按 collator ----
const favorites = ['Zhi Mang Xing', 'PingFang SC'];
const families = ['Arial', 'PingFang SC', 'Zhi Mang Xing', 'Noto Sans CJK SC'];
const sorted = sortFontFamilies(families, favorites);
assert.deepEqual(sorted, ['Zhi Mang Xing', 'PingFang SC', 'Arial', 'Noto Sans CJK SC'], '收藏在前且按偏好顺序，其余按排序');

// collator 相等（忽略大小写/base）时必须用原字符串码点打破平局，保证各平台唯一。
// 期望值写死，不得用 localeCompare 反推——那会跟实现同源，换平台照样绿，什么都锁不住。
// 码点序：'A'(65) < 'B'(66) < 'a'(97) < 'b'(98)。
assert.deepEqual(
  sortFontFamilies(['alpha', 'Alpha', 'Alpha'], []),
  ['Alpha', 'Alpha', 'alpha'],
  'collator 相等时必须按码点排序（大写在前）',
);
assert.deepEqual(
  sortFontFamilies(['beta', 'Alpha', 'BETA', 'alpha'], []),
  ['Alpha', 'alpha', 'BETA', 'beta'],
  '先按 collator 分组，组内再按码点破平局',
);

// ---- 收藏归一：去重、去空 ----
assert.deepEqual(normalizeFavorites(['Arial', 'arial', '', 'PingFang SC']), ['Arial', 'PingFang SC']);
assert.deepEqual(normalizeFavorites(['B', 'A', 'B']), ['B', 'A'], '去重保留最近一次插入前的顺序');

console.log('font identity tests passed');
