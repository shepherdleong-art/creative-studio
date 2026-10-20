import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { applicationRoot, dataIdentity, launchScheme, parseLaunchUri, discoverDesktop, registerLauncher, unregisterLauncher, openReview } from './reassembled-launch.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'film-launch-中文 空格-')));
process.env.CREATIVE_STUDIO_DATA_ROOT=root; process.env.CREATIVE_STUDIO_APPLICATION_ROOT=applicationRoot;
const { reviewLaunchUrl, reviewProtocolScheme } = await import('../lib/final-edit/reassembled/launch-link.ts');
const hash=dataIdentity(root), scheme=launchScheme(hash), token='a'.repeat(64);
assert.equal(reviewProtocolScheme(hash),scheme);
const uri=`${scheme}://open/film-a?data=${hash}&version=1&token=${token}`;
assert.deepEqual(parseLaunchUri(uri,hash),{id:'film-a',version:1,token});
for(const invalid of [uri+' ',uri+'#x',uri+'&path=C:/windows',uri+'&version=2',uri.replace('film-a','../film-a'),uri.replace('open/','evil/'),uri.replace('://open/', '://user@open/'),uri.replace('version=1','version=0'),uri.replace('version=1','version=1.5'),uri.replace(token,'short'),uri.replace('data='+hash,'data='+'0'.repeat(64)),uri.replace(scheme,'http'),uri.replace('film-a','%22%20--eval'),uri.replace('film-a','a/b')]) assert.throws(()=>parseLaunchUri(invalid,hash));
assert.equal(reviewLaunchUrl({id:'film-a',reviewToken:token,deliveryVersion:1},hash),null);
fs.mkdirSync(path.join(root,'storage/run'),{recursive:true}); fs.mkdirSync(path.join(root,'electron'));
const stateFile=path.join(root,'storage/run/electron-service.json'), marker=path.join(root,'storage/run/reassembled-launcher.json');
let identityHash=hash, opens=0, starts=0, registered=false, receiptMode='valid';
const server=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1'); response.setHeader('Content-Type','application/json');
  if(url.pathname==='/api/reassembled-films/capabilities') response.end(JSON.stringify({instanceId:'unit-instance',dataIdentity:identityHash,apiVersion:1,applicationRoot,desktopUserData:path.join(root,'electron'),capabilities:['film-review-launch/1']}));
  else if(url.pathname==='/api/reassembled-films/film-a/open') {
    assert.equal(url.searchParams.get('token'),token); assert.equal(url.searchParams.get('data'),hash); assert.equal(url.searchParams.get('instance'),'unit-instance'); opens++;
    const requestId=url.searchParams.get('navigationRequest'), dir=path.join(root,'storage/run/reassembled-navigation-results');
    fs.mkdirSync(dir,{recursive:true});
    if(receiptMode!=='missing') fs.writeFileSync(path.join(dir,`${requestId}.json`),JSON.stringify({ok:true,requestId,instanceId:receiptMode==='wrong-instance'?'stale-instance':'unit-instance',bindingId:'film-a',deliveryVersion:1})); response.end('{}');
  }
  else { response.statusCode=404; response.end('{}'); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`, writeState=()=>fs.writeFileSync(stateFile,JSON.stringify({origin,instanceId:'unit-instance'}));
const key=`HKCU\\Software\\Classes\\${scheme}`;
try {
  writeState(); assert.equal((await discoverDesktop(root)).dataIdentity,hash);
  identityHash='0'.repeat(64); await assert.rejects(discoverDesktop(root),/身份不匹配/); identityHash=hash;
  if(process.platform==='win32') {
    assert.equal(spawnSync('reg.exe',['query',key],{windowsHide:true,stdio:'pipe'}).status,1,'A fresh test root must not already own a real registry entry');
    registered=true; const connected=await registerLauncher(root);
    assert.deepEqual(await registerLauncher(root),connected);
    execFileSync('reg.exe',['add',key,'/v','CreativeStudioDataIdentity','/t','REG_SZ','/d','test-other-owner','/f'],{windowsHide:true,stdio:'pipe'});
    await assert.rejects(registerLauncher(root),/其他归属/);
    execFileSync('reg.exe',['add',key,'/v','CreativeStudioDataIdentity','/t','REG_SZ','/d',hash,'/f'],{windowsHide:true,stdio:'pipe'});
  } else fs.writeFileSync(marker,JSON.stringify({schemaVersion:1,scheme,dataIdentity:hash,applicationRoot}));
  assert.equal(reviewLaunchUrl({id:'film-a',reviewToken:token,deliveryVersion:1},hash),uri);
  assert.equal((await openReview(root,uri,{timeout:2000})).ok,true); assert.equal(opens,1);
  if(process.env.FILM_LAUNCH_OS_DISPATCH==='1') {
    const statusFile=path.join(root,'storage/run/reassembled-launch-status.json'); fs.unlinkSync(statusFile);
    execFileSync('powershell.exe',['-NoProfile','-Command','Start-Process -FilePath $env:CREATIVE_STUDIO_TEST_REVIEW_URI -WindowStyle Hidden'],{env:{...process.env,CREATIVE_STUDIO_TEST_REVIEW_URI:uri,CREATIVE_STUDIO_LAUNCH_NO_DIALOG:'1'},windowsHide:true,stdio:'pipe'});
    const until=Date.now()+15000; while(!fs.existsSync(statusFile)&&Date.now()<until) await new Promise(resolve=>setTimeout(resolve,100));
    if(!fs.existsSync(statusFile)) {
      const errorFile=path.join(root,'storage/logs/reassembled-launch-error.json');
      assert.fail(fs.existsSync(errorFile)?fs.readFileSync(errorFile,'utf8'):'OS protocol produced no navigation status or handler error');
    }
    assert.equal(JSON.parse(fs.readFileSync(statusFile,'utf8')).navigationConfirmed,true);
    opens--; // Keep the remaining counter assertions independent of optional OS coverage.
  }
  fs.unlinkSync(stateFile);
  const startDesktop=()=>{starts++; setTimeout(writeState,50); return {exitCode:null};};
  await Promise.all([openReview(root,uri,{startDesktop,timeout:3000,interval:10}),openReview(root,uri,{startDesktop,timeout:3000,interval:10})]);
  assert.equal(starts,1,'Concurrent cold requests may launch only once'); assert.equal(opens,3);
  assert.ok(!fs.existsSync(path.join(root,'storage/run/reassembled-launch.lock')));
  await assert.rejects(openReview(root,uri+'&command=bad',{startDesktop,timeout:1000}),/字段无效/); assert.equal(starts,1);
  identityHash='0'.repeat(64); await assert.rejects(openReview(root,uri,{startDesktop,timeout:1000}),/身份不匹配/); assert.equal(starts,1); identityHash=hash;
  const status=fs.readFileSync(path.join(root,'storage/run/reassembled-launch-status.json'),'utf8'); assert.ok(!status.includes(token));
  receiptMode='missing'; await assert.rejects(openReview(root,uri,{timeout:150,interval:10}),/尚未确认/);
  receiptMode='wrong-instance'; await assert.rejects(openReview(root,uri,{timeout:1000,interval:10}),/未能加载/);
  assert.equal(fs.readFileSync(path.join(root,'storage/run/reassembled-launch-status.json'),'utf8'),status,'No success without the current desktop acknowledgement');
  console.log('PASS strict URI, application/data identity, scoped Windows registration, hot navigation and concurrent cold launch isolation (cold child is simulated)');
} finally {
  if(registered) { execFileSync('reg.exe',['add',key,'/v','CreativeStudioDataIdentity','/t','REG_SZ','/d',hash,'/f'],{windowsHide:true,stdio:'pipe'}); unregisterLauncher(root); assert.equal(spawnSync('reg.exe',['query',key],{windowsHide:true,stdio:'pipe'}).status,1); }
  await new Promise(resolve=>server.close(resolve)); fs.rmSync(root,{recursive:true,force:true});
}
