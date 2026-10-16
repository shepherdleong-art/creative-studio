import fs from 'node:fs';
import path from 'node:path';
import { requireInput } from './errors.ts';
import { projectFile } from './files.ts';
import { parsePythonJson, pyNumber } from './python-format.ts';
import { parseRenderSpec } from './spec.ts';
import { array, identifier, numeric, object, string } from './validation.ts';
import type { RenderSpec } from './types.ts';
import { packagingFromProject, type CueAdjustment } from './overlay-from-project.ts';

export function readProjectJson(root: string, file: string): unknown {
  return parsePythonJson(fs.readFileSync(projectFile(root, file), 'utf8'));
}

function deliveryBaseName(root: string, variant: string): string {
  if (!fs.existsSync(path.join(root, 'review/delivery.json'))) return variant;
  const delivery = object(readProjectJson(root, 'review/delivery.json'), 'delivery');
  // Only an explicit variant mapping is evidence. Never infer membership from a filename.
  const variants = delivery.variants ?? delivery.files;
  let entry: unknown;
  if (Array.isArray(variants)) entry = variants.find(v => v && typeof v === 'object' && v.variant === variant);
  else if (variants && typeof variants === 'object') entry = (variants as Record<string, unknown>)[variant];
  requireInput(entry !== undefined, 'DELIVERY_MAPPING_UNKNOWN', 'delivery.json 无明确 variants 片号映射，请传入 baseName');
  const item = object(entry, 'delivery variant');
  const file = string(item.video ?? item.output, 'delivery variant.video/output');
  const name = path.win32.basename(file);
  requireInput(/\.mp4$/i.test(name), 'DELIVERY_MAPPING_UNKNOWN', '交付文件必须是 mp4，或显式传入 baseName');
  return name.slice(0, -4);
}

/** Read-only adapter for the audited RC2C / BS619 variant timelines.
 * Audio and media paths are variant-relative; the returned spec is project-relative.
 */
export function renderSpecFromProject(projectRoot: string, variant: string, options: { baseName?: string; musicInSec?: number; coverFrame?: number; onAdjustment?: (change: CueAdjustment) => void } = {}): RenderSpec {
  identifier(variant, 'variant');
  const root = fs.realpathSync(projectRoot);
  const variantDir = `variants/${variant}`;
  const timeline = object(readProjectJson(root, `${variantDir}/timeline.json`), 'timeline');
  requireInput(timeline.variant === variant, 'VARIANT_MISMATCH', '时间线片号与请求不符');
  const config = object(readProjectJson(root, 'packaging.json'), 'packaging');
  const pack = object(object(config.variants, 'packaging.variants')[variant], 'packaging variant');
  const duration = numeric(timeline.duration, 'timeline.duration');
  const fileAtVariant = (v: unknown) => path.relative(root, projectFile(root, path.resolve(root, variantDir, string(v, 'variant file'))));
  const shots = array(timeline.shots, 'timeline.shots').map(value => {
    const s = object(value, 'shot');
    return { id: s.id, file: fileAtVariant(s.file), startFrame: s.startFrame, endFrame: s.endFrame, inSec: s.inSec, rate: s.rate,
      ...(s.approvedSourceRangeSec === undefined ? {} : { approvedSourceRangeSec: s.approvedSourceRangeSec }) };
  });
  requireInput(timeline.voices !== undefined && timeline.music !== undefined, 'AUDIO_SOURCE_MISSING',
    '时间线缺少 voices/music；需核对现场脚本，不能猜测配音或配乐');
  const overlay = pack.packaging === undefined ? undefined : packagingFromProject(pack.packaging, Number(timeline.frames),
    options.onAdjustment ?? (change => console.error(JSON.stringify({ stage: 'spec', adjustment: change }))));
  const labels = overlay ? {} : Object.fromEntries(Object.entries(object(pack.labels, 'packaging.labels')).map(([id, value]) => [id,
    array(value, `labels.${id}`).map((v, i) => {
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return pyNumber(v, value as object, i);
      if (v === null) return 'None';
      if (typeof v === 'boolean') return v ? 'True' : 'False';
      requireInput(false, 'INVALID_FIELD', 'label 只支持字符串、数值、布尔或 null');
    }),
  ]));
  return parseRenderSpec({
    schemaVersion: 1,
    project: { root, variant, baseName: options.baseName ?? deliveryBaseName(root, variant) },
    canvas: { width: timeline.width, height: timeline.height, fps: timeline.fps, introFrames: timeline.introFrames, frames: timeline.frames },
    template: { id: overlay?.template ?? 'classic', version: '1' },
    shots, subtitles: timeline.subtitles,
    audio: {
      voices: array(timeline.voices, 'voices').map(value => {
        const voice = object(value, 'voice');
        return { ...voice, file: fileAtVariant(voice.file) };
      }),
      music: { file: fileAtVariant(timeline.music), inSec: options.musicInSec ?? 0, gainDb: -14, fadeInSec: .25, fadeOutSec: 1,
        ducking: { threshold: .025, ratio: 8, attackMs: 15, releaseMs: 250 } },
      loudness: { integratedLufs: -16, truePeakDb: -1.6, lra: 11 },
    },
    ...(overlay ? { cover: { image: fileAtVariant(timeline.coverImage) }, packaging: overlay } : { classic: {
      projectCss: 'tools/style.css', designDoc: 'DESIGN.md', theme: timeline.theme,
      durationText: pyNumber(duration, timeline, 'duration'),
      cover: { image: fileAtVariant(timeline.coverImage), title: timeline.title, tag: timeline.tag, note: pack.coverNote,
        brand: config.brand, model: config.model, productName: config.productName },
      labels, callouts: timeline.callouts === undefined ? [] : timeline.callouts, outro: { title: timeline.endtitle },
    } }),
    output: { coverFrame: options.coverFrame ?? 16 },
  });
}
