import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot } from '../lib/batch-production/plans.ts';
import { defaultTextStyle } from '../lib/final-edit/domain.ts';
import {
  BATCH_PRESET_TO_COVER_PRESET_ID,
  composeBatchCoverTitle,
  escapeXml,
  loadFrozenCoverTitleConfig,
  resolveBatchCoverTitleSettings,
  textStyleToSvgElements,
} from '../lib/batch-production/cover-title.ts';

// ---------- 比例键映射 ----------

assert.equal(BATCH_PRESET_TO_COVER_PRESET_ID['3:4'], '3x4');
assert.equal(BATCH_PRESET_TO_COVER_PRESET_ID['3x4'], '3x4');
assert.equal(BATCH_PRESET_TO_COVER_PRESET_ID['9:16'], '9x16');
assert.equal(BATCH_PRESET_TO_COVER_PRESET_ID['9x16'], '9x16');
assert.equal(BATCH_PRESET_TO_COVER_PRESET_ID['16:9'], '16x9');
assert.equal(BATCH_PRESET_TO_COVER_PRESET_ID['16x9'], '16x9');

// ---------- resolveBatchCoverTitleSettings:缺省与非法回落 ----------

const emptySettings = { mode: 'none', presetId: null, styles: null, framing: null };
assert.deepEqual(resolveBatchCoverTitleSettings(undefined), emptySettings);
assert.deepEqual(resolveBatchCoverTitleSettings(null), emptySettings);
assert.deepEqual(resolveBatchCoverTitleSettings('not-an-object'), emptySettings);
assert.deepEqual(resolveBatchCoverTitleSettings([]), emptySettings);
assert.deepEqual(resolveBatchCoverTitleSettings({}), emptySettings, '字段完全缺失必须是 mode none');
assert.deepEqual(resolveBatchCoverTitleSettings({ coverTitleMode: 'bogus' }), emptySettings, '非法 mode 必须回落 none');

const resolved = resolveBatchCoverTitleSettings({
  coverTitleMode: 'custom',
  coverTitlePresetId: 42,
  coverTitleStyles: {
    primary: { fontSizePx: 1, x: 2, y: -1, scale: 99, stroke: { enabled: true, widthPx: -3 } },
  },
  coverTitleFraming: { scale: 99, offsetX: -2, offsetY: 0.5 },
});
assert.equal(resolved.mode, 'custom');
assert.equal(resolved.presetId, null, '非字符串 presetId 必须回落 null');
assert.ok(resolved.styles);
assert.equal(resolved.styles.primary.fontSizePx, 8, 'fontSizePx 必须过 normalizeTextStyle 钳制');
assert.equal(resolved.styles.primary.x, 1);
assert.equal(resolved.styles.primary.y, 0);
assert.equal(resolved.styles.primary.scale, 4);
assert.equal(resolved.styles.primary.stroke.widthPx, 0);
assert.deepEqual(resolved.styles.secondary, defaultTextStyle('coverSecondary', 1080), '缺失的副标题样式必须补默认');
assert.deepEqual(resolved.framing, { scale: 3, offsetX: -1, offsetY: 0.5 }, 'framing 必须按 cleanFraming 钳制');
assert.equal(resolveBatchCoverTitleSettings({ coverTitleMode: 'preset', coverTitlePresetId: 'preset-1' }).presetId, 'preset-1');
assert.deepEqual(
  resolveBatchCoverTitleSettings({ coverTitleFraming: 'garbage' }).framing,
  { scale: 1, offsetX: 0, offsetY: 0 },
  '非法 framing 必须按 cleanFraming 语义回落默认',
);
assert.equal(resolveBatchCoverTitleSettings({ coverTitleMode: 'custom', coverTitleStyles: 'garbage' }).styles, null, '非法 styles 必须为 null');

// ---------- textStyleToSvgElements ----------

assert.equal(escapeXml(`a&<b>"c"'`), 'a&amp;&lt;b&gt;&quot;c&quot;&apos;');

