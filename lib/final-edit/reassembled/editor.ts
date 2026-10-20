import type { FilmContent } from './content.ts';
import { filmContent } from './content.ts';
import type { RenderSpec } from '../../film-render/types.ts';
import type { FinalEditPackagingConfig } from '../../media-core/packaging-vars.ts';
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
