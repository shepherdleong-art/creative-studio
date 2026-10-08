"""Reusable, previously rendered BS619-A packaging; product text comes from JSON."""
import argparse,json,shutil,html,re
from pathlib import Path
from contract import validate
parser=argparse.ArgumentParser()
parser.add_argument('project',type=Path);parser.add_argument('variant')
parser.add_argument('--assets',type=Path,required=True,help='Font and GSAP asset root (contains assets/fonts and assets/scripts)')
parser.add_argument('--output',type=Path,required=True,help='New composition directory inside the project')
a=parser.parse_args();p=a.project.resolve(strict=True);ident=a.variant
proof=validate(p,ident);t=proof['timeline'];r=p/'variants'/ident;hf=a.output.resolve()
if not hf.is_relative_to(p) or hf.exists():raise ValueError('Use a new output directory inside the project')
config=json.loads((p/'packaging.json').read_text(encoding='utf8'));pack=config['variants'][ident]
for shot in t['shots']:
 if not re.fullmatch(r'[A-Za-z0-9_-]+',shot['id']):raise ValueError('Invalid shot ID')
for key in ['title','endtitle']:t[key]=[html.escape(v) for v in t[key]]
t['tag']=html.escape(t['tag'])
css=(p/'tools/style.css').read_text(encoding='utf8')
# Keep the project DESIGN and exact approved CSS; no hardcoded cross-product fallback.
design=(p/'DESIGN.md').read_text(encoding='utf8')
cover=(r/t['coverImage']).resolve(strict=True)
if not cover.is_relative_to(p):raise ValueError('Cover outside project')
for f in ['assets/fonts/SourceHanSansCN-VF.ttf','assets/scripts/gsap.min.js']:
 if not (a.assets/f).is_file():raise ValueError('Missing font/GSAP asset: '+f)
for d in ['assets/fonts','assets/scripts','media','renders']:(hf/d).mkdir(parents=True,exist_ok=True)
for f in ['assets/fonts/SourceHanSansCN-VF.ttf','assets/scripts/gsap.min.js']:shutil.copy2(a.assets/f,hf/f)
(hf/'DESIGN.md').write_text(design,encoding='utf8');shutil.copy2(cover,hf/'media/cover.png')
(hf/'hyperframes.json').write_text(json.dumps({'media':{'autoProxy':True}}),encoding='utf8')
an=[]
def tween(selector,props,at):an.append(f'tl.from({json.dumps(selector)},{{{props}}},{at:.6f});')
body=f'''<div id="cover" class="clip scene" data-start="0" data-duration="1" data-track-index="0" style="z-index:1"><img src="media/cover.png" alt="{html.escape(config['productName'])}" style="position:absolute;inset:0" data-layout-allow-overlap="true"><div class="scene-content" data-layout-allow-overlap="true"><div class="brandrow" id="cover-brand"><b>{html.escape(config['brand'])}</b><span class="model">{html.escape(config['model'])} / {ident}</span></div><h1 class="cover-title"><span id="cover-line1">{t['title'][0]}</span><span class="accent" id="cover-line2">{t['title'][1]}</span></h1><div class="cover-detail" id="cover-detail"><i class="rule"></i><span>{t['tag']}</span></div><div class="cover-note" id="cover-note"><span>{html.escape(pack['coverNote'])}</span><span>HOME / LIVING</span></div></div></div>'''
# The cover is a complete, static design from frame zero; no GSAP entrance/exit.
body=body.replace('data-duration="1"',f'data-duration="{t["introFrames"]/t["fps"]}"',1)
for i,s in enumerate(t['shots']):
 st=s['startFrame']/24;dur=(s['endFrame']-s['startFrame'])/24;tail=0 if i==len(t['shots'])-1 else 4/24
 body+=f'<video id="scene-{i}" class="clip scene" src="media/{s["id"]}.mp4" data-start="{st}" data-duration="{dur+tail}" data-track-index="{i+1}" muted playsinline data-layout-allow-overlap="true" style="z-index:{i+2}"></video>'
 if i != 0:tween(f'#scene-{i}','opacity:0,filter:"blur(5px)",duration:0.166667,ease:"power2.out"',st)
for i,s in enumerate(t['subtitles']):
 st=s['startFrame']/24;du=(s['endFrame']-s['startFrame'])/24
 body+=f'<div id="cap-{i}" class="clip overlay" data-start="{st}" data-duration="{du}" data-track-index="20" style="z-index:40"><div class="cap" data-layout-allow-overlap="true"><span>{html.escape(s["text"])}</span></div></div>'
 tween(f'#cap-{i} .cap','y:12,opacity:0,duration:.16,ease:"power3.out"',st)
labels=pack['labels']
for i,s in enumerate(t['shots']):
 if s['id'] not in labels:continue
 kicker,title,support,cl=[html.escape(str(v)) for v in labels[s['id']]];st=s['startFrame']/24+.18;en=s['endFrame']/24-.02
 if en-st<.5:continue
 inner=f'<div class="label-content {cl}" data-layout-allow-overlap="true"><div class="kicker" id="l{i}-k"><i class="rule"></i>{kicker}</div><h2 class="headline" id="l{i}-t">{title}</h2>'
 if support:inner+=f'<p class="support" id="l{i}-s">{support}</p>'
 body+=f'<div id="label-{i}" class="clip overlay" data-start="{st}" data-duration="{en-st}" data-track-index="30" style="z-index:30">{inner}</div></div>'
 tween(f'#l{i}-t',('scale:1.06,' if i%2 else 'x:-28,')+'opacity:0,duration:.28,ease:"power4.out"',st)
 tween(f'#l{i}-k','opacity:0,y:-10,duration:.2,ease:"sine.out"',st+.06)
 if support:tween(f'#l{i}-s','opacity:0,y:12,duration:.3,ease:"expo.out"',st+.12)
end=t['shots'][-1]['startFrame']/24
body+=f'''<div id="outro" class="clip overlay" data-start="{end}" data-duration="{t['duration']-end}" data-track-index="30" style="z-index:30"><div class="scene-content" data-layout-allow-overlap="true"><div class="brandrow" id="outro-brand"><b>{html.escape(config['brand'])}</b><span class="model">{html.escape(config['model'])}</span></div><h2 class="end-title"><span id="outro-line1">{t['endtitle'][0]}</span><span class="accent" id="outro-line2">{t['endtitle'][1]}</span></h2><div class="end-model" id="outro-detail"><i class="rule"></i><span>{t['tag']}</span></div></div></div>'''
for sel,props,delta in [('#outro-brand','opacity:0,y:-12,duration:.25,ease:"sine.out"',.12),('#outro-line1','opacity:0,x:-34,duration:.36,ease:"power4.out"',.12),('#outro-line2','opacity:0,y:22,duration:.35,ease:"expo.out"',.24),('#outro-detail','opacity:0,y:10,duration:.25,ease:"power2.out"',.45)]:tween(sel,props,end+delta)
doc=f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><script src="assets/scripts/gsap.min.js"></script><style>{css}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="{t["duration"]}" data-width="1080" data-height="1440" data-fps="24">'+body+'</div><script>const tl=gsap.timeline({paused:true});'+''.join(an)+'window.__timelines=window.__timelines||{};window.__timelines.main=tl;</script></body></html>'
(hf/'index.html').write_text(doc,encoding='utf8');(hf/'meta.json').write_text(json.dumps(dict(id='main',name=config['model']+' '+ident+' '+t['theme']),ensure_ascii=False),encoding='utf8')
print('Built HTML',ident,t['frames'])
