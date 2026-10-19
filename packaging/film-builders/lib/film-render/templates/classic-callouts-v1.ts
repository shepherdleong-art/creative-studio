import type { Callout, ClassicComposition, Point } from '../types.ts';
import { requireInput } from '../errors.ts';
import { htmlEscape as esc, pyFloat as f, pyNumber as n } from '../python-format.ts';

// Frozen from scripts/reassembled-film/callouts.py. Keep CSS whitespace byte-exact.
const CSS = `
@font-face{font-family:RFCallout;src:url('assets/fonts/SourceHanSansCN-VF.ttf') format('truetype');font-weight:100 900;font-display:block}
.rf-callout-content{position:absolute;inset:0;pointer-events:none;color:var(--rf-callout-ink,#fff8ed)}
.rf-callout-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.rf-callout-line{stroke:currentColor;stroke-width:2;fill:none}
.rf-callout-dot{fill:currentColor}
.rf-callout-ring{fill:none;stroke:currentColor;stroke-width:2}
.rf-callout-pill{position:absolute;box-sizing:border-box;padding:20px 24px;border-radius:16px;
background:var(--rf-callout-bg,rgba(47,35,24,.72));font-family:var(--rf-callout-font,RFCallout,sans-serif)}
.rf-callout-title{font-size:36px;font-weight:650;line-height:1.25;overflow-wrap:anywhere}
.rf-callout-sub{margin-top:10px;font-size:25px;line-height:1.35;opacity:.85;overflow-wrap:anywhere}
`;

const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (v: unknown, w: number, h: number): v is Point => Array.isArray(v) && v.length === 2 &&
  v.every(number) && v[0] >= 20 && v[0] <= w - 20 && v[1] >= 20 && v[1] <= h - 20;

export function validateClassicCallouts(spec: Pick<ClassicComposition, 'shots' | 'canvas'>, items: unknown): asserts items is Callout[] {
  requireInput(Array.isArray(items), 'INVALID_CALLOUT', 'callouts must be an array');
  const shots = new Map(spec.shots.map(s => [s.id, s]));
  const seen = new Set<string>();
  const { width, height } = spec.canvas;
  for (const c of items) {
    requireInput(c && typeof c === 'object', 'INVALID_CALLOUT', 'Invalid callout object');
    requireInput(typeof c.id === 'string' && /^[A-Za-z0-9_-]+$/.test(c.id) && !seen.has(c.id),
      'INVALID_CALLOUT', 'Invalid or duplicate callout ID');
    seen.add(c.id);
    const shot = shots.get(c.shot);
    requireInput(shot && Number.isSafeInteger(c.startFrame) && Number.isSafeInteger(c.endFrame) &&
      c.startFrame >= shot.startFrame && c.endFrame <= shot.endFrame && c.endFrame - c.startFrame >= 24,
      'INVALID_CALLOUT', 'Callout must stay inside its shot for at least 24 frames');
    requireInput(typeof c.title === 'string' && c.title.trim() && (c.sub === undefined || typeof c.sub === 'string'),
      'INVALID_CALLOUT', 'Callout title/sub must be plain text');
    requireInput(point(c.dot, width, height) && point(c.pill, width, height),
      'INVALID_CALLOUT', 'Callout dot/pill outside frame safe area');
    const size = c.box === undefined ? [320, 140] : c.box;
    requireInput(Array.isArray(size) && size.length === 2 && size.every(v => number(v) && v > 0) &&
      c.pill[0] + size[0] <= width - 20 && c.pill[1] + size[1] <= height - 20,
      'INVALID_CALLOUT', 'Callout box outside frame safe area');
    const points: Point[] = [c.dot];
    if (c.dotKeyframes !== undefined) {
      const tracks = c.dotKeyframes;
      requireInput(Array.isArray(tracks) && tracks.length >= 2, 'INVALID_CALLOUT', 'Callout tracking needs at least two keyframes');
      let previous = c.startFrame - 1;
      for (const k of tracks) {
        requireInput(k && Number.isSafeInteger(k.frame) && k.frame > previous && k.frame < c.endFrame &&
          k.frame >= c.startFrame && point(k.dot, width, height), 'INVALID_CALLOUT', 'Invalid callout tracking keyframe');
        previous = k.frame;
        points.push(k.dot);
      }
      requireInput(tracks[0].frame === c.startFrame && tracks.at(-1).frame === c.endFrame - 1 &&
        tracks[0].dot.every((v: number, i: number) => v === c.dot[i]),
        'INVALID_CALLOUT', 'Callout tracking must cover start through end-1 and match initial dot');
    }
    const [px, py] = c.pill;
    const [bw, bh] = size;
    requireInput(!points.some(([x, y]) => px <= x && x <= px + bw && py <= y && y <= py + bh),
      'INVALID_CALLOUT', 'Callout dot overlaps its card');
    for (let i = 1; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1];
      let lo = 0, hi = 1;
      for (const [origin, delta, lower, upper] of [[a[0], b[0] - a[0], px, px + bw], [a[1], b[1] - a[1], py, py + bh]]) {
        if (delta === 0) {
          if (!(lower <= origin && origin <= upper)) hi = -1;
        } else {
          const u = (lower - origin) / delta, v = (upper - origin) / delta;
          lo = Math.max(lo, Math.min(u, v)); hi = Math.min(hi, Math.max(u, v));
        }
      }
      requireInput(lo > hi, 'INVALID_CALLOUT', 'Callout tracking crosses its card');
    }
  }
}

