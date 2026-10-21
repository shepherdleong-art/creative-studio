import type { FilmContent } from './content.ts';
import { filmContent } from './content.ts';
import type { RenderSpec } from '../../film-render/types.ts';
import type { FinalEditPackagingConfig } from '../../media-core/packaging-vars.ts';
import { PACKAGING_TEMPLATE_IDS, type PackagingTemplateId } from '../../media-core/packaging-vars.ts';
import { FinalEditError } from '../errors.ts';
import type { SubtitleCue, VideoTimeline } from '../types.ts';

// Read the last edited fixed-render snapshot before adopting it into the regular editor.
export function currentFilmContent(spec: RenderSpec, timeline: VideoTimeline): FilmContent {
  return structuredClone(timeline.filmContent ?? filmContent(spec));
}

export function filmSubtitleCues(content: FilmContent): SubtitleCue[] {
  return content.subtitles.map((cue, i) => ({
    id: `line-${i}`, segmentId: `line-${i}`, text: cue.text,
    startUs: Math.round((cue.startFrame - 20) / 24 * 1e6),
    endUs: Math.round((cue.endFrame - 20) / 24 * 1e6),
    textSource: 'manual', timingSource: 'manual',
  }));
}

export function filmPackaging(content: FilmContent): FinalEditPackagingConfig {
  if (content.decoration.template === 'classic') return {
    enabled: false, template: 'overlay-minimal', varsOverrides: {},
    pointCues: [], pointCuesMode: 'none', pointCuesEdited: true,
  };
  return { ...structuredClone(content.decoration.packaging), pointCuesEdited: true };
}

/** Explicitly replace legacy decoration; retain its words and shot-relative timing. */
export function classicMixcutPackaging(content: FilmContent, spec: RenderSpec, timeline: VideoTimeline, template: PackagingTemplateId): FinalEditPackagingConfig {
  if (content.decoration.template !== 'classic' || !PACKAGING_TEMPLATE_IDS.includes(template)) {
    throw new FinalEditError('film_template_invalid', '请选择工作台的四套包装预设之一', 400);
  }
  const decoration = content.decoration;
  const pointCues: NonNullable<FinalEditPackagingConfig['pointCues']> = [];
  for (const shot of spec.shots) {
    const clip = timeline.clips.find(item => item.id === shot.id);
    if (!clip) continue;
    const startFrame = clip.timelineInFrame + 20;
    const endFrame = clip.timelineOutFrame + 20;
    const label = decoration.labels[shot.id];
    if (label) pointCues.push({ id: `label-${shot.id}`, text: label.slice(0, 3).filter(Boolean).join(' · ').slice(0, 60), startSec: startFrame / 24, endSec: endFrame / 24 });
    for (const callout of decoration.callouts.filter(item => item.shot === shot.id)) {
      const start = Math.max(startFrame, callout.startFrame + startFrame - shot.startFrame);
      const end = Math.min(endFrame, callout.endFrame + startFrame - shot.startFrame);
      if (end > start) pointCues.push({ id: callout.id, text: [callout.title, callout.sub].filter(Boolean).join(' · ').slice(0, 60), startSec: start / 24, endSec: end / 24 });
    }
  }
  return {
    enabled: true, template,
    varsOverrides: { title: decoration.cover.title[0], subtitle: decoration.cover.title[1], point1: decoration.cover.tag, point2: decoration.cover.note },
    pointCues: pointCues.sort((a, b) => a.startSec - b.startSec), pointCuesMode: pointCues.length ? 'timed' : 'none', pointCuesEdited: true,
  };
}