const svgStyle = {
  ...defaultTextStyle('coverPrimary', 1080),
  fontFamily: 'PingFang SC',
  fontSizePx: 80,
  italic: true,
  x: 0.5,
  y: 0.2,
  scale: 1,
  color: '#ffffff',
  align: 'right' as const,
  boxWidthPx: 864,
  stroke: { enabled: true, color: '#111111', widthPx: 4 },
  shadow: { enabled: true, color: '#222222', opacity: 0.5, blurPx: 8, distancePx: 10, angleDeg: 90 },
};
const svg = textStyleToSvgElements(svgStyle, '标题&<\'">', { width: 1080, height: 1440 });
assert.equal((svg.match(/<text /gu) ?? []).length, 2, '阴影开启必须是两层 text');
assert.ok(svg.includes('font-family="PingFang SC, PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif"'), 'font-family 必须带通用 fallback 串');
assert.ok(svg.includes('font-size="80"'));
assert.ok(svg.includes('font-style="italic"'));
assert.ok(svg.includes('text-anchor="end"'), 'align right 必须映射 text-anchor end');
assert.ok(svg.includes('stroke="#111111" stroke-width="4"'));
assert.ok(svg.includes('stroke-linejoin="round" paint-order="stroke fill"'));
assert.ok(svg.includes('fill="#222222" fill-opacity="0.5"'), '阴影层必须带偏移色与透明度');
assert.ok(svg.includes('x="540" y="298"'), '阴影层必须按 (distancePx, angleDeg) 极坐标偏移(90° → y+10)');
assert.ok(svg.includes('x="540" y="288"'), '正文层必须锚在 x*width / y*height');
assert.ok(svg.indexOf('#222222') < svg.indexOf('#ffffff'), '阴影层必须在正文层之前');
assert.ok(svg.includes('标题&amp;&lt;&apos;&quot;&gt;</text>'), '文本必须 XML 转义');

const noShadowNoStroke = textStyleToSvgElements(
  { ...svgStyle, italic: false, align: 'center', stroke: { enabled: false, color: '#111111', widthPx: 4 }, shadow: { ...svgStyle.shadow, enabled: false } },
  '居中',
  { width: 1080, height: 1440 },
);
assert.equal((noShadowNoStroke.match(/<text /gu) ?? []).length, 1, '阴影关闭必须只有一层 text');
assert.ok(noShadowNoStroke.includes('text-anchor="middle"'), 'align center 必须映射 text-anchor middle');
assert.ok(!noShadowNoStroke.includes('paint-order'), '描边关闭不得出现 stroke 属性');
assert.ok(!noShadowNoStroke.includes('font-style'), '非斜体不得出现 font-style');
assert.ok(textStyleToSvgElements({ ...svgStyle, align: 'left', shadow: { ...svgStyle.shadow, enabled: false } }, '左', { width: 1080, height: 1440 }).includes('text-anchor="start"'));

// boxWidthPx 收缩:6 个拉丁字符 × 0.55 × 100px = 330 > 100 → 收缩因子钳到下限 0.5 → 50px
const shrinkSvg = textStyleToSvgElements(
  { ...svgStyle, fontSizePx: 100, boxWidthPx: 100, shadow: { ...svgStyle.shadow, enabled: false } },
  'abcdef',
  { width: 1080, height: 1440 },
);
assert.ok(shrinkSvg.includes('font-size="50"'), 'boxWidthPx 超限必须等比缩字号且下限 0.5 倍');
const fitSvg = textStyleToSvgElements(
  { ...svgStyle, shadow: { ...svgStyle.shadow, enabled: false } },
  '你好',
  { width: 1080, height: 1440 },
);
assert.ok(fitSvg.includes('font-size="80"'), '行宽未超限不得缩字号');

// ---------- composeBatchCoverTitle ----------

const composeStyles = { primary: defaultTextStyle('coverPrimary', 1080), secondary: defaultTextStyle('coverSecondary', 1080) };
const base1080x1440 = await sharp({ create: { width: 1080, height: 1440, channels: 3, background: { r: 20, g: 60, b: 120 } } }).jpeg().toBuffer();
const plain = await composeBatchCoverTitle({
  coverImage: base1080x1440, primary: '', secondary: '', styles: composeStyles, framing: null, outputSize: { width: 1080, height: 1440 },
});
const titled = await composeBatchCoverTitle({
  coverImage: base1080x1440, primary: '主标题', secondary: '副标题', styles: composeStyles, framing: null, outputSize: { width: 1080, height: 1440 },
});
const plainMeta = await sharp(plain).metadata();
const titledMeta = await sharp(titled).metadata();
assert.equal(plainMeta.width, 1080);
assert.equal(plainMeta.height, 1440);
assert.equal(titledMeta.width, 1080);
assert.equal(titledMeta.height, 1440);
assert.equal(titledMeta.format, 'jpeg');
assert.ok(!titled.equals(plain), '合成标题后字节必须不同(真的画了东西)');

// 抽帧产物尺寸抖动:非目标尺寸底图也必须规整到 outputSize
const jittered = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 200, g: 100, b: 50 } } }).jpeg().toBuffer();
const resized = await composeBatchCoverTitle({
  coverImage: jittered, primary: '主标题', secondary: '', styles: composeStyles, framing: null, outputSize: { width: 1080, height: 1440 },
});
const resizedMeta = await sharp(resized).metadata();
assert.equal(resizedMeta.width, 1080);
assert.equal(resizedMeta.height, 1440);

