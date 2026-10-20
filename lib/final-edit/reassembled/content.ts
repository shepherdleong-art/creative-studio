import type { ClassicConfig, FilmAudio, RenderSpec, Subtitle } from '../../film-render/types.ts';
import { isClassicSpec } from '../../film-render/types.ts';
import type { OverlayRenderSpec } from '../../film-render/types.ts';
import { FinalEditError } from '../errors.ts';

/** Editable values only. File identities and render/runtime settings never come from this payload. */
export interface FilmContent {
  subtitles: Subtitle[];
  music: Pick<FilmAudio['music'], 'inSec' | 'gainDb' | 'fadeInSec' | 'fadeOutSec'>;
  decoration: { template: 'classic'; cover: Omit<ClassicConfig['cover'], 'image'>; labels: ClassicConfig['labels']; callouts: ClassicConfig['callouts']; outro: ClassicConfig['outro'] }
    | { template: OverlayRenderSpec['template']['id']; packaging: OverlayRenderSpec['packaging'] };
}

export function filmContent(spec: RenderSpec): FilmContent {
  const { inSec, gainDb, fadeInSec, fadeOutSec } = spec.audio.music;
  let decoration: FilmContent['decoration'];
  if (isClassicSpec(spec)) {
    const { image: _image, ...cover } = spec.classic.cover;
    void _image;
    decoration = { template: 'classic', cover, labels: spec.classic.labels, callouts: spec.classic.callouts, outro: spec.classic.outro };
  } else decoration = { template: spec.template.id, packaging: spec.packaging };
  return structuredClone({ subtitles: spec.subtitles, music: { inSec, gainDb, fadeInSec, fadeOutSec }, decoration });
}

function keys(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) {
    throw new FinalEditError('film_content_invalid', `${label} 含不支持的字段`, 400);
  }
}

/** Full content snapshot, validated again by the fixed renderer after timeline projection. */
export function applyFilmContent(base: RenderSpec, content: FilmContent | undefined): RenderSpec {
  if (content === undefined) return structuredClone(base);
  keys(content, ['subtitles', 'music', 'decoration'], '成片内容');
  if (!Array.isArray(content.subtitles)) throw new FinalEditError('film_content_invalid', '字幕必须为列表', 400);
  for (const subtitle of content.subtitles) keys(subtitle, ['text', 'startFrame', 'endFrame'], '字幕');
  keys(content.music, ['inSec', 'gainDb', 'fadeInSec', 'fadeOutSec'], '音乐');
  if (['inSec', 'gainDb', 'fadeInSec', 'fadeOutSec'].some(k => typeof (content.music as Record<string, unknown>)[k] !== 'number')) throw new FinalEditError('film_content_invalid', '音乐参数必须完整', 400);
  let subtitleEnd = 20;
  for (const cue of content.subtitles) {
    if (cue.startFrame < subtitleEnd) throw new FinalEditError('film_content_invalid', '字幕必须按时间排列且不能重叠', 400);
    subtitleEnd = cue.endFrame;
  }
  const d = content.decoration;
  keys(d, d?.template === 'classic' ? ['template', 'cover', 'labels', 'callouts', 'outro'] : ['template', 'packaging'], '包装');
  const common = structuredClone(base);
  common.subtitles = structuredClone(content.subtitles);
  common.audio.music = { ...common.audio.music, ...content.music };
  if (d.template === 'classic') {
    if (!isClassicSpec(common)) throw new FinalEditError('film_content_invalid', '本工程没有 classic 设计资源，不能凭空切换为 classic', 400);
    keys(d.cover, ['title', 'tag', 'note', 'brand', 'model', 'productName'], '封面');
    keys(d.outro, ['title'], '片尾');
    if (!Array.isArray(d.callouts)) throw new FinalEditError('film_content_invalid', '标注必须为列表', 400);
    for (const callout of d.callouts) {
      keys(callout, ['id', 'shot', 'startFrame', 'endFrame', 'title', 'sub', 'dot', 'pill', 'box', 'dotKeyframes'], '标注');
      if (callout.dotKeyframes) for (const frame of callout.dotKeyframes) keys(frame, ['frame', 'dot'], '标注关键帧');
    }
    common.classic = { ...common.classic, cover: { ...d.cover, image: common.classic.cover.image }, labels: structuredClone(d.labels), callouts: structuredClone(d.callouts), outro: structuredClone(d.outro) };
    return common;
  }
  keys(d.packaging, ['enabled', 'template', 'varsOverrides', 'pointCues', 'pointCuesMode', 'layouts'], '叠层包装');
  if (d.template !== d.packaging.template) throw new FinalEditError('film_content_invalid', '包装模板身份不一致', 400);
  const cover = isClassicSpec(common) ? { image: common.classic.cover.image } : common.cover;
  const { project, canvas, shots, subtitles, audio, output } = common;
  return { schemaVersion: 1, project, canvas, shots, subtitles, audio, output, template: { id: d.template, version: '1' }, cover, packaging: structuredClone(d.packaging) };
}
