import assert from 'node:assert/strict';
import {
  comparePageIdentities,
  findCrossProductConflict,
  isSameProductName,
  normalizeIdentityField,
  sharedNumberedSourceStem,
} from '../lib/script-studio/page-identity.ts';

// normalizeIdentityField：忽略大小写、空格与标点，只留字母数字。
assert.equal(normalizeIdentityField('林氏家居 PC615-真皮床'), '林氏家居pc615真皮床');
assert.equal(normalizeIdentityField('  PC615  '), 'pc615');
assert.equal(normalizeIdentityField('###'), '');

// isSameProductName：空值不构成冲突证据。
assert.equal(isSameProductName('', 'pc615'), true);
assert.equal(isSameProductName('pc615', ''), true);

// 完全一致 / 大小写与空格差异（调用方先归一化，这里直接验证归一化后的形态）。
assert.equal(isSameProductName('pc615软床框架', 'pc615软床框架'), true);

// 互为子串：一页识别出完整名称，另一页只识别出泛称。
// 真机样本：Luna 对 PC615 上半页识别「PC615软床框架」、下半页识别「软床」。
assert.equal(isSameProductName('pc615软床框架', '软床'), true);

// 措辞近似但不互为子串：bigram 重合度高判同款。
assert.equal(isSameProductName('林氏家居pc615真皮床', '林氏家居pc615真皮储物床'), true);

// 明显不同：不同品牌/品类无交集。
assert.equal(isSameProductName('林氏pc615真皮储物床', '全友科技布沙发a100'), false);

// 型号相近但不同款：pc615床 vs pc669床（重合度 0.4 < 阈值 0.6）。
assert.equal(isSameProductName('pc615床', 'pc669床'), false);

// findCrossProductConflict
const page = (pageIndex: number, productName: string, category = '', brand = '') => ({
  pageIndex, productName, category, brand,
});

// 真实两段详情页：产品名与品牌 + 品类泛称，不足以证明跨商品。
assert.equal(findCrossProductConflict([
  page(0, '摩卡沙发', '沙发', '林氏'),
  page(1, '林氏沙发', '沙发', '林氏家居'),
]), null);

const splitSourcePages = [
  { pageIndex: 0, filename: '20260909-203732.872-2.jpg' },
  { pageIndex: 1, filename: '20260909-203732.872-14.jpg' },
];
assert.equal(sharedNumberedSourceStem(splitSourcePages[0]!.filename, splitSourcePages[1]!.filename), '20260909-203732.872');
assert.equal(comparePageIdentities(
  page(0, '摩卡沙发', '沙发', '林氏'),
  page(1, '林氏沙发', '沙发', '林氏家居'),
  { sourcePages: splitSourcePages },
).verdict, 'unknown');
// 同一编号主干可以解释名称差异，但不覆盖模型明确报告的不同型号。
assert.ok(findCrossProductConflict([
  page(0, 'PC615真皮床', '床', '林氏家居'),
  page(1, 'PC669真皮床', '床', '林氏家居'),
], { sourcePages: splitSourcePages }));
assert.ok(findCrossProductConflict([
  page(0, '摩卡沙发', '沙发', '林氏'),
  page(1, '布艺沙发', '沙发', '全友'),
], { sourcePages: splitSourcePages }), '明确不同品牌仍须拦截，不能被文件名覆盖');
assert.ok(findCrossProductConflict([
  page(0, '摩卡沙发', '沙发', '林氏家居'),
  page(1, '黑森林沙发', '沙发', '林氏家居'),
], { sourcePages: splitSourcePages }), '同主干也不能覆盖两个具体系列名称冲突');
// 通用文件前缀和相同扩展名不构成分段身份。
assert.equal(sharedNumberedSourceStem('image-1.jpg', 'image-2.jpg'), null);

// 商品详情的括号分段：颜色描述、组合名及主干中列出的功能款属于同一系列。
const seriesPages = [1, 2].map((number, pageIndex) => ({
  pageIndex, filename: `PS515-A组合-商品详情1200-双色沙发+PS513-A(${number}).jpg`,
}));
const seriesContext = { sourcePages: seriesPages };
assert.equal(comparePageIdentities(
  page(0, '双色沙发', '沙发', 'Oxhide'), page(1, 'PS515-A组合', '沙发', 'Oxhide'), seriesContext,
).reason, 'shared_detail_series_source');
assert.equal(findCrossProductConflict([
  page(0, 'PS515-A沙发'), page(1, 'PS513-A沙发'),
], seriesContext), null);
assert.equal(findCrossProductConflict([
  page(0, 'PS515-A沙发'), page(1, 'PS515-B沙发'),
]), null, '同基础型号的配置款不应误判为不同商品');
assert.ok(findCrossProductConflict([
  page(0, 'PS515-A沙发'), page(1, 'PS999-A沙发'),
], seriesContext), '未在系列文件名中出现的不同型号仍拦截');
assert.ok(findCrossProductConflict([
  page(0, '双色沙发', '沙发', 'Oxhide'), page(1, 'PS515-A沙发', '沙发', '其他品牌'),
], seriesContext));
assert.ok(findCrossProductConflict([
  page(0, 'PS515-A沙发'), page(1, 'PS513-A餐桌'),
], seriesContext));
assert.equal(sharedNumberedSourceStem('image(1).jpg', 'image(2).jpg'), null);
assert.equal(sharedNumberedSourceStem(seriesPages[0]!.filename, seriesPages[0]!.filename), null);
assert.equal(sharedNumberedSourceStem('商品详情PS515-A（1）.tif', '商品详情PS515-A（2）.tif'), '商品详情ps515-a');

