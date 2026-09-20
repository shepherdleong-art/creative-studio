import assert from 'node:assert/strict';
import {
  buildDraftRequest,
  buildFilterRequest,
  charBoundsForTarget,
  cnLen,
  detectTemplateStyle,
  diffMarkWords,
  extractScriptNote,
  findResidualRuns,
  parseDraftResponse,
  parseFilterKeep,
  parseSegmentedText,
  parseStyleAnalysis,
  refClosingExcerpt,
  sanitizeSellingPointText,
  scriptCnLen,
  styleGuideFromAnalysis,
  targetCharsForDuration,
  templateEndingMissing,
  templateVariantsTooSimilar,
  TPL_FALLBACK_STRUCTURE,
  TPL_NEG_HINT,
  TPL_STYLE_PRESETS,
} from '../lib/script-studio/template-rewrite.ts';

/**
 * 爆文模板改写迁移纯函数测试（迁移方案 §4 / A03 / A08 / A14）：
 * 字数口径、文风检测、筛选解析、结构 fallback、残留检查、文字差异、响应解析。
 */

// ---- cnLen / 字数口径（源码 cnLen：只计中文字，不含标点/空白/字母数字）----
assert.equal(cnLen('这款床真的绝了！'), 7, '不计标点');
assert.equal(cnLen('hello 世界 123'), 2, '不计字母数字与空白');
assert.equal(cnLen(''), 0);
assert.equal(targetCharsForDuration(20), 120, '20 秒 × 6 字/秒');
assert.equal(targetCharsForDuration(15), 90);
assert.deepEqual(charBoundsForTarget(120), { min: 102, max: 138 }, '±15% 容差');
assert.deepEqual(charBoundsForTarget(90), { min: 77, max: 103 }, '15 秒边界（90*1.15 浮点为 103.49…→103）');
assert.equal(charBoundsForTarget(0).min, 20, '下限保底 20（源码 fixScriptLength 行为）');
assert.equal(
  scriptCnLen('标题四个字', [{ narration: '正文十个字啊' }, { narration: '卖点段落' }]),
  5 + 6 + 4,
  '字数含标题与正文；段名由调用方剥除（narration 不含【段名】）',
);

// ---- 文风检测（迁移 detectTplStyle）----
assert.equal(detectTemplateStyle({ refText: '现在拍下立减，马上抢，别犹豫，库存不多了家人们' }), 'hot');
assert.equal(detectTemplateStyle({ refText: '成分温和不刺激，亲测有效，分享使用感受和配方步骤' }), 'grass');
assert.equal(detectTemplateStyle({ refText: '陪伴孩子成长的时光，温暖治愈的生活仪式感' }), 'feel');
assert.equal(detectTemplateStyle({ refText: '我跟你说姐妹这个太好用了，真的绝了，无限回购' }), 'friend');
assert.equal(detectTemplateStyle({ refText: '实测数据对比，参数拆解，专业评测值不值' }), 'expert');
assert.equal(detectTemplateStyle({ refText: '', category: '家电', subCategory: '冰箱' }), 'expert', '3C/家电类目先验');
assert.equal(detectTemplateStyle({ refText: '', category: '食品', subCategory: '零食' }), 'friend', '食品类目先验');
assert.equal(detectTemplateStyle({ refText: '今天天气不错，随便聊聊这张桌子' }), '', '打分不足回退通用');
assert.ok(TPL_STYLE_PRESETS[''].name && TPL_STYLE_PRESETS.hot.role && TPL_STYLE_PRESETS.expert.neg, '六个预设齐全');

// ---- 风格分析解析与风格要求段 ----
assert.deepEqual(
  parseStyleAnalysis({ 说话感觉: '像朋友聊天', 开头词: ['姐妹们'], 句长: '短句多', 钩子套路: '反问', 结尾方式: '自然', 禁用词: ['家人们'] }),
  { 说话感觉: '像朋友聊天', 开头词: ['姐妹们'], 句长: '短句多', 钩子套路: '反问', 结尾方式: '自然', 禁用词: ['家人们'] },
);
assert.equal(parseStyleAnalysis({}), null, '空结果按未分析处理');
assert.equal(parseStyleAnalysis('不是对象'), null);
const guide = styleGuideFromAnalysis({ 说话感觉: '像朋友聊天', 开头词: ['姐妹们'] }, '第一句钩子。第二句展开。后面内容。');
assert.ok(guide.includes('说话感觉') && guide.includes('开头3秒铁律'), '风格要求含分析与开头铁律');
assert.ok(styleGuideFromAnalysis(null, '参考').includes('避免逐句照抄'), '无分析时用通用模仿要求');
assert.ok(styleGuideFromAnalysis(null, '闺蜜来家里就不走了。来挑你喜欢的颜色！').includes('开头3秒铁律'), '风格降级不能丢掉原文开头锚点');
assert.ok(styleGuideFromAnalysis(null, '闺蜜来家里就不走了。来挑你喜欢的颜色！').includes('结尾模仿铁律'), '风格降级不能丢掉原文结尾锚点');
assert.ok(templateVariantsTooSimilar('闺蜜来我家就赖在沙发上不走。双层高靠包托住脖子和腰，躺着追剧很舒服。', '标题：换个标题\n姐妹来我家就赖在沙发上不走。双层高靠包托住腰和脖子，躺着看剧很舒服。'), '近似换词不能冒充不同变体');
assert.ok(!templateVariantsTooSimilar('下班累得不行，往高靠包上一靠，腰窝和脖子都有了支撑。', '孩子把果汁洒在沙发上，拉开拉链拆下布套，丢进洗衣机就好。'), '同一产品的不同事件和主卖点可以通过');

