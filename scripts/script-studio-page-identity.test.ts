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

console.log('script-studio-page-identity.test.ts: ok');
