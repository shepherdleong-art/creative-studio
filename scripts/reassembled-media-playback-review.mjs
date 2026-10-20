// Local normal-speed playback evidence. No suppliers. Review observations are written separately.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { chromium } from '@playwright/test';
const file=path.resolve(process.env.FILM_REVIEW_MEDIA),out=path.resolve(process.env.FILM_REVIEW_OUTPUT);
assert.ok(out.startsWith(path.resolve('outputs/2026-10-19-real-handoff')+path.sep));
fs.mkdirSync(out,{recursive:true});assert.ok(!fs.existsSync(path.join(out,'playback.json')));
const size=fs.statSync(file).size;
const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<body style="margin:0;background:#222"><video id="v" muted playsinline controls style="height:90vh" src="/media"></video><canvas id="c" hidden></canvas></body>');return;}
  if(req.url!=='/media'){res.writeHead(404);res.end();return;}
  const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),size-1):size-1;
  res.writeHead(range?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
  fs.createReadStream(file,{start,end}).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:path.resolve('packaging/runtime/chrome-headless-shell/chrome-headless-shell.exe'),headless:true});
try{
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>document.querySelector('video').readyState>=2);
  await page.locator('video').evaluate(async v=>{v.playbackRate=1;await v.play();await new Promise(resolve=>v.requestVideoFrameCallback(resolve));});
  const start=Date.now();
  const frames=[];
  while(Date.now()-start<35000){
    const f=await page.evaluate(()=>{const v=document.querySelector('video'),c=document.querySelector('canvas');c.width=432;c.height=Math.round(432*v.videoHeight/v.videoWidth);c.getContext('2d').drawImage(v,0,0,c.width,c.height);return {time:v.currentTime,ended:v.ended,paused:v.paused,rate:v.playbackRate,duration:v.duration,width:v.videoWidth,height:v.videoHeight,data:c.toDataURL('image/jpeg',.9),quality:v.getVideoPlaybackQuality().toJSON?.()||{droppedVideoFrames:v.getVideoPlaybackQuality().droppedVideoFrames,totalVideoFrames:v.getVideoPlaybackQuality().totalVideoFrames}};});
    const name=`frame-${String(frames.length).padStart(3,'0')}.jpg`;fs.writeFileSync(path.join(out,name),Buffer.from(f.data.split(',')[1],'base64'));delete f.data;frames.push({...f,name,wallMs:Date.now()-start});
    if(f.ended)break;await new Promise(r=>setTimeout(r,200));
  }
  assert.ok(frames.at(-1).ended,'Playback must finish normally');assert.ok(frames.every(f=>f.rate===1));
  assert.ok(Math.abs(frames.at(-1).wallMs/1000-frames.at(-1).duration)<2,'Real-time playback stalled');
  const sheets=[];for(let start=0;start<frames.length;start+=16){
    const subset=frames.slice(start,start+16),height=600,layers=[];
    for(let i=0;i<subset.length;i++){
      const f=subset[i],x=(i%4)*432,y=Math.floor(i/4)*height;
      layers.push({input:await sharp(path.join(out,f.name)).resize(432,576,{fit:'contain'}).toBuffer(),left:x,top:y});
      layers.push({input:Buffer.from(`<svg width="432" height="24"><rect width="432" height="24" fill="white"/><text x="8" y="18" font-size="16">${f.time.toFixed(3)} s</text></svg>`),left:x,top:y+576});
    }
    const name=`playback-sheet-${sheets.length+1}.jpg`;await sharp({create:{width:1728,height:Math.ceil(subset.length/4)*height,channels:3,background:'#ffffff'}}).composite(layers).jpeg({quality:92}).toFile(path.join(out,name));sheets.push(name);
  }
  const maxGapSec=Math.max(...frames.slice(1).map((f,i)=>f.time-frames[i].time));
  fs.writeFileSync(path.join(out,'playback.json'),JSON.stringify({ok:maxGapSec<.65,file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),normalSpeed:true,audioMuted:true,maxGapSec,visualReviewPending:true,frames,sheets},null,2));
  assert.ok(maxGapSec<.65,'Capture gap too large for continuous visual review; rerun when the machine is idle');
  console.log(JSON.stringify({ok:true,frames:frames.length,sheets,out,duration:frames.at(-1).duration}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
