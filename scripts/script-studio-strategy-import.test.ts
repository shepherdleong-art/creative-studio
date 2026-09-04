import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseStrategyImport } from '../lib/script-studio/catalog-import/index.ts';

async function buildStrategyBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['小红书林氏年度埋词规划']);
  ws.addRow(['产品信息', null, null, null, '心智策略']);
  ws.addRow(['大类目\n*未来用于看灵犀品类排名', '销售类目\n*未来用于看细分品类的渗透率', '唯一识别名称', '产品型号']);
  ws.addRow([]);
  ws.addRow([]);
  ws.addRow([]);
  ws.addRow([null, null, null, null, '种草品类心智', '品类一级卖点', '单品差异化卖点', '核心人群', '种草内容切入方向', '笔记埋词', '站内外\n种草命名统一']);
  // 数据行 8-12：同型号 XQ9A 两行，统一名称相同 → 合并
  ws.addRow(['沙发', '功能沙发', '沙发XQ9A', 'XQ9A', '品类心智A', '半青皮', '四重汉堡式填充', '人群', '方向', '场景词：#客厅沙发#软装搭配\n风格词：#意式极简', '#林氏微醺功能沙发XQ9A']);
  ws.addRow([null, null, null, null, '品类心智B', '半青皮、耐用', '0号机架', null, null, '#软装搭配', null]);
  // 数据行 10-11：同型号 G707 两行，统一名称不同 → 冲突
  ws.addRow(['床', '软床', '床G707', 'G707', '心智C', '卖点1', '差异1', null, null, '#卧室', '#林氏软床G707']);
  ws.addRow([null, null, null, null, null, null, null, null, null, '#床垫', '#林氏床G707B']);
  // 空白分隔行 12：不生成记录
  ws.addRow([null, null, null, null, null, null, null, null, null, null, null]);
  // 合并型号列：XQ9A 覆盖 8-9，G707 覆盖 10-11
  ws.mergeCells('D8:D9');
  ws.mergeCells('D10:D11');
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

const buffer = await buildStrategyBuffer();
const result = await parseStrategyImport(buffer);

// 1. 表头语义匹配成功，解析出条目
assert.equal(result.entries.length, 2, 'XQ9A 合并成 1 条 + G707 冲突 1 条');
assert.equal(result.report.mergedModelCount, 2);
assert.equal(result.report.canActivate, true, '只有统一名称冲突应仍可激活（报告可查看）');

// 2. 同型号同统一名称：合并保留来源行，卖点拆项/去重保留首次出现顺序
const xq9a = result.entries.find((entry) => entry.modelKey === 'XQ9A');
assert.ok(xq9a);
assert.deepEqual(xq9a.sourceRows, [8, 9]);
assert.equal(xq9a.canonicalName, '#林氏微醺功能沙发XQ9A', '统一名称完全相同保留一个');
assert.deepEqual(xq9a.categoryMindsets, ['品类心智A', '品类心智B'], '范围/主题类字段保留来源范围并按行序合并');
assert.deepEqual(xq9a.primarySellingPoints, ['半青皮', '耐用'], '品类主卖点拆项、去重、保留首次出现顺序');
assert.deepEqual(xq9a.differentiators, ['四重汉堡式填充', '0号机架']);
assert.ok(xq9a.searchTerms.includes('#客厅沙发'));
assert.ok(xq9a.searchTerms.includes('#软装搭配'));
assert.ok(xq9a.searchTerms.includes('#意式极简'));
assert.ok(!xq9a.searchTerms.includes('场景词'), '搜索词不得包含「场景词：」标签前缀');
assert.ok(!xq9a.searchTerms.includes('场景词：#客厅沙发'), '搜索词必须按 # 边界拆开');
assert.equal(xq9a.status, 'active');

// 3. 同型号不同统一名称 → 冲突，不进入自动推荐
const g707 = result.entries.find((entry) => entry.modelKey === 'G707');
assert.ok(g707);
assert.equal(g707.status, 'conflict');
assert.ok(result.report.issues.some((issue) => issue.code === 'canonical_name_conflict' && String(issue.row) === '10'), '冲突必须列出型号与来源行');

// 4. 型号键归一（NFKC + 小写）
assert.ok(result.entries.some((entry) => entry.normalizedModelKey === 'xq9a'));
assert.ok(result.entries.some((entry) => entry.normalizedModelKey === 'g707'));

// 5. 空型号行被跳过
assert.equal(result.report.totalRows, 4, '数据行 8-11 共 4 行（第 12 行是空白分隔行，不生成记录）');

console.log('script-studio-strategy-import tests passed');
