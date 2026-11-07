"""逐屏找被切掉一截的按钮、输入框、标签（不算能滚动看到的）。用法：overflow7.py <html> <宽> <高> [light|dark]"""
import sys
from playwright.sync_api import sync_playwright
import pathlib, os
html, W, H = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
theme = sys.argv[4] if len(sys.argv) > 4 else 'light'
ENG = sys.argv[5] if len(sys.argv) > 5 else 'chromium'
JS = r"""() => {
  const W = innerWidth, out = [];
  if (document.documentElement.scrollWidth > W + 1) out.push('整页横向多出 ' + (document.documentElement.scrollWidth - W) + 'px');
  const clipAnc = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(hidden|clip|auto|scroll)/.test(s.overflowX)) return [p, s.overflowX]; } return [null, '']; };
  document.querySelectorAll('#app button, #app input, #app label, #app .tag').forEach(el => {
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return;
    if (getComputedStyle(el).visibility === 'hidden') return;
    const [p, ov] = clipAnc(el); if (ov === 'auto' || ov === 'scroll') return;
    const pr = p ? p.getBoundingClientRect() : { left:0, right:W }, L = Math.max(0, pr.left), R = Math.min(W, pr.right);
    const partly = (r.right > R + 1.5 && r.left < R - 2) || (r.left < L - 1.5 && r.right > L + 2);
    if (partly) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} 「${(el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 14)}」 [${r.left | 0}–${r.right | 0}] 可见 [${L | 0}–${R | 0}]`);
  });
  return [...new Set(out)].slice(0, 10);
}"""
STATES = [
    ('home', ''), ('new', ''), ('scene', ''), ('step2', ''), ('step3', ''), ('step4', ''),
    ('mix', '__S.mix.step=0'), ('mix', '__S.mix.step=1'), ('mix', '__S.mix.step=2'),
    ('mix', "__S.mix.step=2;__S.mix.ed.sel={kind:'clip',i:2};__S.trim={scope:'mix',i:2,inPt:.3}"),
    ('mix', "__S.trim=null;__S.mix.step=3;__S.mix.exp.state='done'"), ('mix', '__S.mix.pv=true'),
    ('batch', "__S.mix.pv=false;__S.mix.step=2;__S.bt.step=0"), ('batch', '__S.bt.step=1'), ('batch', "__S.bt.step=2;__S.bt.tab='pack'"),
    ('batch', "__S.bt.tab='sub'"), ('batch', "__S.bt.tab='audio'"), ('batch', "__S.bt.tab='cover'"),
    ('batch', "__S.bt.clip=2;__S.bt.tab='clip';__S.trim={scope:'bt',i:2,inPt:.3}"),
    ('batch', "__S.trim=null;__S.bt.clip=null;__S.bt.step=3"), ('batch', '__S.bt.pv={fi:0,t:1,playing:false}'),
    ('overview', '__S.bt.pv=null'), ('tasks', ''), ('pools', ''),
]
with sync_playwright() as p:
    b = getattr(p, ENG).launch()
    pg = b.new_context(viewport={'width': W, 'height': H}, color_scheme=theme, device_scale_factor=1).new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(pathlib.Path(html).resolve().as_uri() + '#home'); pg.wait_for_timeout(2200)
    pg.evaluate("t=>{__S.theme=t}", theme)
    bad = 0
    for scr, pre in STATES:
        if pre: pg.evaluate(pre)
        pg.evaluate("s=>__go(s)", scr); pg.wait_for_timeout(450)
        r = pg.evaluate(JS)
        if r:
            bad += 1; print(f'[{scr} {pre[:40]}]'); [print('   ', x) for x in r]
    print(f'{W}x{H} {theme}: {len(STATES)} 个状态，{bad} 个有问题；页面报错 {errs[:3]}')
    b.close()
