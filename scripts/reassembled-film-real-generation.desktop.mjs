// Authorized real generation acceptance. Stable commands, one submit, stop for visual review.
// FILM_REAL_STAGE=image|video, FILM_REAL_FIXTURE=...; no automatic paid retry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import { _electron as electron } from '@playwright/test';
import { PRICES } from './reassembled-film/runtime.mjs';
const read = p => JSON.parse(fs.readFileSync(p,'utf8'));
const save = (p,v) => fs.writeFileSync(p,JSON.stringify(v,null,2));
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const stage=process.env.FILM_REAL_STAGE;assert.ok(['image','video'].includes(stage));
const fixture=read(process.env.FILM_REAL_FIXTURE), { root,dataRoot }=fixture;
assert.ok(root.includes('2026-10-19-real-handoff')&&fixture.historicalReuse);
const phase=path.dirname(root),handoff=read(path.join(root,'handoff-result.json'));
const authorization=read(path.join(phase,'continuation-authorization.json'));
assert.ok(authorization.realMaterialAndApiAuthorizedByActiveGoal);
const evidence=path.join(root,'real-generation');fs.mkdirSync(evidence,{recursive:true});
assert.ok(!fs.existsSync(path.join(evidence,`${stage}-result.json`)),'Stage already complete; do not generate again');
assert.ok(fs.statfsSync(root).bavail*fs.statfsSync(root).bsize>1.5e9,'Reserve disk before paid submission');
const models={image:{id:'company-gateway-qiniuyun-gpt-image-2-medium',model:'qiniuyun/gpt-image-2-medium',table:'providers'},video:{id:'company-qiniuyun-kling-3-0',model:'qiniuyun/kling-3.0',table:'video_providers'}};
assert.ok(PRICES[models.image.model]+PRICES[models.video.model]<=authorization.plannedImageVideoBudgetCapCny);
const config=yaml.load(fs.readFileSync('config.yaml','utf8'));
assert.equal(config.router_settings.num_retries,0);assert.equal(config.router_settings.timeout,110);
assert.equal(config.num_retries,undefined);
const source=new Database('data/workbench.db',{readonly:true}),db=new Database(path.join(dataRoot,'data/workbench.db'));
db.prepare('UPDATE providers SET enabled=0').run();db.prepare('UPDATE video_providers SET enabled=0').run();
const selected=models[stage];const provider=source.prepare(`SELECT * FROM ${selected.table} WHERE id=?`).get(selected.id);
assert.ok(provider?.enabled);assert.equal(stage==='image'?provider.model:provider.defaultModel,selected.model);
assert.equal(new URL(provider.baseUrl).origin,'http://127.0.0.1:4000');
const columns=db.prepare(`PRAGMA table_info(${selected.table})`).all().map(c=>c.name).filter(c=>Object.hasOwn(provider,c));
db.prepare(`INSERT INTO ${selected.table}(${columns.map(c=>`"${c}"`).join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${columns.filter(c=>c!=='id').map(c=>`"${c}"=excluded."${c}"`).join(',')}`).run(...columns.map(c=>provider[c]));source.close();
const env={...process.env,CREATIVE_STUDIO_DATA_ROOT:dataRoot,CREATIVE_STUDIO_NODE:process.execPath,CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER:'0',CREATIVE_STUDIO_CANVAS_ENABLE:'0'};
for(const line of fs.readFileSync('.env.local','utf8').split(/\r?\n/)) { const m=line.match(/^\s*(CREATIVE_STUDIO_COS_[A-Z_]+)\s*=\s*(.*?)\s*$/);if(m)env[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2'); }
for(const key of ['CREATIVE_STUDIO_COS_SECRET_ID','CREATIVE_STUDIO_COS_SECRET_KEY','CREATIVE_STUDIO_COS_DOMAIN'])assert.ok(env[key]);
for(const key of ['CREATIVE_STUDIO_STANDALONE_ROOT','CREATIVE_STUDIO_PACKAGING_DIR','CREATIVE_STUDIO_PACKAGING_NODE','CREATIVE_STUDIO_FFMPEG','CREATIVE_STUDIO_FFPROBE','CREATIVE_STUDIO_PUBLIC_BASE_URL'])delete env[key];
const exec=promisify(execFile);
// The company transport gate reads configuration beside the isolated data root.
// Preserve the real configuration only for this owned runtime; never fabricate a marker.
const isolatedConfig=path.join(dataRoot,'config.yaml');
assert.ok(!fs.existsSync(isolatedConfig),'Inspect existing isolated configuration before reuse');
fs.copyFileSync('config.yaml',isolatedConfig,fs.constants.COPYFILE_EXCL);
const isolatedConfigHash=sha(isolatedConfig);assert.equal(isolatedConfigHash,sha('config.yaml'));
const wait=async(fn,timeout=90000)=>{const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,1000));}throw new Error('Observation timed out; keep original job identity');};
const cli=async(...args)=>JSON.parse((await exec(process.execPath,['scripts/reassembled-workbench.mjs',...args],{env,windowsHide:true,timeout:300000,maxBuffer:8*1024*1024})).stdout);
const started=await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/start-stack.ps1','-SkipApp'],{env,windowsHide:true,timeout:120000});
fs.writeFileSync(path.join(evidence,`${stage}-proxy-start.log`),started.stdout);
assert.ok((await fetch('http://127.0.0.1:4000/health/liveliness')).ok);
const available=await fetch('http://127.0.0.1:4000/v1/models').then(r=>r.json());assert.ok(available.data.some(m=>m.id===selected.model));
const app=await electron.launch({args:[path.resolve('.'),`--user-data-dir=${path.join(evidence,`electron-${stage}`)}`],cwd:path.resolve('.'),env,timeout:60000});
const handle=app.process();let state,result;
try {
  const page=await app.firstWindow();await page.waitForURL(/127\.0\.0\.1/,{timeout:60000});state=read(path.join(dataRoot,'storage/run/electron-service.json'));
  const original=await cli('current',dataRoot,handoff.groupId);assert.equal(original.revision,1);assert.deepEqual(original.content,read(path.join(root,'manual-edit-result.json')).content);
  save(path.join(evidence,`${stage}-film-before.json`),original);
  const clipId='v01-Q2-D01';let view=await cli('shot',dataRoot,handoff.groupId,clipId);
  if(stage==='video') {
    assert.equal(read(path.join(evidence,'video-template-source.json')).id,'left-to-right-slide');
    const image=read(path.join(evidence,'image-result.json')),review=read(path.join(evidence,'image-review.json'));
    assert.ok(review.approved&&review.sha256===sha(image.outputPath)&&review.sha256===image.outputSha256);
    if(view.currentImageId!==image.outputImageId) {
      await page.goto(`${state.origin}/projects/${handoff.production.projectId}?tab=final-edit&filmGroup=${handoff.groupId}&filmShotSet=${handoff.shotSetId}`);
      await page.getByTestId('film-editor').waitFor({timeout:60000});await page.getByLabel('选择镜头',{exact:true}).selectOption(clipId);
      await page.getByRole('link',{name:'返工这个镜头'}).click();await page.getByTestId('film-rework').waitFor();
      await page.getByRole('button',{name:'采用这张分镜图',exact:true}).waitFor({state:'visible',timeout:30000});
      assert.equal(await page.getByRole('button',{name:'采用这张分镜图',exact:true}).count(),1);
      await page.getByRole('button',{name:'采用这张分镜图',exact:true}).click();
      view=await wait(async()=>{const v=await cli('shot',dataRoot,handoff.groupId,clipId);return v.currentImageId===image.outputImageId&&v;});
      await page.screenshot({path:path.join(evidence,'selected-image.png')});
    }
  }
  const file=path.join(evidence,`${stage}-command.json`);
  if(!fs.existsSync(file)) {
    const prompt=stage==='image'
      ? '图1是产品结构、颜色、材质和构图的唯一依据，图2为当前已用分镜的光线参考。只将抽面上强烈斜向光影柔化为自然均匀的漫射窗光，保留细微立体阴影。保持原图可见的两只金色花形拉手、奶油色抽面、胡桃色台沿及原有几何线框分格的位置、数量、形状与比例。严格保留当前特写取景，不扩展画外柜体，不新增抽屉、拉手或装饰，不改材质色相，不增加人物、文字或水印。3:4竖幅真实家具摄影，产品清晰，温和自然光。'
      : '单镜头连续拍摄这张分镜中的奶油色抽面和金色花形拉手特写。镜头沿抽面向右平稳横移，前两秒即可看清轻快但稳定的视差，配合很轻的推进；保持原有柜体、拉手数量与形状、几何分格、胡桃色台沿和柔和自然光完全稳定，不变形、不增减部件、不变焦跳切，不增加人物或文字。5秒，3:4竖幅，无转场，无多镜头。';
    save(file,{type:`generate_${stage}`,requestId:randomUUID(),expectedRevision:view.revision,providerId:selected.id,model:selected.model,prompt,
      ...(stage==='image'?{inputImageId:view.sourceImageId,referenceImageIds:[view.currentImageId],size:'1440x1920',quality:'standard'}:{imageId:view.currentImageId,durationSec:5})});
  }
  const command=read(file);const existing=db.prepare('SELECT resultJson FROM final_edit_film_reworks WHERE id=?').get(command.requestId);
  const receipt=existing?JSON.parse(existing.resultJson):await cli('rework',dataRoot,handoff.groupId,clipId,file);
  save(path.join(evidence,`${stage}-receipt.json`),receipt);
  if(stage==='video')assert.equal(db.prepare('SELECT multiShot FROM video_jobs WHERE id=?').get(receipt.jobId).multiShot,0);
  console.log(JSON.stringify({stage,event:existing?'resume-original-job':'submitted-once',jobId:receipt.jobId,estimateCny:PRICES[selected.model]}));
  const table=stage==='image'?'jobs':'video_jobs';
  const job=await wait(()=>{const j=db.prepare(`SELECT status,attempt,providerTaskId,outputImageId,localVideoPath FROM ${table} WHERE id=?`.replace(stage==='image'?',localVideoPath':',outputImageId','')).get(receipt.jobId);return ['succeeded','failed','needs_check','canceled'].includes(j?.status)&&j;},1200000);
  save(path.join(evidence,`${stage}-job-status.json`),job);
  assert.equal(job.status,'succeeded',`Original job ${receipt.jobId} requires attention; do not resubmit`);assert.equal(job.attempt,1);
  const outputPath=stage==='image'?db.prepare('SELECT path FROM image_assets WHERE id=?').get(job.outputImageId).path:job.localVideoPath;
  const after=await cli('current',dataRoot,handoff.groupId);
  for(const key of ['revision','clips','content','originalContent','history','proposals','candidates','deliveryVersion','deliveredRevision'])assert.deepEqual(after[key],original[key],key);
  result={ok:true,stage,paidCalls:1,estimatedCny:PRICES[selected.model],model:selected.model,jobId:receipt.jobId,providerTaskId:job.providerTaskId,outputPath,outputSha256:sha(outputPath),...(job.outputImageId?{outputImageId:job.outputImageId}:{}),originalFilmUnchanged:true,visualReviewPending:true};
} finally {
  if(state){const health=await fetch(state.origin+'/api/desktop/health').then(r=>r.json()).catch(()=>null);if(health?.instanceId===state.instanceId)await fetch(state.origin+'/api/shutdown',{method:'POST',signal:AbortSignal.timeout(15000)}).catch(()=>{});}
  await wait(()=>handle.exitCode!==null||handle.signalCode!==null,30000).catch(()=>handle.kill('SIGKILL'));
  db.prepare(`UPDATE ${selected.table} SET enabled=0 WHERE id=?`).run(selected.id);db.close();
  // This harness launched the proxy itself. Await its owned stop script instead
  // of assuming Electron exit also completed the detached Windows cleanup.
  const stopped=await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/stop-stack.ps1'],{env,windowsHide:true,timeout:60000});
  fs.writeFileSync(path.join(evidence,`${stage}-proxy-stop.log`),stopped.stdout);
  assert.ok(!fs.existsSync(path.join(dataRoot,'storage/run/stack.json')));
  if(fs.existsSync(isolatedConfig)&&sha(isolatedConfig)===isolatedConfigHash)fs.unlinkSync(isolatedConfig);
}
assert.equal(handle.exitCode,0);assert.ok(!fs.existsSync(path.join(dataRoot,'storage/run/electron-service.json')));
save(path.join(evidence,`${stage}-result.json`),result);console.log(JSON.stringify({stage,status:'ready-for-visual-review',outputPath:result.outputPath,estimatedCny:result.estimatedCny}));
