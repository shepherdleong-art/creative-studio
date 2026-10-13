// 包装文案自动组装 v2（lib/final-edit/packaging-vars.ts）单元测试
// 运行：node scripts/final-edit-packaging-vars.test.ts
import assert from 'node:assert/strict';
import { buildPackagingVars, cleanSellingPoint, extractProductWord, mergePackagingLayouts, parsePackagingConfig, selectSellingPoints, type PackagingVarsSourceCue } from '../lib/final-edit/packaging-vars.ts';

function cue(text: string, startUs: number, textSource: 'script' | 'manual' = 'script'): PackagingVarsSourceCue {
  return { text, startUs, textSource };
}

{
  const input = { subtitleCues: [], project: { productName: '储物床' }, coverTitle: { primary: '小房间也能住得开', secondary: '床底空间全用上' } };
  assert.equal(buildPackagingVars(input).title, '小房间也能住得开');
  assert.equal(buildPackagingVars(input).subtitle, '床底空间全用上');
  assert.equal(buildPackagingVars({ ...input, overrides: { title: '手动标题' } }).title, '手动标题');
  assert.equal(buildPackagingVars({ ...input, coverTitle: { primary: '新脚本标题', secondary: '' } }).subtitle, '', '显式空副标题不回填产品卖点');
  assert.equal(parsePackagingConfig({ enabled: false }).enabled, false, '尊重已保存的关闭选择');
}

// 1) cleanSellingPoint：去序号/引号
{
  assert.equal(cleanSellingPoint('"1. 100%全实木打造，进口白桦木0贴皮'), '100%全实木打造，进口白桦木0贴皮');
  assert.equal(cleanSellingPoint('3、一栏到底高护栏'), '一栏到底高护栏');
  assert.equal(cleanSellingPoint('  无序号条目  '), '无序号条目');
}

// 2) extractProductWord：产品名词提炼
{
  assert.equal(extractProductWord('复古质感实木餐边柜'), '质感实木餐边柜');
  assert.equal(extractProductWord('这款全实木儿童床真的稳'), '实木儿童床');
  assert.equal(extractProductWord('100%全实木打造进口白桦木餐边柜'), '白桦木餐边柜');
  assert.equal(extractProductWord('不含产品词的一句话'), '');
  assert.equal(extractProductWord(''), '');
}

// 3) 标题回退链
{
  // productName 优先
  const byProductName = buildPackagingVars({
    subtitleCues: [],
    project: { productName: '全实木餐边柜', sellingPoints: ['1. 别的卖点'] },
    exportIdentity: { taskName: 'VM1T-B', productCode: 'VM1T-B' },
  });
  assert.equal(byProductName.title, '全实木餐边柜');

  // productName 空 → 卖点库第一条提炼
  const bySelling = buildPackagingVars({
    subtitleCues: [],
    project: { productName: '', sellingPoints: ['1. 100%全实木打造进口白桦木餐边柜'] },
    exportIdentity: { taskName: 'VM1T-B', productCode: 'VM1T-B' },
  });
  assert.equal(bySelling.title, '白桦木餐边柜', `卖点提炼标题，实际：${bySelling.title}`);

  // 无卖点库 → 字幕提炼
  const byCue = buildPackagingVars({
    subtitleCues: [cue('复古质感实木餐边柜', 0)],
    exportIdentity: { taskName: 'VM1T-B', productCode: 'VM1T-B' },
  });
  assert.equal(byCue.title, '质感实木餐边柜');

  // 全空 → 任务名；任务名空 → 货号
  const byTask = buildPackagingVars({ subtitleCues: [], exportIdentity: { taskName: '任务名', productCode: 'X1' } });
  assert.equal(byTask.title, '任务名');
  const byCode = buildPackagingVars({ subtitleCues: [], exportIdentity: { taskName: '', productCode: 'X1' } });
  assert.equal(byCode.title, 'X1');
}

