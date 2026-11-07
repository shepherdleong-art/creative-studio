"""两个内核、三种窗口，量所有放视频画面的地方：比例对不对、够不够大、有没有超出窗口。"""
import sys
from playwright.sync_api import sync_playwright
import pathlib, os
html=sys.argv[1]
CASES=[
 ('剪辑区预览',"__S.mix.pv=false;__S.mix.ratio='3:4';__S.mix.step=2;__go('mix')",'#cp-frame',3/4),
 ('剪辑区 9:16',"__S.mix.ratio='9:16';__go('mix')",'#cp-frame',9/16),
 ('剪辑区截取中',"__S.mix.ratio='3:4';__S.trim={scope:'mix',i:2,inPt:.3};__go('mix')",'#cp-frame',3/4),
 ('单条导出预览',"__S.trim=null;__S.mix.step=3;__S.mix.exp.state='done';__S.mix.pv=true;__go('mix')",'.pv-film',3/4),
 ('批量审片',"__S.mix.pv=false;__S.mix.step=2;__S.bt.step=2;__S.bt.pv=null;__go('batch')",'#cp-frame',3/4),
 ('批量审片截取中',"__S.bt.clip=2;__S.bt.tab='clip';__S.trim={scope:'bt',i:2,inPt:.3};__go('batch')",'#cp-frame',3/4),
 ('批量导出预览',"__S.trim=null;__S.bt.clip=null;__S.bt.step=3;__S.bt.pv={fi:3,t:1,playing:false};__go('batch')",'.cp-frame.pv',3/4),
]
bad=0
with sync_playwright() as p:
    for eng in ['webkit','chromium']:
        b=getattr(p,eng).launch()
        for W,H in [(1280,640),(1223,760),(1536,864)]:
            pg=b.new_context(viewport={'width':W,'height':H},device_scale_factor=1).new_page(); pg.goto(pathlib.Path(html).resolve().as_uri()+'#home'); pg.wait_for_timeout(1500)
            for name,js,sel,ratio in CASES:
                pg.evaluate(js); pg.wait_for_timeout(350)
                w,h,top,bottom,right=pg.evaluate(f"(()=>{{const r=document.querySelector({sel!r}).getBoundingClientRect();return [r.width,r.height,r.top,r.bottom,r.right]}})()")
                ok = h>0 and abs(w/h-ratio)<.02 and w>=100 and bottom<=H+1 and right<=W+1 and top>=-1
                if not ok: bad+=1
                print(('  ok ' if ok else 'FAIL '),eng,W,H,name,f'{w:.0f}x{h:.0f}', f'比例 {w/h if h else 0:.3f}')
            pg.close()
        b.close()
print('不合格',bad)
