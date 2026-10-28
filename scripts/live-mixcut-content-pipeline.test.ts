import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// Actual files, formula queue, ASR adapter, timeline and renderer. Only external model responses are simulated.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-content-pipeline-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
process.env.CREATIVE_STUDIO_VOLC_ASR_API_KEY = 'fixture-only';
const originalFetch = globalThis.fetch;
const db = new Database(path.join(root, 'test.db'));
try {
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  const { registerManagedCopy } = await import('../lib/live-mixcut/media-catalog.ts');
  const { registerFormulaAssetBinding } = await import('../lib/live-mixcut/formula/material-bindings.ts');
  const { readFormulaMaterialNotes, organizeFormulaMaterialNotes, saveFormulaMaterialNote } = await import('../lib/live-mixcut/formula/material-notes.ts');
  const { createFormulaImportSession, confirmFormulaImportSession } = await import('../lib/live-mixcut/formula/import-store.ts');
  const { saveFormulaSettings } = await import('../lib/live-mixcut/formula/settings-store.ts');
  const { defaultFormulaProductionSettings } = await import('../lib/live-mixcut/formula/production-settings.ts');
  const { createFormulaGenerationRequest } = await import('../lib/live-mixcut/formula/generation.ts');
  const { readFormulaSelectionHistory } = await import('../lib/live-mixcut/formula/reselection.ts');
  const { createFormulaStageExecutor } = await import('../lib/live-mixcut/formula/stage-executor.ts');
  const { createBatchRenderExecutor } = await import('../lib/live-mixcut/batch-render-executor.ts');
  const { runPendingOnce } = await import('../lib/live-mixcut/runner.ts');
  const { retryTask } = await import('../lib/live-mixcut/scheduler.ts');
  const { listBatchTasks } = await import('../lib/live-mixcut/tasks.ts');
  const { getBatchWorkspace } = await import('../lib/live-mixcut/batch-workspace.ts');
  const { getBatchOutputArrangementView } = await import('../lib/live-mixcut/output-arrangement.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','公式链路验收');");
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p']);
  const batchId = createBatchProduction(db, 'p', '内容到成片', undefined, { planningMode: 'formula' });
  const assets: Array<{ id: string; code: string; bindingId: string }> = [];
  for (const [i, code, color, seconds] of [[1,'P1','red',1],[2,'P1','blue',1.5],[3,'P2','green',2],[4,'VO1','yellow',3]] as const) {
    const file = path.join(root, `source-${i}.mp4`);
    await runFfmpeg(['-f','lavfi','-i',`color=${color}:s=64x64:r=24:d=${seconds}`,'-f','lavfi','-i',`sine=frequency=660:duration=${seconds}`,
      '-c:a','aac','-c:v','libx264','-pix_fmt','yuv420p','-shortest','-y',file]);
    const id = await registerManagedCopy(db,'p',{sourcePath:file});
    const binding = registerFormulaAssetBinding(db,'p',batchId,{assetId:id,sourcePath:`${code}_展示_${i}.mp4`});
    assets.push({id,code,bindingId:binding.id});
  }
  let notes = readFormulaMaterialNotes(db,'p',batchId);
  const manualItem = notes.items.find(item=>item.logicalCode==='P2')!;
  const chosen = assets.filter(asset=>asset.code==='P1').sort((a,b)=>a.id.localeCompare(b.id))[1];
  const observed: string[] = [];
  const visualModel = {id:'vision',name:'画面',model:'vision-fixture',analyze:async (input: {assetId:string;filePath:string})=>{
    assert(fs.existsSync(input.filePath)); observed.push(input.assetId);
    const description = input.assetId===chosen.id ? '易清洁' : '展示背面';
    return {summary:description,sellingPoints:[description],semanticTags:[],qualityIssues:[],usableRanges:[],coverFrameTimesUs:[],
      scenes:[{startUs:0,endUs:500_000,description,labels:[],qualityScore:0.8}]};
  }};
  // 分析画面只看非口播素材：P1 两份和 P2，各留一段有效片段和画面描述。
  notes=await organizeFormulaMaterialNotes(db,'p',batchId,{expectedRevision:notes.revision},visualModel);
  assert.equal(notes.run?.succeeded,3);
  assert.equal(observed.length,3,'口播镜头不做画面分析');
  assert.equal(notes.items.find(item=>item.voiceOver)?.analysis,null);
  assert(notes.items.find(item=>item.bindingId===manualItem.bindingId)?.analysis?.usableInUs === 0,'每段非口播素材都有有效片段');
  assert.equal(notes.items.find(item=>item.source.assetId===chosen.id)?.profile?.provenance.visualObservation,true);
  assert.equal(notes.items.find(item=>item.source.assetId===chosen.id)?.profile?.content.speech,'unknown');
  // 人工说明可以修正 AI 结果；再点分析画面不会覆盖人工说明，也不会重新调用模型。
  const aiProfile = notes.items.find(item=>item.bindingId===manualItem.bindingId)!.profile!;
  const saved = saveFormulaMaterialNote(db,'p',batchId,manualItem.bindingId,{expectedRevision:notes.revision,expectedProfileId:aiProfile.id,
    content:{description:'人工确认的展示',category:'',sellingPoints:[],actions:[],speech:'unknown',evidence:[]}});
  notes=readFormulaMaterialNotes(db,'p',batchId);
  assert.equal(notes.items.find(item=>item.bindingId===manualItem.bindingId)?.profile?.id,saved.id);
  notes=await organizeFormulaMaterialNotes(db,'p',batchId,{expectedRevision:notes.revision},visualModel);
  assert.equal(observed.length,3,'续做不重复调用已成功的画面分析');
  assert.equal(notes.items.find(item=>item.bindingId===manualItem.bindingId)?.profile?.id,saved.id,'画面分析不得覆盖人工说明');
  const book=new ExcelJS.Workbook();
  book.addWorksheet('脚本').addRows([['序号','平台','镜头数','预估时长(s)','画面分镜(逻辑镜号组合)','脚本文案'],[1,'抖音',3,6,'P2 VO1 P1','易清洁。']]);
  const imported=await createFormulaImportSession(db,'p',batchId,{kind:'scripts',filename:'脚本.xlsx',bytes:Buffer.from(await book.xlsx.writeBuffer()),expectedRevision:notes.revision});
  confirmFormulaImportSession(db,'p',batchId,imported.id,{expectedRevision:notes.revision,excludedKeys:[]});
  const revision=readFormulaMaterialNotes(db,'p',batchId).revision;
  const production=defaultFormulaProductionSettings(); production.audio={mode:'mixed',tts:null};production.packaging={mode:'none',templateIds:[]};
  const settings=await saveFormulaSettings(db,'p',batchId,{expectedInputRevision:revision,expectedSettingsRevision:0,scriptsSessionId:imported.id,
    settings:{selections:[{key:'1:2',copies:1}],bgm:{mode:'none',trackIds:[]},production}});
  const request=await createFormulaGenerationRequest(db,'p',batchId,{requestKey:'pipeline',settingsId:settings.saved!.id,expectedInputRevision:revision});
  let failSilent = true;
  globalThis.fetch=async (_url, options)=>{
    const payload=JSON.parse(String(options?.body));assert(payload.audio?.data,'必须先抽音频');
    if(Buffer.from(payload.audio.data,'base64').length < 90_000) return new Response('{}',{headers:{'X-Api-Status-Code':failSilent?'20000004':'20000003'}});
    return Response.json({result:{text:'易清洁。',utterances:[{words:[{text:'易清洁。',start_time:200,end_time:1000}]}]}},{headers:{'X-Api-Status-Code':'20000000'}});
  };
  const executor=createFormulaStageExecutor(async()=>({id:'fixture',name:'声音编排',model:'fixture',complete:async input=>{
    const prompt=JSON.parse(input.userPrompt);return {blocks:[{kind:'source',text:'易清洁。',slotId:prompt.sources[0].slotId}]};
  }}));
  await runPendingOnce({db,workerId:'before-retry',executors:[executor,createBatchRenderExecutor()],log:()=>{}});
  const planId=request.outputs[0].planId;
  let view=readFormulaSelectionHistory(db,'p',batchId,planId);
  assert.deepEqual(view.current.result?.slots.map(slot=>slot.logicalCode),['P2','VO1','P1']);
  assert.equal(view.current.result?.slots[2].assetId,chosen.id,'画面说明应参与同编号选片，而不是按 asset ID 取首个');
  assert.equal(view.current.result?.slots[2].reason,'same_code_content_choice');
  assert.equal(view.current.timeline.result,null,'原声失败不能伪造时间线');
  const failed=listBatchTasks(db,batchId).filter(task=>task.status==='failed');assert.equal(failed.length,2);
  failSilent=false; for(const task of failed) retryTask(db,'p',task.id);
  await runPendingOnce({db,workerId:'after-retry',executors:[executor,createBatchRenderExecutor()],log:()=>{}});
  view=readFormulaSelectionHistory(db,'p',batchId,planId);
  assert.equal(view.current.speech.sources.filter(source=>source.result?.status==='no_speech').length,2);
  assert.equal(view.current.timeline.result?.status,'planned',JSON.stringify(getBatchWorkspace(db,'p',batchId).formulaGeneration));
  assert.equal(getBatchWorkspace(db,'p',batchId).formulaGeneration?.ready,1);
  const output=getBatchOutputArrangementView(db,'p',batchId,planId);
  assert.deepEqual(output.clips.map(clip=>clip.assetId),[assets[2].id,assets[3].id,chosen.id]);
  const {setBatchPlanReviews}=await import('../lib/live-mixcut/review.ts');
  const {orchestrateBatchExport}=await import('../lib/live-mixcut/export-orchestrator.ts');
  setBatchPlanReviews(db,'p',batchId,{decision:'approved',items:[{planId,...output.reviewContext!}]});
  await orchestrateBatchExport(db,'p',batchId,[planId],{wakeScheduler:()=>{}});
  await runPendingOnce({db,workerId:'export',executors:[createBatchRenderExecutor()],log:()=>{}});
  assert.equal((await orchestrateBatchExport(db,'p',batchId,[planId],{wakeScheduler:()=>{}})).items[0].status,'published');
  console.log('PASS 画面分析、人工保护、同编号按说明选择、真实抽音频、无人声失败重试续接、公式顺序、实际MP4导出');
} finally {globalThis.fetch=originalFetch;db.close();fs.rmSync(root,{recursive:true,force:true});}
