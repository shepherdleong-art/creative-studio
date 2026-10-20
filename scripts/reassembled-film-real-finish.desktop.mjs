// Uses the reviewed real rework candidate; all suppliers disabled. Resumes saved local stages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { _electron as electron } from '@playwright/test';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fixture=read(process.env.FILM_REAL_FIXTURE),{root,dataRoot}=fixture;
assert.ok(root.includes('2026-10-19-real-handoff')&&fixture.historicalReuse);
const handoff=read(path.join(root,'handoff-result.json')),manual=read(path.join(root,'manual-edit-result.json'));
const generation=path.join(root,'real-generation'),video=read(path.join(generation,'video-result.json')),review=read(path.join(generation,'video-review.json'));
assert.ok(review.approved&&review.sha256===video.outputSha256&&sha(video.outputPath)===review.sha256);
const evidence=path.join(root,'final-rework');fs.mkdirSync(evidence,{recursive:true});
assert.ok(!fs.existsSync(path.join(evidence,'result.json')),'Completed run must not be replayed');
const db=new Database(path.join(dataRoot,'data/workbench.db'));
db.prepare('UPDATE providers SET enabled=0').run();db.prepare('UPDATE video_providers SET enabled=0').run();
const env={...process.env,CREATIVE_STUDIO_DATA_ROOT:dataRoot,CREATIVE_STUDIO_NODE:process.execPath,CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER:'0',CREATIVE_STUDIO_CANVAS_ENABLE:'0'};
for(const key of ['CREATIVE_STUDIO_STANDALONE_ROOT','CREATIVE_STUDIO_PACKAGING_DIR','CREATIVE_STUDIO_PACKAGING_NODE','CREATIVE_STUDIO_FFMPEG','CREATIVE_STUDIO_FFPROBE'])delete env[key];
const exec=promisify(execFile),cli=async(...args)=>JSON.parse((await exec(process.execPath,['scripts/reassembled-workbench.mjs',...args],{env,windowsHide:true,timeout:300000,maxBuffer:8*1024*1024})).stdout);
const wait=async(fn,timeout=90000)=>{const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,500));}throw new Error('Local stage timed out; resume saved identity');};
const app=await electron.launch({args:[path.resolve('.'),`--user-data-dir=${path.join(evidence,'electron')}`],cwd:path.resolve('.'),env,timeout:60000});
const handle=app.process();let state,result;
try{
  const page=await app.firstWindow();await page.waitForURL(/127\.0\.0\.1/,{timeout:60000});
  state=read(path.join(dataRoot,'storage/run/electron-service.json'));
  const get=async url=>(await page.request.get(state.origin+url)).json();
  const current=()=>cli('current',dataRoot,handoff.groupId);
  const home=`${state.origin}/projects/${handoff.production.projectId}?tab=final-edit&filmGroup=${handoff.groupId}&filmShotSet=${handoff.shotSetId}`;
  const clipId='v01-Q2-D01',initialFile=path.join(evidence,'before.json');
  if(!fs.existsSync(initialFile)){const v=await current();assert.equal(v.revision,1);assert.deepEqual(v.content,manual.content);save(initialFile,v);}
  const before=read(initialFile),old=before.clips.find(c=>c.id===clipId);
  const oldFiles=path.join(evidence,'old-delivery.json');
  if(!fs.existsSync(oldFiles))save(oldFiles,[manual.output.videoFilename,manual.output.coverFilename].map(name=>({name,sha256:sha(path.join(root,'客户交付',name))})));
  const staleFile=path.join(evidence,'stale-proposal.json');
  if(!fs.existsSync(staleFile)){const content=structuredClone(before.content);content.decoration.packaging.varsOverrides.title='过期标题不得覆盖';save(staleFile,{requestId:randomUUID(),expectedRevision:1,summary:'验收：替换镜头前的过期提案',content});}
  const stale=await cli('propose',dataRoot,handoff.groupId,staleFile); // Stable replay after a crash.
  let view=await cli('shot',dataRoot,handoff.groupId,clipId);
  await page.goto(home);await page.getByTestId('film-editor').waitFor({timeout:60000});
  await page.getByLabel('选择镜头',{exact:true}).selectOption(clipId);
  if(!view.registeredVideoIds.includes(video.jobId)){
    await page.getByRole('link',{name:'返工这个镜头',exact:true}).click();await page.getByTestId('film-rework').waitFor();
    await page.getByRole('link',{name:'生成该镜头视频',exact:true}).click();
    await page.getByLabel('返工视频候选',{exact:true}).selectOption(video.jobId);
    await page.getByLabel('已审核起点（秒）',{exact:true}).fill(String(review.approvedRangeSec[0]));
    await page.getByLabel('已审核终点（秒）',{exact:true}).fill(String(review.approvedRangeSec[1]));
    await page.getByRole('button',{name:'登记到第五步候选',exact:true}).click();
    await wait(async()=>(await cli('shot',dataRoot,handoff.groupId,clipId)).registeredVideoIds.includes(video.jobId));
    assert.deepEqual((await current()).clips,before.clips);
    await page.getByRole('link',{name:'返回第五步替换镜头',exact:true}).click();await page.getByTestId('film-editor').waitFor();
  }
  let edited=await current();
  if(edited.revision===1){
    await page.getByLabel('已有候选',{exact:true}).selectOption(video.jobId);
    await page.getByRole('button',{name:'替换镜头',exact:true}).click();
    await page.getByTestId('film-message').filter({hasText:'镜头修改已保存'}).waitFor();
    edited=await current();assert.equal(edited.revision,2);
  }
  assert.ok([2,3].includes(edited.revision));
  const changed=edited.clips.find(c=>c.id===clipId);assert.equal(changed.videoJobId,video.jobId);
  assert.deepEqual(edited.clips.filter(c=>c.id!==clipId),before.clips.filter(c=>c.id!==clipId));
  for(const key of ['timelineInFrame','timelineOutFrame','playbackRate','framing','boundSegmentId'])assert.deepEqual(changed[key],old[key]);
  assert.equal(changed.sourceOutFrame-changed.sourceInFrame,old.sourceOutFrame-old.sourceInFrame);
  if(edited.revision===2)assert.deepEqual(edited.content,before.content);
  await page.reload();await page.getByTestId('film-editor').waitFor();
  const staleRow=page.getByText(/内容提案：验收：替换镜头前的过期提案/).locator('..');
  assert.ok(await staleRow.getByRole('button',{name:'查看并编辑提案',exact:true}).isDisabled());
  // Direct stale human save must also fail, not merely be hidden by UI.
  const rejected=await page.evaluate(async({variantId,proposalId,content})=>{const r=await fetch(`/api/final-edit-variants/${variantId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'set_film_content',expectedRevision:1,proposalId,content})});return r.status;},{variantId:handoff.variantId,proposalId:stale.id,content:read(staleFile).content});
  assert.equal(rejected,409);assert.deepEqual((await current()).content,edited.content);
  const freshFile=path.join(evidence,'fresh-proposal.json');
  if(!fs.existsSync(freshFile)){assert.equal(edited.revision,2);const content=structuredClone(edited.content);content.decoration.packaging.varsOverrides.title='卧室梳妆日常';save(freshFile,{requestId:randomUUID(),expectedRevision:2,summary:'仅调整主标题，保留人工字幕、布局、音乐及当前镜头',content});}
  const fresh=await cli('propose',dataRoot,handoff.groupId,freshFile);
  assert.deepEqual(await cli('propose',dataRoot,handoff.groupId,freshFile),fresh);
  if(edited.revision===2){
    await page.reload();await page.getByTestId('film-editor').waitFor();
    await page.getByRole('button',{name:'查看并编辑提案',exact:true,disabled:false}).click();
    assert.equal(await page.getByLabel('主标题',{exact:true}).inputValue(),'卧室梳妆日常');
    await page.getByRole('button',{name:'保存成片内容',exact:true}).click();
    await page.getByRole('region',{name:'成片内容编辑',exact:true}).waitFor({state:'hidden'});
  }
  const final=await current();assert.equal(final.revision,3);assert.deepEqual(final.clips,edited.clips);
  assert.deepEqual(final.content,read(freshFile).content);assert.equal(final.proposals.find(p=>p.id===fresh.id).status,'applied');
  const normalized=structuredClone(final.content);normalized.decoration.packaging.varsOverrides.title=before.content.decoration.packaging.varsOverrides.title;assert.deepEqual(normalized,before.content);
  save(path.join(evidence,'before-export.json'),final);
  let jobs=(await get(`/api/final-edit-groups/${handoff.groupId}`)).jobs.filter(j=>j.kind==='render'&&j.renderRevision?.variantRevision===3);
  if(!jobs.length){await page.getByRole('button',{name:'导出新版本',exact:true}).click();await page.getByRole('button',{name:'导出新版本（含当前包装）',exact:true}).click();}
  const job=await wait(async()=>{jobs=(await get(`/api/final-edit-groups/${handoff.groupId}`)).jobs.filter(j=>j.kind==='render'&&j.renderRevision?.variantRevision===3);const failed=jobs.find(j=>j.status==='failed');assert.ok(!failed,failed?.errorMessage);return jobs.find(j=>j.status==='succeeded');},900000);
  const output=(await get(`/api/final-edit-jobs/${job.id}`)).output,run=path.dirname(path.join(dataRoot,'storage',output.videoRelativePath));
  const checks=read(path.join(run,'checks.json'));assert.ok(checks.ok);
  const after=await current();assert.equal(after.deliveryVersion,4);assert.equal(after.deliveredRevision,3);assert.deepEqual(after.clips,final.clips);assert.deepEqual(after.content,final.content);
  for(const file of read(oldFiles))assert.equal(sha(path.join(root,'客户交付','旧版',file.name)),file.sha256);
  const delivered=path.join(root,'客户交付',output.videoFilename);assert.equal(sha(delivered),sha(path.join(dataRoot,'storage',output.videoRelativePath)));
  await cli('review',dataRoot,handoff.bindingId);
  await page.goto(`${state.origin}/api/reassembled-films/${handoff.bindingId}/review`);
  const player=page.locator('video').first();await wait(()=>player.evaluate(v=>v.readyState>=2&&v.videoWidth>0));
  const media=await player.evaluate(async v=>{v.muted=true;await v.play();return {src:v.currentSrc,duration:v.duration,width:v.videoWidth,height:v.videoHeight};});
  await wait(()=>player.evaluate(v=>v.currentTime>0.5));await player.evaluate(v=>v.pause());
  const served=await page.request.get(media.src);assert.ok(served.ok());assert.equal(createHash('sha256').update(await served.body()).digest('hex'),sha(delivered));
  await page.screenshot({path:path.join(evidence,'review-v4.png'),fullPage:true});
  result={ok:true,paidCalls:0,totalGenerationCalls:2,totalEstimatedCny:3.25,root,dataRoot,evidence,run,output,revision:3,deliveryVersion:4,otherSevenClipsUnchanged:true,manualContentPreserved:true,staleProposalRejected:true,proposalReplaySafe:true,oldV3Archived:true,reviewMedia:media,videoSha256:sha(delivered),technicalChecks:checks.checks.length,visualReviewPending:true,userApproval:false};
}finally{
  if(state){const health=await fetch(state.origin+'/api/desktop/health').then(r=>r.json()).catch(()=>null);if(health?.instanceId===state.instanceId)await fetch(state.origin+'/api/shutdown',{method:'POST',signal:AbortSignal.timeout(15000)}).catch(()=>{});}
  await wait(()=>handle.exitCode!==null||handle.signalCode!==null,30000).catch(()=>handle.kill('SIGKILL'));db.close();
}
assert.equal(handle.exitCode,0);assert.ok(!fs.existsSync(path.join(dataRoot,'storage/run/electron-service.json')));
save(path.join(evidence,'result.json'),result);console.log('PASS real D01 rework, manual preservation, stale/fresh proposal, v4 archive and HTML playback');
