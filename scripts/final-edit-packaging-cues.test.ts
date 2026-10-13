// 包装 v3 动态时序：卖点提取 + 对时（lib/final-edit/packaging-cues.ts）单元测试
// 运行：node scripts/final-edit-packaging-cues.test.ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  alignPointToCues, alignPointToWords, buildPointCues, computeNarrationContentKey, computePointCuesKey,
  dedupeCandidates, distributeEvenCues, ensurePackagingPointCues, extractHeuristicPoints, normalizeForMatch,
  parseStoredWordTimings, postProcessTimedCues, type CueLike, type WordTiming,
} from '../lib/final-edit/packaging-cues.ts';
import { parsePackagingConfig } from '../lib/final-edit/packaging-vars.ts';
import { FINAL_EDIT_INTRO_DURATION_US } from '../lib/media-core/render-contract.ts';

const COVER_SEC = FINAL_EDIT_INTRO_DURATION_US / 1e6;

// 1) 口播内容哈希：确定性；内容变化即失效
{
  const a = computeNarrationContentKey('这款餐边柜是100%全实木，没有贴皮');
  const b = computeNarrationContentKey('这款餐边柜是100%全实木，没有贴皮');
  const c = computeNarrationContentKey('这款餐边柜是100%全实木');
  assert.equal(a, b, '相同内容哈希一致');
  assert.notEqual(a, c, '内容变化哈希变化');
  assert.equal(a.length, 24, '哈希取 24 位');
  assert.equal(computeNarrationContentKey(''), computeNarrationContentKey('  '), '空内容归一');
}

// 2) 规范化：去空白/标点、全半角统一
{
  assert.equal(normalizeForMatch('100%全实木 · 0贴皮！'), '100%全实木0贴皮');
  assert.equal(normalizeForMatch('环保清漆，开箱无异味'), '环保清漆开箱无异味');
  assert.equal(normalizeForMatch('abc ABC'), 'ABCABC');
}

// 3) 词级对齐：跨词窗口命中，返回精确秒
{
  const words: WordTiming[] = [
    { text: '这款', startUs: 0, endUs: 300_000 },
    { text: '餐边柜', startUs: 300_000, endUs: 800_000 },
    { text: '是', startUs: 800_000, endUs: 950_000 },
    { text: '100%', startUs: 950_000, endUs: 1_500_000 },
    { text: '全实木', startUs: 1_500_000, endUs: 2_000_000 },
    { text: '没有', startUs: 2_000_000, endUs: 2_300_000 },
    { text: '贴皮', startUs: 2_300_000, endUs: 2_700_000 },
  ];
  // 跨「全实木」+「没有」+「贴皮」三词
  const hit = alignPointToWords('全实木没有贴皮', words);
  assert.ok(hit, '词级对齐应命中');
  assert.equal(hit!.startSec, 1.5, `起点应为 100% 词的开始 1.5s，实际 ${hit!.startSec}`);
  assert.equal(hit!.endSec, 2.7, '终点应为贴皮词结束 2.7s');
  // 未出现短语不命中
  assert.equal(alignPointToWords('完全不存在的卖点', words), null);
  assert.equal(alignPointToWords('', words), null);
}

// 4) 句级对齐：字幕互为包含即命中
{
  const cues: CueLike[] = [
    { text: '这款餐边柜是100%全实木', startUs: 0, endUs: 2_000_000 },
    { text: '环保清漆开箱无异味', startUs: 2_500_000, endUs: 4_000_000 },
  ];
  const hit = alignPointToCues('100%全实木', cues);
  assert.ok(hit);
  assert.equal(hit!.startSec, 0);
  assert.equal(hit!.endSec, 2.0);
  assert.equal(alignPointToCues('没讲过的话', cues), null);
}

// 5) 候选池去重 + 裁剪
{
  const pool = dedupeCandidates(['1. 100%全实木打造进口白桦木餐边柜真的很长很长', '1. 100%全实木打造进口白桦木餐边柜真的很长很长', '2. 环保清漆']);
  assert.deepEqual(pool, ['100%全实木打造进口白桦木餐边柜真', '环保清漆'], '完全相同条目去重 + 截 18 字');
}