// 4) 卖点库优先（清理+去重+截断到 12 字），字幕启发式兜底
{
  const points = selectSellingPoints([], [
    '"1. 100%全实木打造，进口白桦木0贴皮',
    '2. 三面围合护栏，翻滚不出安全区',
    '3. 云朵护盾床围A类面料，磕碰不疼亲肤',
    '4. 第四条不会入选',
  ]);
  assert.deepEqual(points, ['100%全实木打造，进口', '三面围合护栏，翻滚不出安', '云朵护盾床围A类面料，磕']);

  const fallback = selectSellingPoints([cue('保温 12 小时', 0), cue('一键开盖', 1_000_000)]);
  assert.deepEqual(fallback, ['保温 12 小时', '一键开盖']);
}

// 5) subtitle 取卖点库第 4 条（与 point1-3 错开）
{
  const vars = buildPackagingVars({
    subtitleCues: [],
    project: { sellingPoints: ['1. 甲', '2. 乙', '3. 丙', '4. 第四条卖点作副标题'] },
  });
  assert.equal(vars.subtitle, '第四条卖点作副标题');
  const empty = buildPackagingVars({ subtitleCues: [], project: { sellingPoints: ['1. 甲'] } });
  assert.equal(empty.subtitle, '');
}

// 6) accent 透传与覆盖层
{
  const vars = buildPackagingVars({
    subtitleCues: [cue('卖点甲', 0)],
    accents: ['#FF3D7F', '#FFE135'],
    overrides: { title: '  手工标题  ', point1: '' },
  });
  assert.equal(vars.accent1, '#FF3D7F');
  assert.equal(vars.accent2, '#FFE135');
  assert.equal(vars.accent3, '');
  assert.equal(vars.title, '手工标题');
  assert.equal(vars.point1, '');
}

// 7) 极端空输入不抛异常
{
  const vars = buildPackagingVars({ subtitleCues: [] });
  assert.equal(vars.title, '');
  assert.equal(vars.subtitle, '');
  assert.equal(vars.point1, '');
}

// 8) packagingJson 配置解析（final_edit_groups.packagingJson）
{
  // 空值/脏值回退默认（未启用 + 默认模板 + 空覆盖层）
  const empty = parsePackagingConfig(undefined);
  assert.equal(empty.enabled, false);
  assert.equal(empty.template, 'overlay-poster');
  assert.deepEqual(empty.varsOverrides, {});

  const nullish = parsePackagingConfig(null);
  assert.equal(nullish.enabled, false);

  // 正常解析：v2 模板 + 白名单覆盖层
  const config = parsePackagingConfig({
    enabled: true,
    template: 'overlay-variety',
    varsOverrides: { title: '全实木餐边柜', point1: '', badge: 'VM1T-B' },
  });
  assert.equal(config.enabled, true);
  assert.equal(config.template, 'overlay-variety');
  assert.equal(config.varsOverrides.title, '全实木餐边柜');
  assert.equal(config.varsOverrides.point1, '');
  assert.equal('badge' in config.varsOverrides, false, 'v1 遗留键必须被白名单过滤');

  // 非法模板回退默认；非字符串覆盖值被忽略
  const fallback = parsePackagingConfig({ enabled: true, template: 'overlay-basic', varsOverrides: { title: 123 } });
  assert.equal(fallback.template, 'overlay-poster');
  assert.deepEqual(fallback.varsOverrides, {});

  // SQLite 原始字符串输入（load() 的真实路径）：必须先 JSON.parse 再解析
  const fromDb = parsePackagingConfig('{"enabled":true,"template":"overlay-journal","varsOverrides":{"point1":"0贴皮"}}');
  assert.equal(fromDb.enabled, true, '字符串输入的 enabled 必须生效');
  assert.equal(fromDb.template, 'overlay-journal');
  assert.equal(fromDb.varsOverrides.point1, '0贴皮');
  // 脏字符串 / 空字符串回退默认
  assert.equal(parsePackagingConfig('not json{').enabled, false);
  assert.equal(parsePackagingConfig('{}').enabled, false);
}

