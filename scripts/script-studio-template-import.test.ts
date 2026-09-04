import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseTemplateImport } from '../lib/script-studio/catalog-import/index.ts';

async function buildTemplateBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const frameworks = wb.addWorksheet('脚本核心框架');
  frameworks.addRow(['视频类型', '细分类型', '核心结构', '卖点密度', '全片时长', '适用产品', '首选钩子', '次选钩子']);
  frameworks.addRow(['01 痛点解决型', '解决问题‑给方案', '痛点暴露（3s）+ 原因揭示（3s）+ 产品解决（5s）', '3‑4 个', '15-20秒', '全品类', '痛点式 / 后悔式', '反问式']);
  frameworks.addRow(['02 场景需求型', '还原生活‑引需求', '场景进入（3s）+ 需求发生（3s）+ 产品介入（4s）', '2‑3 个', '15-20秒', '全品类', '反问式 / 痛点式', '利益式']);
  frameworks.addRow(['03 多卖点合辑型', '卖点合集', '卖点A + 卖点B + 卖点C', '5‑6 个', '30-45秒', '功能多卖点', '利益式', '痛点式']);

  const copyHooks = wb.addWorksheet('开头钩子文案');
  copyHooks.addRow(['钩子类型', '核心机制', '公式', null, '文案示例', '推荐视频类型', '推荐卖点']);
  copyHooks.addRow(['反问式', '激发思考', '行为反问', '为什么越来越多人开始【行为变化】？', '为什么越来越多人开始淘汰传统餐桌？', '场景需求型 / 痛点解决型', '选购标准、功能差异']);
  copyHooks.addRow([null, null, '场景反问', '【场景】真的需要【传统方案】吗？', '小户型真的需要大沙发吗？', null, null]);
  copyHooks.addRow(['利益式', '利益前置', '利益点直给', '【核心利益】到底值不值？', '万元级体验，千元级价格', '场景需求型', '价格、性价比']);
  copyHooks.mergeCells('A2:A3'); // 钩子类型向下继承

  const visualHooks = wb.addWorksheet('开头钩子画面（待优化）');
  visualHooks.addRow(['核心玩法', '裂变玩法', '画面公式', '示例画面', '参考案例', 'AI实现路径', '适合品类', '搭配钩子', '参考口令', null]);
  visualHooks.addRow(['0→1 生成', '快递箱爆炸开场炸出所有家具', '[快递箱在空客厅]→[炸开粒子]→[所有家具飞出]', '', 'AI小特效', '可灵图生视频首尾帧', '全品类；重点：床', '利益式 / 悬念式', '试试看', '即梦OK']);
  visualHooks.addRow([null, '空场景所有家具丝滑进场', '[空房间]→[家具依次滑入]', null, null, '可灵首尾帧', '全品类', '场景代入 / 利益式', null, '需要前期制图']);
  visualHooks.addRow([null, '', '[缺失玩法名称的行]', null, null, '可灵', '全品类', '利益式', null, null]);
  // 与第 2 行完全重复的内容行：真实表偶发连写两行，应按稳定键合并保留首行
  visualHooks.addRow([null, '快递箱爆炸开场炸出所有家具', '[重复行的画面公式]', null, null, null, null, null, null, null]);
  visualHooks.mergeCells('A2:A5'); // 核心玩法向下继承

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

const buffer = await buildTemplateBuffer();
const result = await parseTemplateImport(buffer);

// 1. 三个工作表都被识别
assert.equal(result.templates.frameworks.length, 3, '框架 3 条');
assert.equal(result.templates.copyHooks.length, 3, '文案钩子 3 条（反问式 2 + 利益式 1）');
assert.equal(result.templates.visualHooks.length, 3, '画面钩子 3 行（含 1 行缺玩法名称）');
assert.equal(result.templates.report.templateCounts?.framework, 3);
assert.equal(result.templates.report.templateCounts?.copyHook, 3);
assert.equal(result.templates.report.templateCounts?.visualHook, 3);
assert.equal(result.templates.report.templateCounts?.draftInvalid, 1);

// 2. 框架：稳定键用编号；「合辑/合集」归一为同一稳定 ID；秒数保留在结构里但不作契约
const f01 = result.templates.frameworks.find((item) => item.stableKey === '01');
assert.ok(f01);
assert.equal(f01.name, '01 痛点解决型');
assert.ok(f01.structure.length >= 3, '核心结构按 + 拆段');
assert.deepEqual(f01.preferredHookTypes, ['痛点式', '后悔式']);
const f03 = result.templates.frameworks.find((item) => item.name.includes('多卖点'));
assert.ok(f03);
assert.equal(f03.stableKey, '03', '合辑/合集归一为同一个稳定 ID');

// 3. 文案钩子：类型向下继承，公式/子类型/示例分离
const fh = result.templates.copyHooks.find((item) => item.subtype === '行为反问');
assert.ok(fh);
assert.equal(fh.hookType, '反问式');
assert.equal(fh.formula, '为什么越来越多人开始【行为变化】？', '公式取无标题公式列');
assert.equal(fh.example, '为什么越来越多人开始淘汰传统餐桌？');
assert.ok(fh.recommendedSellingPointTags.includes('选购标准'));
const benefitHook = result.templates.copyHooks.find((item) => item.hookType === '利益式');
assert.ok(benefitHook);

// 4. 画面钩子：分组向下继承，J 列无标题导入为制作备注
const vh1 = result.templates.visualHooks.find((item) => item.playName === '快递箱爆炸开场炸出所有家具');
assert.ok(vh1);
assert.equal(vh1.playGroup, '0→1 生成');
assert.ok(vh1.notes.includes('制作备注：即梦OK'), 'J 列无标题内容按约定导入为制作备注');
assert.ok(vh1.notes.includes('参考口令'));
const vh2 = result.templates.visualHooks.find((item) => item.playName === '空场景所有家具丝滑进场');
assert.ok(vh2);
assert.equal(vh2.playGroup, '0→1 生成', '核心玩法向下继承');
assert.ok(vh2.notes.includes('制作备注：需要前期制图'));

// 5. 缺玩法名称的行标记 draft_invalid，不进入自动推荐
const invalid = result.templates.visualHooks.find((item) => item.status === 'draft_invalid');
assert.ok(invalid);
assert.equal(invalid.visualFormula, '[缺失玩法名称的行]');
assert.ok(result.templates.report.issues.some((issue) => issue.code === 'visual_hook_missing_name'));

// 5b. 完全重复的内容行按稳定键合并保留首行，重复行显式进报告且不阻断激活
assert.equal(result.templates.visualHooks.filter((item) => item.playName === '快递箱爆炸开场炸出所有家具').length, 1, '重复行只保留首行');
assert.ok(result.templates.report.issues.some((issue) => issue.code === 'duplicate_stable_key'), '重复稳定键进报告');
assert.equal(result.templates.report.canActivate, true, '合并去重不阻断激活');

// 6. 无法识别的表头列出现在报告提示
assert.ok((result.templates.report.unmappedHeaders ?? []).length >= 1, '无标题列映射应出现在报告提示');

console.log('script-studio-template-import tests passed');