// ---- 筛选解析（迁移 filterTplSellingPoints keep 语义）----
const filterReq = buildFilterRequest({ refSnippet: '参考前六百字', candidates: [{ id: '1', text: '卖点甲（详解甲）' }, { id: '2', text: '卖点乙（详解乙）' }] });
assert.ok(filterReq.userPrompt.includes('参考前六百字') && filterReq.userPrompt.includes('1. 卖点甲（详解甲）'), '筛选请求带参考与编号候选');
assert.deepEqual(parseFilterKeep({ keep: [1, 2] }, ['1', '2']), ['1', '2'], '数字编号兼容');
assert.deepEqual(parseFilterKeep({ keep: ['2'] }, ['1', '2']), ['2']);
assert.deepEqual(parseFilterKeep({ keep: ['99', 'abc', '1'] }, ['1', '2']), ['1'], '非法/越界编号剔除');
assert.deepEqual(parseFilterKeep({ keep: [] }, ['1', '2']), [], '全不相似返回空（调用方降级保留全部）');
assert.equal(parseFilterKeep({ nokeep: [] }, ['1', '2']), null, '结构非法返回 null（调用方降级）');
assert.equal(parseFilterKeep(null, ['1', '2']), null);

// ---- 草稿解析（标题/分段/元注释清洗/修改说明抽取/refs 映射保留）----
const parsed = parseDraftResponse({
  title: '《测试标题》',
  note: '把沙发换成了餐桌',
  segments: [
    { label: '钩子', text: '小户型真的需要大餐桌吗', refs: ['1'] },
    { label: '修改说明', text: '这段不能进正文', refs: [] },
    { label: '字数统计', text: '全文约120字', refs: [] },
    { label: '卖点', text: '伸缩设计四人变六人', refs: ['2'] },
  ],
});
assert.ok(parsed);
assert.equal(parsed.title, '测试标题', '标题去书名号');
assert.equal(parsed.segments.length, 2, '修改说明段与元注释段不进正文');
assert.deepEqual(parsed.segments.map((seg) => seg.label), ['钩子', '卖点']);
assert.equal(parsed.note.includes('把沙发换成了餐桌'), true);
assert.equal(parsed.note.includes('这段不能进正文'), true, '说明段文本抽进 note');
assert.deepEqual(parsed.segments[0]!.refs, ['1'], '段级引用编号保留');
assert.equal(parseDraftResponse({ title: '无段' }), null, '无有效分段按失败处理');
assert.equal(parseDraftResponse(null), null);

const noteExtract = extractScriptNote([
  { label: '钩子', text: '正文内容\n修改说明：尾部说明也算' },
  { label: '卖点', text: '卖点内容' },
]);
assert.equal(noteExtract.segments.length, 2);
assert.equal(noteExtract.segments[0]!.text, '正文内容', '尾注从正文剥除');
assert.ok(noteExtract.note.includes('尾部说明也算'));

const segmented = parseSegmentedText('标题：分段标题\n【钩子】第一句\n第二句\n【卖点】内容\n（全文约120字）');
assert.equal(segmented.title, '分段标题');
assert.equal(segmented.segments.length, 2);
assert.equal(segmented.segments[0]!.text, '第一句\n第二句');

// 段名自带括号时，经过 JSON 首稿 → 润色文本 → 重解析，不能污染口播。
for (const label of ['钩子', '【钩子】', ' 【【钩子】】 ']) {
  const draft = parseDraftResponse({ segments: [{ label, text: '我跟你说，绘本终于有地儿了。', refs: ['1'] }] })!;
  const polished = parseSegmentedText(draft.segments.map((seg) => `【${seg.label}】${seg.text}`).join('\n'));
  assert.equal(polished.segments[0]!.text, '我跟你说，绘本终于有地儿了。', `段名 ${label} 不得残留右括号`);
  assert.equal(draft.segments[0]!.label, '钩子');
  assert.deepEqual(draft.segments[0]!.refs, ['1']);
}
assert.deepEqual(
  parseSegmentedText('  【【钩子】】我跟你说。\n 【 【卖点】 】可以放【绘本】和玩具。').segments,
  [{ label: '钩子', text: '我跟你说。' }, { label: '卖点', text: '可以放【绘本】和玩具。' }],
  '润色返回嵌套段名时完整解析标签，保留正文中的括号',
);
assert.equal(parseSegmentedText('【卖点】【绘本】也能放。').segments[0]!.text, '【绘本】也能放。');
assert.equal(parseDraftResponse({ segments: [
  { label: '【钩子】', text: '正文里保留【绘本】。' },
  { label: '【修改说明】', text: '换成了书柜' },
] })!.note, '换成了书柜', '规范化后的修改说明仍正确提取');