// 5b) 候选分句拆分：合并卖点劈开、残片丢弃（2026-10-09「拼进下一句」修复）
{
  assert.deepEqual(
    dedupeCandidates(['一键调节躺卧角度，7D云感绒丝棉软弹不塌']),
    ['一键调节躺卧角度', '7D云感绒丝棉软弹不塌'],
    '两个分句合并的候选应劈成两条独立卖点',
  );
  assert.deepEqual(
    dedupeCandidates(['北美FAS级红橡木餐边柜，全']),
    ['北美FAS级红橡木餐边柜'],
    '规范化不足 4 字的残片（全/嵌入 等）应丢弃，只留主句',
  );
  // 全链路：劈开后的分句各自对齐到自己那句口播的时刻
  const splitBuilt = await buildPointCues({
    narrationText: '一键调节躺卧角度。7D云感绒丝棉软弹不塌。',
    words: [],
    subtitleCues: [
      { text: '一键调节躺卧角度', startUs: 1_000_000, endUs: 2_200_000 },
      { text: '7D云感绒丝棉软弹不塌', startUs: 4_000_000, endUs: 5_200_000 },
    ],
    sellingPoints: ['一键调节躺卧角度，7D云感绒丝棉软弹不塌'],
    totalSec: COVER_SEC + 8,
    coverSec: COVER_SEC,
    narrationPlaybackRate: 1,
  });
  assert.equal(splitBuilt.pointCues.length, 2, `劈开后应 2 条，实际 ${splitBuilt.pointCues.length}`);
  assert.equal(splitBuilt.pointCues[0].text, '一键调节躺卧角度');
  assert.equal(splitBuilt.pointCues[1].text, '7D云感绒丝棉软弹不塌');
  assert.ok(Math.abs(splitBuilt.pointCues[0].startSec - (COVER_SEC + 1)) < 0.01, `第一条对齐第一句，实际 ${splitBuilt.pointCues[0].startSec}`);
  assert.ok(Math.abs(splitBuilt.pointCues[1].startSec - (COVER_SEC + 4)) < 0.01, `第二条对齐第二句，实际 ${splitBuilt.pointCues[1].startSec}`);
}

// 6) 启发式兜底：含数字/材质/功效关键词的句子
{
  const points = extractHeuristicPoints('今天给大家分享一款全实木餐边柜。它环保清漆没有异味。承重很强很耐用。喜欢记得点赞。');
  assert.ok(points.length >= 2, `应至少提取 2 条，实际 ${points.length}: ${JSON.stringify(points)}`);
  assert.ok(points.some((p) => p.includes('实木')), '应含实木材质句');
  const none = extractHeuristicPoints('今天天气不错，大家周末愉快');
  assert.deepEqual(none, [], '无关键词不提取');
}

// 7) 无口播均分：卖点按时长均分，最小展示 1.2s
{
  const cues = distributeEvenCues(['甲', '乙', '丙'], 0.83, 10);
  assert.equal(cues.length, 3);
  assert.ok(cues[0].startSec >= 0.83);
  assert.ok(cues[0].endSec - cues[0].startSec >= 1.2, `最小展示 1.2s，实际 ${(cues[0].endSec - cues[0].startSec).toFixed(2)}s`);
  assert.ok(cues[2].endSec <= 10, '不超出总时长');
}

// 8) timed 后处理：最小展示 1.2s、相邻间隔 0.6s、钳制到区间
{
  const raw = [
    { text: '甲', startSec: 1.0, endSec: 1.6 },
    { text: '乙', startSec: 1.7, endSec: 2.1 },
    { text: '丙', startSec: 3.0, endSec: 3.4 },
  ];
  const out = postProcessTimedCues(raw, 0.83, 8);
  assert.equal(out.length, 3);
  assert.ok(out[0].startSec >= 0.83);
  assert.ok(out[0].endSec - out[0].startSec >= 1.2, '最小展示 1.2s');
  assert.ok(out[1].startSec >= out[0].endSec + 0.6 - 1e-9, `相邻间隔 0.6s，实际 ${out[1].startSec - out[0].endSec}`);
}