function anchor(dot: Point, pill: Point, size: Point, axis: number): string {
  const value = dot[axis] < pill[axis] ? pill[axis] : dot[axis];
  const owner = dot[axis] < pill[axis] ? pill : dot;
  if (value <= pill[axis] + size[axis]) return n(value, owner, axis);
  const sum = pill[axis] + size[axis];
  return /[.e]/.test(n(pill[axis], pill, axis) + n(size[axis], size, axis)) ? f(sum) : String(sum);
}

export function renderClassicCallouts(spec: ClassicComposition): { body: string; animations: string[]; css: string } {
  const items = spec.classic.callouts;
  validateClassicCallouts(spec, items);
  const body: string[] = [], animations: string[] = [];
  for (const c of items) {
    const id = 'rf-callout-' + c.id;
    const start = c.startFrame / spec.canvas.fps, end = c.endFrame / spec.canvas.fps;
    const size = c.box ?? [320, 140];
    const dx = n(c.dot[0], c.dot, 0), dy = n(c.dot[1], c.dot, 1);
    const px = n(c.pill[0], c.pill, 0), py = n(c.pill[1], c.pill, 1);
    const bw = n(size[0], size, 0), bh = n(size[1], size, 1);
    body.push(`<div id="${id}" class="clip overlay" data-start="${f(start)}" data-duration="${f(end-start)}" data-track-index="35" style="position:absolute;inset:0;z-index:45">
<div id="${id}-content" class="rf-callout-content" data-layout-allow-overlap="true">
<svg class="rf-callout-svg" viewBox="0 0 ${spec.canvas.width} ${spec.canvas.height}" data-layout-allow-overlap="true">
<line id="${id}-line" class="rf-callout-line" x1="${dx}" y1="${dy}" x2="${anchor(c.dot, c.pill, size, 0)}" y2="${anchor(c.dot, c.pill, size, 1)}" pathLength="1" stroke-dasharray="1"/>
<circle id="${id}-ring" class="rf-callout-ring" cx="${dx}" cy="${dy}" r="12"/>
<circle id="${id}-dot" class="rf-callout-dot" cx="${dx}" cy="${dy}" r="7"/></svg>
<div id="${id}-pill" class="rf-callout-pill" style="left:${px}px;top:${py}px;width:${bw}px;height:${bh}px" data-layout-allow-overlap="true">
<div class="rf-callout-title">${esc(c.title)}</div>
<div class="rf-callout-sub">${esc(c.sub ?? '')}</div></div></div></div>`);
    animations.push(
      `tl.fromTo("#${id}-content",{opacity:0},{opacity:1,duration:.12}, ${f(start)});`,
      `tl.fromTo("#${id}-line",{strokeDashoffset:1},{strokeDashoffset:0,duration:.3,ease:"power2.out"}, ${f(start+.08)});`,
      `tl.fromTo("#${id}-pill",{opacity:0,y:8},{opacity:1,y:0,duration:.24,ease:"power2.out"}, ${f(start+.18)});`,
      `tl.fromTo("#${id}-ring",{attr:{r:12},opacity:.7},{attr:{r:26},opacity:0,duration:.6,ease:"sine.out"}, ${f(start)});`,
      `tl.to("#${id}-content",{opacity:0,duration:.2}, ${f(end-.2)});`,
    );
    const tracks = c.dotKeyframes ?? [];
    for (let i = 0; i + 1 < tracks.length; i++) {
      const a = tracks[i], b = tracks[i + 1];
      for (const [suffix, kx, ky] of [['line', 'x1', 'y1'], ['dot', 'cx', 'cy'], ['ring', 'cx', 'cy']]) {
        const attrs = (p: Point) => `{"${kx}": ${n(p[0], p, 0)}, "${ky}": ${n(p[1], p, 1)}}`;
        animations.push(`tl.fromTo("#${id}-${suffix}",{attr:${attrs(a.dot)}},{attr:${attrs(b.dot)},duration:${f((b.frame-a.frame)/spec.canvas.fps)},ease:"none",immediateRender:false}, ${f(a.frame/spec.canvas.fps)});`);
      }
    }
  }
  return { body: body.join(''), animations, css: items.length ? CSS : '' };
}
