"""Shot-bound product annotations; coordinates refer to the final output frame."""
import html
import json
import math
import re


CSS = """
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
"""


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def integer(value):
    return type(value) is int


def point(value, width, height):
    return (isinstance(value, list) and len(value) == 2
            and all(number(v) for v in value)
            and 20 <= value[0] <= width - 20 and 20 <= value[1] <= height - 20)


def validate_callouts(timeline):
    """Legacy timelines may omit callouts; invalid supplied annotations fail closed."""
    items = timeline.get('callouts', [])
    if not isinstance(items, list):
        raise ValueError('callouts must be an array')
    shots = {s['id']: s for s in timeline['shots']}
    width, height = timeline['width'], timeline['height']
    seen = set()
    for c in items:
        if not isinstance(c, dict):
            raise ValueError('Invalid callout object')
        ident = c.get('id')
        if not isinstance(ident, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', ident) or ident in seen:
            raise ValueError('Invalid or duplicate callout ID')
        seen.add(ident)
        shot_id = c.get('shot')
        shot = shots.get(shot_id) if isinstance(shot_id, str) else None
        start, end = c.get('startFrame'), c.get('endFrame')
        if (not shot or not integer(start) or not integer(end)
                or start < shot['startFrame'] or end > shot['endFrame'] or end - start < 24):
            raise ValueError('Callout must stay inside its shot for at least 24 frames')
        if not isinstance(c.get('title'), str) or not c['title'].strip() or not isinstance(c.get('sub', ''), str):
            raise ValueError('Callout title/sub must be plain text')
        if not point(c.get('dot'), width, height) or not point(c.get('pill'), width, height):
            raise ValueError('Callout dot/pill outside frame safe area')
        size = c.get('box', [320, 140])
        if (not isinstance(size, list) or len(size) != 2 or not all(number(v) and v > 0 for v in size)
                or c['pill'][0] + size[0] > width - 20 or c['pill'][1] + size[1] > height - 20):
            raise ValueError('Callout box outside frame safe area')
        tracks = c.get('dotKeyframes')
        points = [c['dot']]
        if tracks is not None:
            if not isinstance(tracks, list) or len(tracks) < 2:
                raise ValueError('Callout tracking needs at least two keyframes')
            previous = start - 1
            for k in tracks:
                if (not isinstance(k, dict) or not integer(k.get('frame'))
                        or not previous < k['frame'] < end or k['frame'] < start
                        or not point(k.get('dot'), width, height)):
                    raise ValueError('Invalid callout tracking keyframe')
                previous = k['frame']; points.append(k['dot'])
            if (tracks[0]['frame'] != start or tracks[-1]['frame'] != end - 1
                    or tracks[0]['dot'] != c['dot']):
                raise ValueError('Callout tracking must cover start through end-1 and match initial dot')
        px, py = c['pill']; bw, bh = size
        if any(px <= x <= px + bw and py <= y <= py + bh for x, y in points):
            raise ValueError('Callout dot overlaps its card')
        # Linear tracking must not pass through the fixed card between keyframes.
        for a, b in zip(points[1:], points[2:]):
            lo, hi = 0, 1
            for origin, delta, lower, upper in ((a[0], b[0]-a[0], px, px+bw),
                                                 (a[1], b[1]-a[1], py, py+bh)):
                if delta == 0:
                    if not lower <= origin <= upper: hi = -1
                else:
                    u, v = sorted(((lower-origin)/delta, (upper-origin)/delta))
                    lo, hi = max(lo, u), min(hi, v)
            if lo <= hi:
                raise ValueError('Callout tracking crosses its card')
    return items


def render_callouts(timeline):
    items = validate_callouts(timeline)
    body, animations = [], []
    fps = timeline['fps']
    for c in items:
        ident = 'rf-callout-' + c['id']
        start, end = c['startFrame']/fps, c['endFrame']/fps
        dx, dy = c['dot']; px, py = c['pill']; bw, bh = c.get('box', [320, 140])
        # Nearest point on the card boundary; every segment stays connected to the marker.
        ax, ay = min(max(dx, px), px+bw), min(max(dy, py), py+bh)
        body.append(f'''<div id="{ident}" class="clip overlay" data-start="{start}" data-duration="{end-start}" data-track-index="35" style="position:absolute;inset:0;z-index:45">
<div id="{ident}-content" class="rf-callout-content" data-layout-allow-overlap="true">
<svg class="rf-callout-svg" viewBox="0 0 {timeline['width']} {timeline['height']}" data-layout-allow-overlap="true">
<line id="{ident}-line" class="rf-callout-line" x1="{dx}" y1="{dy}" x2="{ax}" y2="{ay}" pathLength="1" stroke-dasharray="1"/>
<circle id="{ident}-ring" class="rf-callout-ring" cx="{dx}" cy="{dy}" r="12"/>
<circle id="{ident}-dot" class="rf-callout-dot" cx="{dx}" cy="{dy}" r="7"/></svg>
<div id="{ident}-pill" class="rf-callout-pill" style="left:{px}px;top:{py}px;width:{bw}px;height:{bh}px" data-layout-allow-overlap="true">
<div class="rf-callout-title">{html.escape(c['title'])}</div>
<div class="rf-callout-sub">{html.escape(c.get('sub',''))}</div></div></div></div>''')
        animations.extend([
            f'tl.fromTo("#{ident}-content",{{opacity:0}},{{opacity:1,duration:.12}}, {start});',
            f'tl.fromTo("#{ident}-line",{{strokeDashoffset:1}},{{strokeDashoffset:0,duration:.3,ease:"power2.out"}}, {start+.08});',
            f'tl.fromTo("#{ident}-pill",{{opacity:0,y:8}},{{opacity:1,y:0,duration:.24,ease:"power2.out"}}, {start+.18});',
            f'tl.fromTo("#{ident}-ring",{{attr:{{r:12}},opacity:.7}},{{attr:{{r:26}},opacity:0,duration:.6,ease:"sine.out"}}, {start});',
            f'tl.to("#{ident}-content",{{opacity:0,duration:.2}}, {end-.2});',
        ])
        tracks = c.get('dotKeyframes', [])
        for a, b in zip(tracks, tracks[1:]):
            for suffix, keys in [('line', ('x1', 'y1')), ('dot', ('cx', 'cy')), ('ring', ('cx', 'cy'))]:
                initial = json.dumps(dict(zip(keys, a['dot'])))
                target = json.dumps(dict(zip(keys, b['dot'])))
                animations.append(f'tl.fromTo("#{ident}-{suffix}",{{attr:{initial}}},'
                                  f'{{attr:{target},duration:{(b["frame"]-a["frame"])/fps},ease:"none",immediateRender:false}}, {a["frame"]/fps});')
    return ''.join(body), animations, CSS if items else ''