// 9) §7 数据模型扩展：layouts 解析/钳制/脏数据剔除、pointCues 无 id 回填（幂等）、pointCuesEdited
{
  // layouts：合法解析 + 数值钳制 + 脏键逐层剔除
  const cfg = parsePackagingConfig({
    enabled: true,
    layouts: {
      'overlay-poster': {
        cover: { point1: { x: 12, y: 68, scale: 1.1 }, point9: { x: 1, y: 1, scale: 1 }, title: { x: 8, y: 12, scale: 1.3, rotate: -6 }, subtitle: { x: 20, y: 24, scale: 1 } },
        cues: { p_abc12345: { x: 130, y: -5, scale: 9 }, 'bad id': { x: 1, y: 1, scale: 1 }, p_bad: { x: 'x', y: 1, scale: 1 } },
      },
      'bad template!': { cover: { point1: { x: 1, y: 1, scale: 1 } } },
      'overlay-empty': {},
      'overlay-journal': 42,
    },
  });
  const poster = cfg.layouts?.['overlay-poster'];
  assert.ok(poster, '合法模板键应保留');
  assert.deepEqual(poster.cover, { point1: { x: 12, y: 68, scale: 1.1 }, title: { x: 8, y: 12, scale: 1.3, rotate: -6 }, subtitle: { x: 20, y: 24, scale: 1 } }, 'cover 收 point1-3 + title/subtitle（§18），非法键 point9 剔除');
  assert.deepEqual(poster.cues, { p_abc12345: { x: 100, y: 0, scale: 3 } }, '数值钳制 x/y 0-100、scale 0.3-3；脏项剔除');
  assert.equal('bad template!' in (cfg.layouts ?? {}), false, '非法模板 id 剔除');
  assert.equal('overlay-empty' in (cfg.layouts ?? {}), false, '空壳模板键不保留');
  assert.equal('overlay-journal' in (cfg.layouts ?? {}), false, '非对象模板值剔除');
  // 无 layouts 字段 → 缺省（{} 语义，不占 JSON）
  assert.equal('layouts' in parsePackagingConfig({ enabled: true }), false);
  // layouts 整体脏数据 → 忽略不抛错
  assert.equal('layouts' in parsePackagingConfig({ enabled: true, layouts: 'garbage' }), false);

  // pointCues 无 id 回填：p_ 前缀 + 确定性幂等（两次 parse 同结果）
  const legacy = '{"enabled":true,"pointCues":[{"text":"全实木","startSec":1.2,"endSec":2.6}]}';
  const first = parsePackagingConfig(legacy);
  const second = parsePackagingConfig(legacy);
  assert.ok(first.pointCues![0].id.startsWith('p_'), `缺 id 必须回填 p_ 前缀 id，实际 ${first.pointCues![0].id}`);
  assert.equal(first.pointCues![0].id, second.pointCues![0].id, '回填必须确定性幂等');
  // 回填结果再 parse（写库后重读）id 保持不变
  const reparsed = parsePackagingConfig(JSON.stringify(first));
  assert.equal(reparsed.pointCues![0].id, first.pointCues![0].id, '回填 id 重读必须保持');
  // 已有 id 原样保留
  const withId = parsePackagingConfig({ enabled: true, pointCues: [{ id: 'p_keepme99', text: '静音', startSec: 1, endSec: 2 }] });
  assert.equal(withId.pointCues![0].id, 'p_keepme99', '已有 id 必须保留');

  // pointCuesEdited：布尔解析，缺省 false（缺字段）
  assert.equal(parsePackagingConfig({ enabled: true, pointCuesEdited: true }).pointCuesEdited, true);
  assert.equal('pointCuesEdited' in parsePackagingConfig({ enabled: true }), false);
  assert.equal('pointCuesEdited' in parsePackagingConfig({ enabled: true, pointCuesEdited: 'yes' }), false, '非布尔脏数据忽略');
}