// 共同的品牌/描述不能盖过两个明确且不同的型号。
assert.ok(findCrossProductConflict([
  page(0, '林氏家居PC615真皮储物床', '床', '林氏家居'),
  page(1, '林氏家居PC669真皮储物床', '床', '林氏家居'),
]));

// 同一产品两页：名称包含关系 + 品类/品牌措辞不一致 → 不冲突（本次线上误报场景）。
assert.equal(findCrossProductConflict([
  page(0, 'PC615软床框架', '软床', '林氏家居'),
  page(1, '软床', '床', ''),
]), null);

// 一页未识别出商品名 → 弃权，不冲突（旧口径下 "|床|" 与 "pc615|床|林氏" 会误报）。
assert.equal(findCrossProductConflict([
  page(0, 'PC615软床框架', '软床', '林氏家居'),
  page(1, '', '', ''),
]), null);

// 全部未识别 → 不冲突。
assert.equal(findCrossProductConflict([page(0, ''), page(1, '')]), null);

// 品类/品牌不同但名称一致 → 不冲突。
assert.equal(findCrossProductConflict([
  page(0, 'PC615', '软床', '林氏家居'),
  page(1, 'pc615', '床', ''),
]), null);

// 真混商品 → 报出第一对冲突页。
const conflict = findCrossProductConflict([
  page(0, '林氏PC615真皮储物床', '软床', '林氏家居'),
  page(1, '林氏PC615真皮储物床', '软床', '林氏家居'),
  page(2, '全友科技布沙发A100', '沙发', '全友'),
]);
assert.ok(conflict);
assert.equal(conflict[0].pageIndex, 0);
assert.equal(conflict[1].pageIndex, 2);

// 空列表 → 不冲突。
assert.equal(findCrossProductConflict([]), null);

// 真实误拦（2026-09-17 PC673-A组合四件套）：同一套详情页的逐页品牌识别噪声（角标/文字误读为
// 「苏世博」）不能证明跨商品——两边都无明确型号且主干含系列型号时，品牌冲突降级为不确定。
const pc673Pages = [1, 2].map((number, pageIndex) => ({
  pageIndex, filename: `PC673-A组合-商品详情1200-四件套-GIF(${number}).jpg`,
}));
assert.equal(comparePageIdentities(
  page(0, '气动床', '床', '苏世博'), page(1, '云翼半青皮软床', '软床', '林氏家居'),
  { sourcePages: pc673Pages },
).reason, 'brand_mismatch_within_shared_detail_series');
assert.equal(findCrossProductConflict([
  page(0, '气动床', '床', '苏世博'), page(1, '云翼半青皮软床', '软床', '林氏家居'),
], { sourcePages: pc673Pages }), null);
// 功能款型泛称（气动/升降/折叠）与「电动/储物」同类，不构成具体商品名：
// 无来源证据时判「泛称/信息不全」而不是按不同具体名拦截。
assert.equal(comparePageIdentities(
  page(0, '气动床', '床', '林氏家居'), page(1, '云翼半青皮软床', '软床', '林氏家居'),
).reason, 'generic_or_incomplete_name');
assert.notEqual(comparePageIdentities(
  page(0, '气动床', '床', '林氏家居'), page(1, '云翼半青皮软床', '软床', '林氏家居'),
  { sourcePages: pc673Pages },
).verdict, 'conflict');
// 保护：无系列证据（时间戳主干）时，不同品牌仍拦截。
assert.ok(findCrossProductConflict([
  page(0, '气动床', '床', '苏世博'), page(1, '云翼半青皮软床', '软床', '林氏家居'),
], { sourcePages: splitSourcePages }), '无系列依据时不同品牌仍须拦截');
// 保护：任一边识别出明确型号时，不同品牌仍拦截。
assert.ok(findCrossProductConflict([
  page(0, '气动床', '床', '苏世博'), page(1, 'PC673软床', '软床', '林氏家居'),
], { sourcePages: pc673Pages }), '另一边识别出明确型号时不同品牌仍须拦截');

console.log('script-studio-page-identity.test.ts: ok');
