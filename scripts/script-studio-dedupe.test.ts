import assert from 'node:assert/strict';
import { dedupeSellingPoints } from '../lib/script-studio/dedupe.ts';

// 跨页合并：每条证据引用保留自己的 pageIndex + tileRef 配对，不能只留一个页码挂多个切片。
const merged = dedupeSellingPoints([
  {
    title: '实木框架',
    factText: '采用实木框架',
    pointType: 'material',
    evidenceQuote: '采用实木框架',
    sourcePageIndex: 0,
    tileRefs: ['tile_1'],
    themeKey: 'theme-a',
    themeTitle: '扎实用料',
    hierarchyRole: 'supporting',
    importance: 60,
  },
  {
    title: '实木框架结构',
    factText: '采用实木框架，承重更强',
    pointType: 'material',
    evidenceQuote: '框架为实木',
    sourcePageIndex: 1,
    tileRefs: ['tile_2'],
    themeKey: '',
    themeTitle: '',
    hierarchyRole: 'primary',
    importance: 80,
  },
]);
assert.equal(merged.length, 1, '近重复事实必须合并');
const point = merged[0]!;
assert.deepEqual(
  point.evidenceRefs,
  [{ pageIndex: 0, tileRef: 'tile_1' }, { pageIndex: 1, tileRef: 'tile_2' }],
  '跨页合并后每个 tileRef 仍对应自己的 pageIndex',
);
assert.deepEqual(point.tileRefs, ['tile_1', 'tile_2'], '旧切片字段由配对结构派生');
assert.equal(point.sourcePageIndex, 0, '旧页码字段取首条引用页码');
assert.equal(point.evidenceQuote, '采用实木框架；框架为实木', '逐字证据全部保留');
assert.equal(point.themeKey, 'theme-a', '主题键取首个非空');
assert.equal(point.themeTitle, '扎实用料', '主题名取首个非空');
assert.equal(point.hierarchyRole, 'primary', '层级角色取最强（primary > supporting > detail）');
assert.equal(point.importance, 80, '重要度取最高');

// 显式 evidenceRefs 输入与旧字段输入混合时，同样按配对合并且不产生重复引用。
const hybrid = dedupeSellingPoints([
  {
    title: '可折叠设计',
    factText: '支持折叠收纳',
    pointType: 'structure',
    evidenceQuote: '支持折叠',
    evidenceRefs: [{ pageIndex: 0, tileRef: 'tile_3' }],
    hierarchyRole: 'detail',
    importance: 40,
  },
  {
    title: '折叠收纳设计',
    factText: '支持折叠收纳，节省空间',
    pointType: 'structure',
    evidenceQuote: '折叠后仅 20cm',
    sourcePageIndex: 0,
    tileRefs: ['tile_3', 'tile_4'],
    themeKey: 'theme-b',
    themeTitle: '小户型也能放下',
    hierarchyRole: 'supporting',
    importance: 55,
  },
]);
assert.equal(hybrid.length, 1);
assert.deepEqual(
  hybrid[0]!.evidenceRefs,
  [{ pageIndex: 0, tileRef: 'tile_3' }, { pageIndex: 0, tileRef: 'tile_4' }],
  '相同配对去重、不同配对全保留',
);
assert.equal(hybrid[0]!.themeKey, 'theme-b', '后者主题同样被保留');
assert.equal(hybrid[0]!.hierarchyRole, 'supporting', '合并只增强不削弱层级角色');
assert.equal(hybrid[0]!.importance, 55);

// 非重复事实保持独立，原有元数据不受影响。
const distinct = dedupeSellingPoints([
  { title: '黑色外观', factText: '产品外观为黑色', pointType: 'appearance', evidenceQuote: '黑色', sourcePageIndex: 0, tileRefs: ['tile_1'], themeKey: 't-1', hierarchyRole: 'primary', importance: 70 },
  { title: '实木框架', factText: '采用实木框架', pointType: 'material', evidenceQuote: '实木框架', sourcePageIndex: 0, tileRefs: ['tile_2'], themeKey: 't-2', hierarchyRole: 'detail', importance: 30 },
]);
assert.equal(distinct.length, 2);
assert.equal(distinct[0]!.themeKey, 't-1');
assert.equal(distinct[1]!.themeKey, 't-2');

console.log('script-studio-dedupe.test.ts: ok');
