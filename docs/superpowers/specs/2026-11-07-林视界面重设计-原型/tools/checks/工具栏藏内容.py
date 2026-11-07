import sys
from playwright.sync_api import sync_playwright
import pathlib, os
html=sys.argv[1]
JS="""() => [...document.querySelectorAll('#app *')].filter(e => { const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowX) && s.scrollbarWidth === 'none' && e.scrollWidth > e.clientWidth + 1; }).map(e => `${e.className}: 内容 ${e.scrollWidth} / 可见 ${e.clientWidth}`)"""
with sync_playwright() as p:
    b=p.chromium.launch()
    for W,H in [(1288,640),(1366,768),(1536,864)]:
        pg=b.new_context(viewport={'width':W,'height':H},device_scale_factor=1).new_page(); pg.goto(pathlib.Path(html).resolve().as_uri()+'#home'); pg.wait_for_timeout(2000)
        for pre in ["__S.mix.step=2;__go('mix')","__S.bt.step=2;__go('batch')"]:
            pg.evaluate(pre); pg.wait_for_timeout(500); print(W,pre[:22],pg.evaluate(JS))
    b.close()
