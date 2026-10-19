import { isDeepStrictEqual } from 'node:util';
import { postProcessTimedCues } from '../media-core/packaging-cues.ts';
import { sanitizePointCues } from '../media-core/packaging-vars.ts';
import { allowedKeys } from './overlay-spec.ts';
import { requireInput } from './errors.ts';
import { array, integer, object, string } from './validation.ts';

export interface CueAdjustment { id: string; before: unknown; after: unknown; reason: string }

/** Convert explicit frame intervals; no model calls, narration inference or project writes. */
export function packagingFromProject(input: unknown, frames: number, report?: (change: CueAdjustment) => void) {
  const p = object(input, 'variant.packaging');
  allowedKeys(p, ['template', 'title', 'subtitle', 'coverPoints', 'bodyCues', 'layouts'], 'variant.packaging');
  const points = array(p.coverPoints ?? [], 'coverPoints');
  requireInput(points.length <= 3, 'INVALID_PACKAGING', '封面卖点最多 3 条');
  const drafts = array(p.bodyCues ?? [], 'bodyCues').map((value, index) => {
    const cue = object(value, 'bodyCue');
    allowedKeys(cue, ['id', 'text', 'startFrame', 'endFrame'], 'bodyCue');
    const start = integer(cue.startFrame, 'bodyCue.startFrame', 0, frames - 1);
    return { id: cue.id === undefined ? `cue-${index + 1}` : string(cue.id, 'bodyCue.id'), text: string(cue.text, 'bodyCue.text'),
      startSec: start / 24, endSec: integer(cue.endFrame, 'bodyCue.endFrame', start + 1, frames) / 24 };
  }).sort((a, b) => a.startSec - b.startSec);
  const processed = postProcessTimedCues(drafts, 20 / 24, frames / 24);
  const cues = sanitizePointCues(processed.map((cue, index) => ({ id: drafts[index].id, ...cue }))) ?? [];
  drafts.forEach((before, index) => {
    const after = cues[index] ?? null;
    if (!isDeepStrictEqual(before, after)) report?.({ id: before.id, before, after, reason: after ? '共享卖点规则调整了时序或文案' : '共享卖点规则移除了超出片尾或数量限制的条目' });
  });
  return { enabled: true, template: p.template,
    varsOverrides: { title: p.title, subtitle: p.subtitle, ...Object.fromEntries(points.map((value, i) => [`point${i + 1}`, string(value, 'coverPoint')])) },
    pointCues: cues, pointCuesMode: cues.length ? 'timed' : 'none', layouts: p.layouts ?? {} };
}
