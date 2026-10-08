"""Render SOP timeline and pre-rasterized text. No network or paid requests.
python scripts/reassembled-film-render.py PROJECT --ffmpeg PATH --ffprobe PATH
"""
import argparse, json, re, subprocess, wave
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('project',type=Path)
parser.add_argument('--ffmpeg',required=True)
parser.add_argument('--ffprobe',required=True)
a=parser.parse_args();p=a.project.resolve()
t=json.loads((p/'tools/timeline.json').read_text(encoding='utf8'))
w,h,fps=t['width'],t['height'],t['fps']
duration=t['frames']/fps
assert duration>=15,'Final shorter than 15 seconds'
assert len({s['file'] for s in t['shots']})==len(t['shots']),'Repeated clip'
r=p/'tools/render';r.mkdir(exist_ok=True)
def run(args):
    result=subprocess.run([a.ffmpeg,'-nostdin','-hide_banner','-y',*map(str,args)],capture_output=True,encoding='utf8',errors='replace')
    if result.returncode: raise RuntimeError(result.stderr[-4500:])
    return result.stderr
def encode_video(inputs,filter,frames,output):
    run([*inputs,'-vf',filter,'-an','-frames:v',frames,'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-threads','2',output])
def probe(file):
    v=subprocess.run([a.ffprobe,'-v','error','-show_entries','stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration:format=duration','-of','json',str(file)],capture_output=True,encoding='utf8',check=True)
    return json.loads(v.stdout)
parts=[]
base=f'scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={fps}'
cover=r/'00.mp4'
encode_video(['-loop','1','-framerate',fps,'-i',p/t['coverImage']],base,t['introFrames'],cover)
parts.append(cover)
cursor=t['introFrames']
for i,s in enumerate(t['shots'],1):
    assert s['startFrame']==cursor,'Timeline gap/overlap'
    frames=s['endFrame']-s['startFrame']; cursor=s['endFrame']
    source=p/s['file'];meta=probe(source)
    assert s['inSec']+frames/fps*s.get('rate',1)<=float(meta['format']['duration'])+.05,'Clip too short'
    out=r/f'{i:02}.mp4'
    encode_video(['-ss',s['inSec'],'-i',source],f"setpts=(PTS-STARTPTS)/{s.get('rate',1)},{base}",frames,out)
    parts.append(out)
    print('trimmed',s['id'],frames,flush=True)
assert cursor==t['frames']
(r/'concat.txt').write_text('\n'.join(f"file '{f.name}'" for f in parts),encoding='utf8')
run(['-f','concat','-safe','0','-i',r/'concat.txt','-c','copy',r/'picture.mp4'])
# Stitch non-overlapping PCM speech at exact sample offsets. The tested FFmpeg
# build truncates a multi-input atrim/adelay/amix graph at the first delay.
sample_rate=48000
voice_pcm=bytearray(round(duration*sample_rate)*2)
previous_end=0
for v in t['voices']:
    with wave.open(str(p/v['file']), 'rb') as audio:
        assert (audio.getframerate(),audio.getnchannels(),audio.getsampwidth())==(sample_rate,1,2),'Voice must be 48kHz mono PCM16 WAV'
        start=round(v['trimStart']*sample_rate);end=round(v['trimEnd']*sample_rate)
        assert 0<=start<end<=audio.getnframes(),'Invalid voice trim'
        audio.setpos(start);samples=audio.readframes(end-start)
    offset=round(v['atFrame']/fps*sample_rate)*2
    assert previous_end<=offset and offset+len(samples)<=len(voice_pcm),'Voice overlap or overflow'
    voice_pcm[offset:offset+len(samples)]=samples
    previous_end=offset+len(samples)
with wave.open(str(r/'narration.wav'),'wb') as audio:
    audio.setparams((1,2,sample_rate,0,'NONE','not compressed'))
    audio.writeframes(voice_pcm)
filters=[
    '[0:a]asplit=2[vo][duck]',
    f'[1:a]aresample=48000,volume=-14dB,atrim=duration={duration},afade=t=in:d=0.35,afade=t=out:st={duration-1}:d=1[bgm]',
    '[bgm][duck]sidechaincompress=threshold=0.025:ratio=8:attack=15:release=250[music]',
    '[vo][music]amix=inputs=2:normalize=0[mix]',
]
run(['-i',r/'narration.wav','-stream_loop','-1','-i',p/t['music'],'-filter_complex',';'.join(filters),'-map','[mix]','-t',duration,'-c:a','pcm_s16le',r/'premix.wav'])
assert abs(float(probe(r/'premix.wav')['format']['duration'])-duration)<.02,'Truncated premix'
log=run(['-i',r/'premix.wav','-af','loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-f','null','-'])
stats=json.loads(re.findall(r'\{[^{}]+"input_i"[^{}]+\}',log)[-1])
norm=f"loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:offset={stats['target_offset']}:linear=true:print_format=json"
run(['-i',r/'premix.wav','-af',norm,'-ar','48000','-c:a','pcm_s16le',r/'final.wav'])
final=p/'final';final.mkdir(exist_ok=True)
name=t['basename'];index=2
while (final/f'{name}.mp4').exists() or (final/f'{name}-封面.jpg').exists():
    name=f"{t['basename']}-{index:02}";index+=1
output=final/f'{name}.mp4'
run(['-i',r/'picture.mp4','-framerate',fps,'-i',p/'tools/overlays/%05d.png','-i',r/'final.wav','-filter_complex','[0:v][1:v]overlay=0:0:shortest=1[v]','-map','[v]','-map','2:a','-frames:v',t['frames'],'-t',duration,'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','192k','-movflags','+faststart',output])
run(['-i',p/'tools/cover.png','-frames:v','1','-q:v','2',final/f'{name}-封面.jpg'])
meta=probe(output)
video=next(s for s in meta['streams'] if s['codec_type']=='video')
assert (video['width'],video['height'])==(w,h)
assert video['r_frame_rate']==f'{fps}/1'
assert abs(float(meta['format']['duration'])-duration)<.08
audio=next(s for s in meta['streams'] if s['codec_type']=='audio')
assert abs(float(audio['duration'])-duration)<.08,'Truncated final audio'
(p/'review/render-result.json').write_text(json.dumps({'output':str(output),'probe':meta,'loudnormPass1':stats},ensure_ascii=False,indent=2),encoding='utf8')
print('rendered',output,flush=True)