// 9) buildPointCues 三级回退 + 模式判定
{
  // 9a) 有卖点库 + 有词级时间戳 → timed 模式（§9：对齐结果换算为成片秒 = coverSec + 口播秒/倍速）
  const words: WordTiming[] = [
    { text: '全实木', startUs: 1_000_000, endUs: 2_000_000 },
    { text: '餐边柜', startUs: 2_000_000, endUs: 3_000_000 },
    { text: '环保', startUs: 3_500_000, endUs: 4_000_000 },
    { text: '清漆', startUs: 4_000_000, endUs: 4_500_000 },
  ];
  const timed = await buildPointCues({
    narrationText: '全实木餐边柜，环保清漆',
    words,
    subtitleCues: [],
    sellingPoints: ['1. 全实木餐边柜', '2. 环保清漆'],
    totalSec: 10,
    coverSec: 0.83,
    narrationPlaybackRate: 1,
  });
  assert.equal(timed.mode, 'timed');
  assert.ok(timed.pointCues.length >= 2, `应至少 2 条，实际 ${timed.pointCues.length}`);
  assert.equal(timed.pointCues[0].text, '全实木餐边柜');
  assert.ok(Math.abs(timed.pointCues[0].startSec - 1.83) < 1e-9, `成片起点=coverSec+1.0=1.83s，实际 ${timed.pointCues[0].startSec}`);

  // 9b) 有卖点库但无词级/字幕 → even 均分
  const even = await buildPointCues({
    narrationText: '',
    words: [],
    subtitleCues: [],
    sellingPoints: ['甲', '乙', '丙'],
    totalSec: 12,
    coverSec: 0.83,
    narrationPlaybackRate: 1,
  });
  assert.equal(even.mode, 'even');
  assert.equal(even.pointCues.length, 3);

  // 9c) 无任何卖点候选 → none（仅封面）
  const none = await buildPointCues({
    narrationText: '随便说说没有关键词',
    words: [],
    subtitleCues: [],
    sellingPoints: [],
    totalSec: 10,
    coverSec: 0.83,
    narrationPlaybackRate: 1,
  });
  assert.equal(none.mode, 'none');
  assert.equal(none.pointCues.length, 0);

  // 9d) 有卖点库但全没对齐 + 有口播 → even 兜底（不静默丢卖点）
  const misaligned = await buildPointCues({
    narrationText: '这段口播和卖点完全对不上号',
    words: [{ text: '这段', startUs: 0, endUs: 1_000_000 }, { text: '口播', startUs: 1_000_000, endUs: 2_000_000 }],
    subtitleCues: [],
    sellingPoints: ['完全不搭的卖点甲'],
    totalSec: 10,
    coverSec: 0.83,
    narrationPlaybackRate: 1,
  });
  assert.equal(misaligned.mode, 'even');
  assert.equal(misaligned.pointCues.length, 1);
}

// 10) 词级时间戳解析：对象（v1）与历史裸数组兼容
{
  const obj = parseStoredWordTimings(JSON.stringify({ version: 1, words: [{ text: '甲', startUs: 0, endUs: 1000000 }] }));
  assert.equal(obj.words.length, 1);
  const arr = parseStoredWordTimings('[{"text":"乙","startUs":0,"endUs":2000000}]');
  assert.equal(arr.words.length, 1);
  assert.equal(arr.words[0].text, '乙');
  assert.deepEqual(parseStoredWordTimings('garbage').words, []);
  // 微秒级时间戳（Whisper 秒→微秒）不丢精度
  const us = parseStoredWordTimings({ version: 1, words: [{ text: '丙', startUs: 123456, endUs: 789012 }] });
  assert.equal(us.words[0].startUs, 123456);
}

// 11) packagingJson 解析 v3 新字段（pointCues / pointCuesKey / pointCuesMode）
{
  const cfg = parsePackagingConfig('{"enabled":true,"template":"overlay-poster","pointCues":[{"text":"全实木","startSec":1.2,"endSec":2.6}],"pointCuesKey":"abc123","pointCuesMode":"timed"}');
  assert.equal(cfg.pointCues!.length, 1);
  assert.equal(cfg.pointCues![0].text, '全实木');
  assert.equal(cfg.pointCues![0].startSec, 1.2);
  assert.equal(cfg.pointCuesKey, 'abc123');
  assert.equal(cfg.pointCuesMode, 'timed');
  // 脏 pointCues 忽略
  const dirty = parsePackagingConfig('{"enabled":true,"pointCues":"not-array","pointCuesMode":"weird"}');
  assert.equal('pointCues' in dirty, false);
  assert.equal(dirty.pointCuesMode, 'timed');
}