// ---- 残留检查（A07）：连续相同 ≥12 中文字 ----
const ref = '这款意式极简沙发真的太好看了吧放在客厅特别有氛围感';
assert.deepEqual(findResidualRuns(ref, '完全不一样的话'), []);
assert.ok(findResidualRuns(ref, '我觉得这款意式极简沙发真的太好看了吧放在客厅').length > 0, '连续相同被拦截');
assert.deepEqual(findResidualRuns(ref, '这款意式极简衣柜'), [], '短于 12 字的巧合不拦截');
assert.equal(TPL_FALLBACK_STRUCTURE, '钩子>痛点>卖点>逼单', '结构 fallback 为源码默认');

// ---- 文字差异（迁移 diffMark 的 LCS；只标文字差异，不宣称原创率）----
const marks = diffMarkWords('这款沙发，真好看', '这款餐桌，真实用');
assert.ok(marks.some((m) => m.del && m.w === '这款沙发'), '参考被替换的词标记删除');
assert.ok(marks.some((m) => m.diff && !m.del && m.w === '这款餐桌'), '生成新词标记差异');
assert.ok(marks.some((m) => !m.diff && m.w === '，'), '相同词不标色');

// ---- 卖点文本净化：详情页免责声明整句剥除 ----
assert.equal(
  sanitizeSellingPointText('床体经真人实测，承重超过1000斤；不同人体重有所偏差，数据仅供参考，以实际为准。'),
  '床体经真人实测，承重超过1000斤；不同人体重有所偏差',
  '免责尾巴子句剥除',
);
assert.equal(
  sanitizeSellingPointText('BC551-B款1.8m规格展示使用加宽实木排骨架，页面标注可承重2000斤；BC551-A款数据有差异，具体以实物为准。'),
  'BC551-B款1.8m规格展示使用加宽实木排骨架，页面标注可承重2000斤；BC551-A款数据有差异',
  '以实物为准剥除',
);
assert.equal(sanitizeSellingPointText('伸缩设计四人变六人'), '伸缩设计四人变六人', '无免责内容原样保留');
assert.equal(sanitizeSellingPointText(''), '');

// ---- 负面提示词与文风预设：禁型号/禁免责口径；专家测评不写「值不值」元描述 ----
assert.ok(TPL_NEG_HINT.includes('型号/货号编码') && TPL_NEG_HINT.includes('以实际为准'), '负面提示词含型号与免责声明禁令');
assert.ok(!TPL_STYLE_PRESETS.expert.guide.includes('强调"值不值"'), '专家测评不再用字面「值不值」元描述');
assert.ok(TPL_STYLE_PRESETS.expert.guide.includes('值不值'), '专家测评保留禁止写「值不值」的说明');

// ---- 结尾模仿铁律（2026-09-18 质量修复）：风格要求锚定参考文案末句 ----
assert.equal(refClosingExcerpt('第一句钩子。第二句展开。最后一句逼单！'), '第二句展开。最后一句逼单');
const guideWithClosing = styleGuideFromAnalysis({ 说话感觉: '像朋友聊天' }, '开头钩子。中间卖点。点下方链接带回家！');
assert.ok(guideWithClosing.includes('结尾模仿铁律') && guideWithClosing.includes('点下方链接带回家'), '结尾铁律含参考末句');

// ---- 结尾缺失检查 ----
assert.equal(templateEndingMissing([{ label: '卖点', text: '收纳空间很大。' }]), true, '末句无行动引导判缺失');
assert.equal(templateEndingMissing([{ label: '逼单', text: '还等什么。' }]), false, '结尾段名直接判有结尾');
assert.equal(templateEndingMissing([{ label: '卖点', text: '收纳空间很大。点下方链接看看吧' }]), false, '末句行动引导判有结尾');
assert.equal(templateEndingMissing([]), true, '空稿判缺失');

// ---- 首稿请求：同模板变体差异化约束（2026-09-18 质量修复）----
const draftReq = buildDraftRequest({
  sellingPointTexts: ['卖点甲（详解甲）'],
  refText: '参考文案全文',
  structure: '钩子>卖点>逼单',
  styleGuide: '',
  stylePresetGuide: '',
  stylePresetNeg: '',
  targetChars: 90,
  previousTitles: ['旧标题'],
  previousVariants: ['标题：旧变体\n旧变体正文内容'],
});
assert.ok(draftReq.userPrompt.includes('同模板已生成变体') && draftReq.userPrompt.includes('旧变体正文内容'), '变体差异化约束进 prompt');
const draftReqNoVariant = buildDraftRequest({
  sellingPointTexts: ['卖点甲（详解甲）'],
  refText: '参考文案全文',
  structure: '',
  styleGuide: '',
  stylePresetGuide: '',
  stylePresetNeg: '',
  targetChars: 90,
  previousTitles: [],
});
assert.ok(!draftReqNoVariant.userPrompt.includes('同模板已生成变体'), '无变体时不加差异化段');

console.log('script-studio-template-rewrite-unit tests passed');