// framing scale=2:不报错且尺寸正确,底图取景确实变化
const framed = await composeBatchCoverTitle({
  coverImage: base1080x1440, primary: '主标题', secondary: '', styles: composeStyles, framing: { scale: 2, offsetX: 0, offsetY: 0 }, outputSize: { width: 1080, height: 1440 },
});
const framedMeta = await sharp(framed).metadata();
assert.equal(framedMeta.width, 1080);
assert.equal(framedMeta.height, 1440);
assert.ok(!framed.equals(plain), 'framing 合成必须改变底图字节');

// ---------- loadFrozenCoverTitleConfig(DB) ----------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-cover-title-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '测试项目');`);

try {
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups'), now: () => new Date('2026-08-06T00:00:00.000Z') });
  assert.equal(ready.state, 'ready');

  const frozenStyles = {
    primary: { ...defaultTextStyle('coverPrimary', 1080), color: '#ff0000' },
    secondary: defaultTextStyle('coverSecondary', 1080),
  };
  const batchId = createBatchProduction(db, 'project-1', '封面批次');

  // v1:完整封面设置 + 快照结构化标题 → 解析出合成配置
  const versionId1 = createBatchProductionVersion(db, batchId, {
    copyCount: 1,
    defaultsJson: {
      coverTitleMode: 'preset',
      coverTitlePresetId: 'preset-1',
      coverTitleStyles: frozenStyles,
      coverTitleFraming: { scale: 2, offsetX: 0.5, offsetY: 0 },
    },
  });
  const scriptId1 = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft', sourceId: 'script-1', title: '脚本一', bodyText: '正文一', sourceVersion: 'v1',
    metadata: { coverTitleJson: { primary: '主标题', secondary: '副标题' } },
  });
  const snapshotId1 = snapshotScriptIntoBatch(db, versionId1, { scriptId: scriptId1, copyCount: 1 });
  const [planId1] = createOutputPlansForSnapshot(db, versionId1, snapshotId1);
  const config = loadFrozenCoverTitleConfig(db, planId1);
  assert.ok(config, '冻结版本带封面字段 + 快照标题必须解析出配置');
  assert.equal(config.primary, '主标题');
  assert.equal(config.secondary, '副标题');
  assert.equal(config.styles.primary.color, '#ff0000');
  assert.deepEqual(config.framing, { scale: 2, offsetX: 0.5, offsetY: 0 });

  // v2:defaultsJson 完全缺封面字段 → mode none → null(读取端必须容忍缺省)
  const versionId2 = createBatchProductionVersion(db, batchId, { copyCount: 1, defaultsJson: {} });
  const scriptId2 = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft', sourceId: 'script-2', title: '脚本二', bodyText: '正文二', sourceVersion: 'v1',
    metadata: { coverTitleJson: { primary: '标题' } },
  });
  const snapshotId2 = snapshotScriptIntoBatch(db, versionId2, { scriptId: scriptId2, copyCount: 1 });
  const [planId2] = createOutputPlansForSnapshot(db, versionId2, snapshotId2);
  assert.equal(loadFrozenCoverTitleConfig(db, planId2), null, 'mode none 必须返回 null');

  // v3:有样式但主标题为空 → null
  const versionId3 = createBatchProductionVersion(db, batchId, {
    copyCount: 1,
    defaultsJson: { coverTitleMode: 'custom', coverTitleStyles: frozenStyles },
  });
  const scriptId3 = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft', sourceId: 'script-3', title: '脚本三', bodyText: '正文三', sourceVersion: 'v1',
    metadata: { coverTitleJson: { primary: '   ', secondary: '副标题' } },
  });
  const snapshotId3 = snapshotScriptIntoBatch(db, versionId3, { scriptId: scriptId3, copyCount: 1 });
  const [planId3] = createOutputPlansForSnapshot(db, versionId3, snapshotId3);
  assert.equal(loadFrozenCoverTitleConfig(db, planId3), null, '主标题为空必须返回 null');

  // v4:mode custom 但样式缺失 → null
  const versionId4 = createBatchProductionVersion(db, batchId, {
    copyCount: 1,
    defaultsJson: { coverTitleMode: 'custom' },
  });
  const scriptId4 = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft', sourceId: 'script-4', title: '脚本四', bodyText: '正文四', sourceVersion: 'v1',
    metadata: { coverTitleJson: { primary: '标题' } },
  });
  const snapshotId4 = snapshotScriptIntoBatch(db, versionId4, { scriptId: scriptId4, copyCount: 1 });
  const [planId4] = createOutputPlansForSnapshot(db, versionId4, snapshotId4);
  assert.equal(loadFrozenCoverTitleConfig(db, planId4), null, '样式缺失必须返回 null');

  assert.equal(loadFrozenCoverTitleConfig(db, 'no-such-plan'), null, '未知 plan 必须安全返回 null');

  console.log('batch cover title tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