// 12) §9 时间基准修正：timed 对齐结果统一换算为成片秒（coverSec + 口播秒/倍速）
{
  const words: WordTiming[] = [
    { text: '全实木', startUs: 1_000_000, endUs: 2_000_000 },
    { text: '餐边柜', startUs: 2_000_000, endUs: 2_600_000 },
  ];
  // 倍速 1.0：成片秒 = coverSec + 口播秒
  const rate1 = await buildPointCues({
    narrationText: '全实木餐边柜',
    words,
    subtitleCues: [],
    sellingPoints: ['全实木餐边柜'],
    totalSec: 12,
    coverSec: 0.833,
    narrationPlaybackRate: 1,
  });
  assert.equal(rate1.mode, 'timed');
  assert.ok(Math.abs(rate1.pointCues[0].startSec - (0.833 + 1.0)) < 1e-9, `倍速 1.0 起点=coverSec+1.0，实际 ${rate1.pointCues[0].startSec}`);
  assert.ok(Math.abs(rate1.pointCues[0].endSec - (0.833 + 2.6)) < 1e-9, `倍速 1.0 终点=coverSec+2.6，实际 ${rate1.pointCues[0].endSec}`);
  // 倍速 1.2：成片秒 = coverSec + 口播秒/1.2
  const rate12 = await buildPointCues({
    narrationText: '全实木餐边柜',
    words,
    subtitleCues: [],
    sellingPoints: ['全实木餐边柜'],
    totalSec: 12,
    coverSec: 0.833,
    narrationPlaybackRate: 1.2,
  });
  assert.ok(Math.abs(rate12.pointCues[0].startSec - (0.833 + 1.0 / 1.2)) < 1e-9, `倍速 1.2 起点=coverSec+1.0/1.2，实际 ${rate12.pointCues[0].startSec}`);
  assert.ok(Math.abs(rate12.pointCues[0].endSec - (0.833 + 2.6 / 1.2)) < 1e-9, `倍速 1.2 终点=coverSec+2.6/1.2，实际 ${rate12.pointCues[0].endSec}`);
}

// 13) pointCuesKey 版本盐：带前缀使存量裸 key/旧版本 key 失配（触发一次自动重提取）
{
  const text = '这款餐边柜是100%全实木';
  const bare = computeNarrationContentKey(text);
  const salted = computePointCuesKey(text);
  assert.equal(salted, `v3:${bare}`, 'v3 key = v3: 前缀 + 裸哈希（v3=候选分句拆分口径）');
  assert.notEqual(salted, bare, '同内容带盐 key 必须区别于旧裸 key');
  assert.notEqual(salted, `v2:${bare}`, 'v3 必须与 v2 失配（触发存量重提取）');
}

