// FILM_REAL_FIXTURE=... node scripts/reassembled-rework-single-shot.test.ts
// Copy only the already-isolated acceptance DB; never start a queue or call a supplier.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { applyFilmRework, readFilmRework } from '../lib/final-edit/reassembled/rework.ts';
import { shouldInjectCompanyKlingMultiShot, videoMultiShotFromStorage } from '../lib/video-multi-shot.ts';
const fixture=JSON.parse(fs.readFileSync(process.env.FILM_REAL_FIXTURE!,'utf8'));
assert.ok(fixture.root.includes('2026-10-19-real-handoff'));
const handoff=JSON.parse(fs.readFileSync(path.join(fixture.root,'handoff-result.json'),'utf8'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'reassembled-single-shot-'));
const source=new Database(path.join(fixture.dataRoot,'data/workbench.db'),{readonly:true});
await source.backup(path.join(temp,'test.db'));source.close();
const db=new Database(path.join(temp,'test.db'));db.pragma('foreign_keys=ON');
globalThis.fetch=async()=>{throw new Error('Network forbidden in isolated single-shot test');};
try {
  const before=db.prepare('SELECT * FROM final_edit_variants ORDER BY id').all();
  for(const model of ['qiniuyun/kling-3.0','kling-3.0','synthetic-video']) {
    const id=randomUUID();
    db.prepare(`INSERT INTO video_providers(id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,baseUrl,apiKey,defaultModel,enabled)
      VALUES(?,'local single-shot test','openai-video','','','','http://127.0.0.1:1','fixture-only',?,1)`).run(id,model);
    const clipId='v01-Q2-D01',view=readFilmRework(db,handoff.groupId,clipId);
    const command={type:'generate_video' as const,requestId:randomUUID(),expectedRevision:view.revision,providerId:id,model,imageId:view.currentImageId,prompt:'单镜头连续移动',durationSec:5};
    const receipt=await applyFilmRework(db,path.join(temp,'storage'),handoff.groupId,clipId,command,'agent');
    const row=db.prepare('SELECT multiShot,status FROM video_jobs WHERE id=?').get(receipt.jobId) as {multiShot:number|null;status:string};
    assert.equal(row.multiShot,model==='synthetic-video'?null:0,'Local rework must explicitly disable managed multi-shot defaults');
    assert.equal(shouldInjectCompanyKlingMultiShot(model,videoMultiShotFromStorage(row.multiShot)),false);
    assert.equal(row.status,'pending');
    assert.deepEqual(await applyFilmRework(db,path.join(temp,'storage'),handoff.groupId,clipId,command,'agent'),receipt);
  }
  assert.deepEqual(db.prepare('SELECT * FROM final_edit_variants ORDER BY id').all(),before);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  console.log(JSON.stringify({ok:true,paidCalls:0,models:3,manualContentPreserved:true,temp}));
} finally {db.close();}