// 10) §6 layouts 写入合并：段级并入、叶子 null=删除该键、空对象清模板、'__clear' 清全部
{
  const base = {
    'overlay-poster': {
      cover: { point1: { x: 12, y: 68, scale: 1.1 }, point2: { x: 10, y: 76, scale: 1 } },
      cues: { p_aaaaaaaa: { x: 30, y: 40, scale: 0.9 }, p_bbbbbbbb: { x: 50, y: 50, scale: 1 } },
    },
    'overlay-journal': { cover: { point3: { x: 5, y: 5, scale: 1 } } },
  };
  // 段级合并：写 cover 不丢 cues，写 cues 不丢 cover；同键覆盖、异键保留
  const merged = mergePackagingLayouts(base, { 'overlay-poster': { cover: { point1: { x: 20, y: 30, scale: 1 } } } });
  assert.deepEqual(merged['overlay-poster'].cover, { point1: { x: 20, y: 30, scale: 1 }, point2: { x: 10, y: 76, scale: 1 } }, 'cover 段级合并：同键覆盖、异键保留');
  assert.deepEqual(merged['overlay-poster'].cues, base['overlay-poster'].cues, '未传的 cues 段保留现状');
  assert.deepEqual(merged['overlay-journal'], base['overlay-journal'], '未传的模板键保留现状');
  // 叶子 null = 删除该键（单条复位），同段其余键与其他段不动
  const deleted = mergePackagingLayouts(base, { 'overlay-poster': { cover: { point1: null }, cues: { p_aaaaaaaa: null } } });
  assert.deepEqual(deleted['overlay-poster'].cover, { point2: { x: 10, y: 76, scale: 1 } }, 'cover 叶子 null 删除该键');
  assert.deepEqual(deleted['overlay-poster'].cues, { p_bbbbbbbb: { x: 50, y: 50, scale: 1 } }, 'cues 叶子 null 删除该键');
  // 段删空后不占键；两段皆空则模板键移除
  const emptied = mergePackagingLayouts({ 'overlay-poster': { cover: { point1: { x: 1, y: 1, scale: 1 } } } }, { 'overlay-poster': { cover: { point1: null } } });
  assert.equal('overlay-poster' in emptied, false, '段删空后模板键移除');
  // 空对象 = 清空该模板（恢复默认版式）；'__clear' 清空全部；脏数据不动现状
  assert.deepEqual(mergePackagingLayouts(base, { 'overlay-poster': {} }), { 'overlay-journal': base['overlay-journal'] }, '空对象清该模板');
  assert.deepEqual(mergePackagingLayouts(base, '__clear'), {}, '__clear 清全部');
  assert.deepEqual(mergePackagingLayouts(base, 'garbage'), base, '整体脏数据不动现状');
  // 叶子数值清洗（钳制）与脏叶子忽略
  const clamped = mergePackagingLayouts({}, { 'overlay-poster': { cues: { p_cccccccc: { x: 130, y: -5, scale: 9 } } } });
  assert.deepEqual(clamped['overlay-poster'].cues, { p_cccccccc: { x: 100, y: 0, scale: 3 } }, '写入合并同样走数值钳制');
  // §18 title/subtitle 键：合并写入保留既有卖点键；叶子 null 单条复位（↺ 回环）不殃及其他键
  const withTitle = mergePackagingLayouts(base, { 'overlay-poster': { cover: { title: { x: 40, y: 10, scale: 1.2, rotate: -8 }, subtitle: { x: 45, y: 18, scale: 1 } } } });
  assert.deepEqual(withTitle['overlay-poster'].cover, {
    point1: { x: 12, y: 68, scale: 1.1 }, point2: { x: 10, y: 76, scale: 1 },
    title: { x: 40, y: 10, scale: 1.2, rotate: -8 }, subtitle: { x: 45, y: 18, scale: 1 },
  }, 'title/subtitle 段级合并，既有 point 键保留');
  const resetTitle = mergePackagingLayouts(withTitle, { 'overlay-poster': { cover: { title: null } } });
  assert.deepEqual(resetTitle['overlay-poster'].cover, {
    point1: { x: 12, y: 68, scale: 1.1 }, point2: { x: 10, y: 76, scale: 1 }, subtitle: { x: 45, y: 18, scale: 1 },
  }, 'title 叶子 null 删除（↺ 复位回环），subtitle/point 不动');
  // 脏 title 叶子（缺字段/超界）走同一清洗管线
  const dirtyTitle = mergePackagingLayouts({}, { 'overlay-poster': { cover: { title: { x: 250, y: 8, scale: 9 } } } });
  assert.deepEqual(dirtyTitle['overlay-poster'].cover, { title: { x: 100, y: 8, scale: 3 } }, 'title 叶子同样数值钳制');
}