// 14) ensurePackagingPointCues：倍速换算 + totalSec 除倍速 + 重提取保留旧 id + 新增字段不丢
{
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, sellingPointsJson TEXT);
    CREATE TABLE final_edit_groups (
      id TEXT PRIMARY KEY, projectId TEXT, editedNarrationText TEXT, scriptSnapshotJson TEXT,
      wordTimingsJson TEXT, subtitleStateJson TEXT, narrationDurationUs INTEGER,
      packagingJson TEXT, analysisProviderId TEXT, narrationConfigJson TEXT
    );
  `);
  const narration = '全实木餐边柜，静音收纳';
  db.prepare(`INSERT INTO projects (id, sellingPointsJson) VALUES ('p1', ?)`).run(JSON.stringify([{ title: '1. 全实木餐边柜' }, { title: '2. 静音收纳' }]));
  const oldPackaging = {
    enabled: true,
    template: 'overlay-poster',
    pointCues: [{ id: 'p_keepme01', text: '全实木餐边柜！', startSec: 9, endSec: 10 }],
    pointCuesKey: 'legacy-bare-hash',
    pointCuesMode: 'timed',
    layouts: { 'overlay-poster': { cover: { point1: { x: 10, y: 20, scale: 1.1 } }, cues: { p_keepme01: { x: 30, y: 40, scale: 0.9 } } } },
  };
  db.prepare(`INSERT INTO final_edit_groups (id, projectId, editedNarrationText, scriptSnapshotJson, wordTimingsJson, subtitleStateJson, narrationDurationUs, packagingJson, analysisProviderId, narrationConfigJson) VALUES ('g1', 'p1', ?, NULL, ?, NULL, ?, ?, NULL, ?)`).run(
    narration,
    JSON.stringify({
      words: [
        { text: '全实木', startUs: 1_000_000, endUs: 2_000_000 },
        { text: '餐边柜', startUs: 2_000_000, endUs: 2_600_000 },
        { text: '静音', startUs: 10_800_000, endUs: 11_500_000 },
        { text: '收纳', startUs: 11_500_000, endUs: 12_000_000 },
      ],
    }),
    12_000_000,
    JSON.stringify(oldPackaging),
    JSON.stringify({ playbackRate: 1.2 }),
  );
  const ensured = await ensurePackagingPointCues(db, 'g1');
  // 版本盐：旧裸 key 失配 → 重提取并写入 v2 key
  assert.equal(ensured.pointCuesKey, computePointCuesKey(narration));
  assert.equal(ensured.mode, 'timed');
  assert.equal(ensured.pointCues.length, 2, `应提取 2 条，实际 ${ensured.pointCues.length}`);
  // 重提取按规范化文本匹配保留旧 id（保住 layouts.cues 引用）
  assert.equal(ensured.pointCues[0].text, '全实木餐边柜');
  assert.equal(ensured.pointCues[0].id, 'p_keepme01', '文本匹配的旧 cue 必须保留旧 id');
  assert.ok(/^p_[0-9a-f]{8}$/.test(ensured.pointCues[1].id), `新 cue 生成 p_+8 位 id，实际 ${ensured.pointCues[1].id}`);
  // 倍速 1.2 换算：成片秒 = coverSec + 口播秒/1.2
  assert.ok(Math.abs(ensured.pointCues[0].startSec - (COVER_SEC + 1.0 / 1.2)) < 1e-6, `首条起点换算错误，实际 ${ensured.pointCues[0].startSec}`);
  // totalSec = coverSec + 12s/1.2 = coverSec+10：末条被钳到 totalSec（未除倍速时钳不到该值）
  assert.ok(Math.abs(ensured.pointCues[1].endSec - (COVER_SEC + 10)) < 1e-6, `末条终点应钳到 totalSec=coverSec+10，实际 ${ensured.pointCues[1].endSec}`);
  // 写库：layouts / pointCuesKey / pointCuesMode 保留且正确
  const stored = JSON.parse((db.prepare(`SELECT packagingJson FROM final_edit_groups WHERE id='g1'`).get() as { packagingJson: string }).packagingJson) as Record<string, unknown>;
  assert.equal(stored.pointCuesKey, computePointCuesKey(narration));
  assert.deepEqual(stored.layouts, oldPackaging.layouts, 'persistPointCues 重写必须保留 layouts');
  assert.equal((stored.pointCues as Array<{ id: string }>)[0].id, 'p_keepme01');
  // 幂等：key 匹配后零改动复用
  const again = await ensurePackagingPointCues(db, 'g1');
  assert.deepEqual(again.pointCues, ensured.pointCues, 'key 匹配后必须零写入复用');
  // §7 编辑保护：pointCuesEdited=true 后口播哈希变化不再自动重提取
  db.prepare(`UPDATE final_edit_groups SET editedNarrationText=?, packagingJson=? WHERE id='g1'`).run(
    '完全不同的新口播内容',
    JSON.stringify({ ...stored, pointCuesEdited: true }),
  );
  const guarded = await ensurePackagingPointCues(db, 'g1');
  assert.equal(guarded.pointCues.length, 2, '编辑保护期内不得按新口播重提取');
  assert.equal(guarded.pointCues[0].id, 'p_keepme01');
  db.close();
}

console.log('final-edit-packaging-cues.test.ts: 全部断言通过');

// Comma-joined batch subtitles must classify each clause, never truncate the whole narration's intro.
assert.deepEqual(extractHeuristicPoints('我妈真的从头夸到尾，她说我挑的床，像凭空多出一块收纳地，原木，胡桃木两色可选'), ['像凭空多出一块收纳地', '原木', '胡桃木两色可选']);
