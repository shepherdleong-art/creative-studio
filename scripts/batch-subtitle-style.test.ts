import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
  defaultTextStyle,
  normalizeTextStyle,
} from '../lib/media-core/cover-domain.ts';
import { textStyleToSvgElements } from '../lib/media-core/cover-title-svg.ts';
import {
  resolveBatchSubtitleStyle,
  resolveBatchSubtitleStyleSettings,
} from '../lib/batch-production/subtitle-style.ts';

const outputSize = { width: 1080, height: 1440 };

function svgFor(style: ReturnType<typeof defaultTextStyle>, text = '示例字幕'): string {
  return `<svg width="${outputSize.width}" height="${outputSize.height}" viewBox="0 0 ${outputSize.width} ${outputSize.height}" xmlns="http://www.w3.org/2000/svg">${textStyleToSvgElements(style, text, outputSize)}</svg>`;
}

function legacySubtitleSvg(text: string): string {
  // 这是 batch-renderer 原先的默认值，仅用于回归探针，不再作为生产实现。
  const fontSize = Math.max(34, Math.round(outputSize.width * 0.055));
  const baselineY = Math.round(outputSize.height * 0.86);
  const strokeWidth = Math.max(3, Math.round(fontSize * 0.09));
  const escaped = text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  return `<svg width="${outputSize.width}" height="${outputSize.height}" viewBox="0 0 ${outputSize.width} ${outputSize.height}" xmlns="http://www.w3.org/2000/svg"><text x="${Math.round(outputSize.width / 2)}" y="${baselineY}" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${fontSize}" font-weight="600" fill="#ffffff" stroke="#111111" stroke-width="${strokeWidth}" stroke-linejoin="round" paint-order="stroke fill">${escaped}</text></svg>`;
}

async function rawPng(svg: string): Promise<{ data: Buffer; info: { width?: number; height?: number; channels?: number } }> {
  return sharp(Buffer.from(svg)).png().raw().toBuffer({ resolveWithObject: true });
}

try {
  const baseline = defaultTextStyle('subtitle', outputSize.width);
  assert.equal(baseline.fontFamily, 'PingFang SC');
  assert.equal(baseline.fontSizePx, 56);
  assert.equal(baseline.x, 0.5);
  assert.equal(baseline.y, 0.82);
  assert.equal(baseline.stroke.enabled, true);
  assert.equal(baseline.stroke.widthPx, 4);

  const custom = {
    ...baseline,
    fontFamily: 'Noto Sans CJK SC',
    fontSizePx: 72,
    color: '#ffcc00',
    italic: true,
    x: 0.2,
    y: 0.7,
    boxWidthPx: 900,
    stroke: { enabled: false, color: '#000000', widthPx: 0 },
  };
  const subtitleDefaults = {
    subtitleStyles: baseline,
    subtitleStylesByScript: {
      'script-a': custom,
      'broken-entry': { fontSizePx: 'not-a-number' },
      'not-an-object': null,
    },
  };
  const settings = resolveBatchSubtitleStyleSettings(subtitleDefaults, outputSize.width);
  assert.deepEqual(settings.style, baseline, '整批基准样式应保持完整');
  assert.equal(resolveBatchSubtitleStyle(subtitleDefaults, outputSize.width, 'script-a').fontSizePx, 72);
  assert.equal(resolveBatchSubtitleStyle(subtitleDefaults, outputSize.width, 'missing').fontSizePx, 56);
  assert.equal(settings.stylesByScript['broken-entry']?.fontSizePx, 56, '非法字段必须回落基准值');
  assert.equal('not-an-object' in settings.stylesByScript, false, '非法覆盖条目必须忽略');

  const oldDefaults = resolveBatchSubtitleStyleSettings({}, outputSize.width).style;
  assert.deepEqual(oldDefaults, baseline, '旧批次缺省 defaultsJson 必须得到安全默认值');
  const malformed = normalizeTextStyle({ fontSizePx: -10, x: 99, y: Number.NaN, stroke: null }, baseline);
  assert.equal(malformed.fontSizePx, 8, '字号仍需落在安全下限');
  assert.equal(malformed.x, 1, '位置必须 clamp 到输出范围');
  assert.equal(malformed.y, baseline.y, 'NaN 必须回落默认位置');
  assert.equal(malformed.stroke.enabled, baseline.stroke.enabled, '非法描边对象必须回落默认值');
  const nonDefaultFallback = { ...baseline, italic: true, align: 'right' as const };
  const partialStyle = normalizeTextStyle({ fontSizePx: 64 }, nonDefaultFallback);
  assert.equal(partialStyle.italic, true, '缺失 italic 必须回落传入基准而不是强制 false');
  assert.equal(partialStyle.align, 'right', '缺失 align 必须回落传入基准而不是强制居中');

  const rendered = await rawPng(svgFor(baseline, '<字幕> & 颜色'));
  assert.deepEqual(
    { width: rendered.info.width, height: rendered.info.height },
    outputSize,
    '字幕 SVG 必须按真实输出尺寸栅格化',
  );
  const svg = svgFor(custom, 'A < B');
  assert.match(svg, /font-style="italic"/);
  assert.match(svg, /fill="#ffcc00"/);
  assert.match(svg, /A &lt; B/);
  assert.doesNotMatch(svg, /WebkitTextStroke/i, '预览不得退回 CSS 描边');

  const legacy = await rawPng(legacySubtitleSvg('示例字幕'));
  const current = await rawPng(svgFor(baseline));
  assert.deepEqual(
    { width: legacy.info.width, height: legacy.info.height, channels: legacy.info.channels },
    { width: current.info.width, height: current.info.height, channels: current.info.channels },
    '新默认值与旧硬编码必须保持相同输出画布契约',
  );
  const channels = current.info.channels ?? 0;
  assert.ok(channels > 0 && legacy.data.length === current.data.length);
  let changedBytes = 0;
  let totalDelta = 0;
  for (let index = 0; index < current.data.length; index += 1) {
    const delta = Math.abs(current.data[index]! - legacy.data[index]!);
    if (delta > 8) changedBytes += 1;
    totalDelta += delta;
  }
  const changedRatio = changedBytes / current.data.length;
  const meanDelta = totalDelta / current.data.length;
  assert.ok(changedRatio < 0.08, `默认字幕视觉变化应局限于文字区域, changedRatio=${changedRatio.toFixed(4)}`);
  assert.ok(meanDelta < 8, `默认字幕视觉变化平均像素差应在阈值内, meanDelta=${meanDelta.toFixed(3)}`);

  console.log('batch-subtitle-style tests passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