// 11) §7 layouts v2：rotate 可选字段——合法保留、超界钳制（取最近边界）、非法仅丢字段、0 与缺省等价不存储
{
  const cfg = parsePackagingConfig({
    enabled: true,
    layouts: {
      'overlay-poster': {
        cover: {
          point1: { x: 30, y: 60, scale: 1.2, rotate: -15 }, // 合法保留
          point2: { x: 50, y: 50, scale: 1, rotate: 250 },   // 正向超界钳到 180
          point3: { x: 50, y: 60, scale: 1, rotate: 'x' },   // 非法仅丢 rotate 字段
        },
        cues: {
          p_rot00001: { x: 50, y: 50, scale: 1, rotate: 0 },    // 0 与缺省等价：不存储
          p_rot00002: { x: 40, y: 40, scale: 1, rotate: -250 }, // 负向超界钳到 -180
          p_rot00003: { x: 60, y: 60, scale: 1 },               // 缺省不存储（旧 {x,y,scale} 数据兼容）
        },
      },
    },
  });
  const poster = cfg.layouts!['overlay-poster'];
  assert.equal(poster.cover!.point1.rotate, -15, 'rotate 合法值必须保留');
  assert.equal(poster.cover!.point2.rotate, 180, 'rotate 正向超界必须钳到 180');
  assert.equal(poster.cues!.p_rot00002.rotate, -180, 'rotate 负向超界必须钳到 -180');
  assert.deepEqual(poster.cover!.point3, { x: 50, y: 60, scale: 1 }, 'rotate 非法值仅丢弃该字段，x/y/scale 整条保留');
  assert.deepEqual(poster.cues!.p_rot00001, { x: 50, y: 50, scale: 1 }, 'rotate=0 与缺省等价，不存储');
  assert.deepEqual(poster.cues!.p_rot00003, { x: 60, y: 60, scale: 1 }, '缺省 rotate 不存储（旧 {x,y,scale} 数据兼容）');

  // merge：rotate 随叶子正常写入/覆盖；写入同样走钳制；叶子 null 删键；非法仅丢字段
  const merged = mergePackagingLayouts(
    { 'overlay-poster': { cover: { point1: { x: 30, y: 60, scale: 1.2, rotate: -15 } } } },
    { 'overlay-poster': { cover: { point1: { x: 30, y: 60, scale: 1.2, rotate: 25 } }, cues: { p_new00001: { x: 50, y: 50, scale: 1, rotate: 90 } } } },
  );
  assert.equal(merged['overlay-poster'].cover!.point1.rotate, 25, 'merge 同键覆盖 rotate');
  assert.equal(merged['overlay-poster'].cues!.p_new00001.rotate, 90, 'merge 新叶子带 rotate 正常存入');
  const clampedRot = mergePackagingLayouts({}, { 'overlay-poster': { cover: { point1: { x: 10, y: 10, scale: 1, rotate: 999 } } } });
  assert.equal(clampedRot['overlay-poster'].cover!.point1.rotate, 180, 'merge 写入 rotate 同样钳制');
  const deleted = mergePackagingLayouts(merged, { 'overlay-poster': { cues: { p_new00001: null } } });
  assert.equal('p_new00001' in (deleted['overlay-poster'].cues ?? {}), false, '带 rotate 的叶子 null 删键');
  const dirty = mergePackagingLayouts({}, { 'overlay-poster': { cover: { point2: { x: 10, y: 10, scale: 1, rotate: 'bad' } } } });
  assert.deepEqual(dirty['overlay-poster'].cover!.point2, { x: 10, y: 10, scale: 1 }, 'merge 路径 rotate 非法仅丢字段不丢整条');
}

console.log('final-edit-packaging-vars.test.ts: 全部断言通过');
assert.deepEqual(parsePackagingConfig({ enabled: true, pointCues: [], pointCuesEdited: true }).pointCues, [], '清空正片卖点必须保留显式空数组');
