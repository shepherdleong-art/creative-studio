// packaging-palette.ts 单元测试：与 package-video.mjs §11 同算法的关键路径回归。
// 运行：node scripts/final-edit-packaging-palette.test.ts
// 夹具全部用 sharp 现场生成纯色/分区图，确定性、不依赖外部素材。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { extractPackagingPalette, resolveTemplateHueMode } from '../lib/final-edit/packaging-palette.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'packaging-palette-'));

async function makeSolidPng(r: number, g: number, b: number, file = `solid-${r}-${g}-${b}.png`): Promise<string> {
  const abs = path.join(tmp, file);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).png().toFile(abs);
  return abs;
}

// 纯暖橙 RGB(200,120,40)：h≈30° s≈0.67。
// 按 §11 公式手算期望：深版 hsl(30, 0.5, 0.38)=#916130；浅版 hsl(30, 0.15, 0.88) 混白 50%=#F2F0ED。
{
  const img = await makeSolidPng(200, 120, 40);
  const palette = await extractPackagingPalette(img, 'warm');
  assert.equal(palette.d, '#916130');
  assert.equal(palette.l, '#F2F0ED');
}

// 纯蓝 RGB(0,80,200)：warm 模式无暖色候选 → 兜底；any 模式出蓝系深浅对。
// 蓝 h≈216° s=1.0：深版 hsl(216, 0.5, 0.38)=#305791；浅版 hsl(216, 0.15, 0.88) 混白 50%=#EDEFF2。
{
  const img = await makeSolidPng(0, 80, 200);
  const warm = await extractPackagingPalette(img, 'warm');
  assert.deepEqual(warm, { d: '#6B4A3A', l: '#F5EDE0' });
  const any = await extractPackagingPalette(img, 'any');
  assert.equal(any.d, '#305791');
  assert.equal(any.l, '#EDEFF2');
}

// any 模式暖色平局优先（85% 阈值）：
// 蓝(0,80,200,s=1.0) + 橙(200,120,40,s≈0.67) 分区拼接，score=占比×饱和度。
// 50/50：蓝 0.5 > 橙 0.333 < 0.5×0.85=0.425 → 不换，仍出蓝系；
// 42/58：蓝 0.422 居首但橙 0.385 ≥ 0.422×0.85=0.359 → 换暖，出橙系（同纯橙期望）。
async function makeSplitPng(blueCols: number, file: string): Promise<string> {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(width * height * 3);
  for (let p = 0; p < width * height; p += 1) {
    const isBlue = p % width < blueCols;
    raw[p * 3] = isBlue ? 0 : 200;
    raw[p * 3 + 1] = isBlue ? 80 : 120;
    raw[p * 3 + 2] = isBlue ? 200 : 40;
  }
  const abs = path.join(tmp, file);
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(abs);
  return abs;
}
{
  const half = await extractPackagingPalette(await makeSplitPng(32, 'split-50-50.png'), 'any');
  assert.equal(half.d, '#305791');
  assert.equal(half.l, '#EDEFF2');
  const warmWin = await extractPackagingPalette(await makeSplitPng(27, 'split-42-58.png'), 'any');
  assert.equal(warmWin.d, '#916130');
  assert.equal(warmWin.l, '#F2F0ED');
}

// resolveTemplateHueMode：palette.json {"hue":"any"} → any；缺失/脏数据/其他值 → warm。
{
  const anyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-any-'));
  fs.writeFileSync(path.join(anyDir, 'palette.json'), '{"hue":"any"}', 'utf-8');
  assert.equal(resolveTemplateHueMode(anyDir), 'any');
  const warmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-warm-'));
  assert.equal(resolveTemplateHueMode(warmDir), 'warm');
  fs.writeFileSync(path.join(warmDir, 'palette.json'), '{"hue":"warm"}', 'utf-8');
  assert.equal(resolveTemplateHueMode(warmDir), 'warm');
  fs.writeFileSync(path.join(warmDir, 'palette.json'), 'not-json', 'utf-8');
  assert.equal(resolveTemplateHueMode(warmDir), 'warm');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('final-edit-packaging-palette.test.ts: all assertions passed');
