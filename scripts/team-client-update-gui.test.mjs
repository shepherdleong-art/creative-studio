import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { ZipArchive } from 'archiver';
if (process.platform !== 'win32') { console.log('SKIP: Windows update GUI'); process.exit(0); }
const require = createRequire(import.meta.url);
const { ClientUpdateCoordinator } = require('../dist-desktop/client/update-coordinator.js');
const { createNativeUpdateProcessControl } = require('../dist-desktop/client/update-helper.js');
const { signUpdateManifest } = require('../dist-desktop/client/update-package.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-update-gui-'));
const runtimeFlag = process.argv.indexOf('--electron-dist');
const runtime = path.resolve(runtimeFlag >= 0 ? process.argv[runtimeFlag + 1] : 'node_modules/electron/dist');
assert.ok(fs.existsSync(path.join(runtime, 'electron.exe')), 'Requires a real Electron runtime (--electron-dist)');
let old, monitor, newPid;
try {
  fs.mkdirSync(path.join(root, 'client-state/downloads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client-state/state.json'), '{"schemaVersion":1}');
  fs.writeFileSync(path.join(root, 'client-state/downloads/keep.txt'), 'existing download');
  fs.writeFileSync(path.join(root, 'client-config.json'), JSON.stringify({ connectionMode: 'direct' }));
  const source = path.join(root, 'fixture'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), '{"main":"app.cjs","version":"0.7.1"}');
  fs.writeFileSync(path.join(source, 'release.json'), '{"releaseId":"new","version":"0.7.1"}');
  fs.writeFileSync(path.join(source, 'app.cjs'), `
    const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
    app.setPath('userData',path.join(process.env.CREATIVE_STUDIO_CLIENT_STATE_ROOT,'electron-fixture'));
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:500,height:240});
      await win.loadURL('data:text/html,<h2>客户端更新窗口验证</h2>');win.show();
      const health={releaseId:'new',pid:process.pid,healthy:true,stateSchema:1,apiVersion:1,
        visible:win.isVisible(),direct:app.commandLine.hasSwitch('no-proxy-server'),handle:win.getNativeWindowHandle().readBigUInt64LE().toString()};
      const out=path.join(process.env.CREATIVE_STUDIO_CLIENT_STATE_ROOT,'run','client-health.json');
      fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(health));
      setTimeout(()=>app.quit(),60000);
    });`);
  const archive = path.join(root, 'new.zip');
  await new Promise((resolve,reject)=>{const stream=fs.createWriteStream(archive);const zip=new ZipArchive();stream.on('close',resolve);stream.on('error',reject);zip.on('error',reject);zip.pipe(stream);zip.directory(source,false);void zip.finalize();});
  const bytes=fs.readFileSync(archive);const keys=crypto.generateKeyPairSync('ed25519');
  const make=id=>signUpdateManifest({schemaVersion:1,releaseId:id,version:'0.7.1',platform:'win32',arch:'x64',size:bytes.length,
    sha256:crypto.createHash('sha256').update(bytes).digest('hex'),api:{min:1,max:1},clientStateSchema:{min:1,max:1},entry:'app.cjs',packageUrl:'https://studio.example.test/client-updates/new.zip'},keys.privateKey);
  fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({schemaVersion:1,releaseId:'old',directory:'versions/old',manifest:make('old')}));
  fs.mkdirSync(path.join(root,'versions/old'),{recursive:true});
  old=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  const job={schemaVersion:1,jobId:crypto.randomUUID(),installRoot:root,currentPid:old.pid,platform:'win32',arch:'x64',serverOrigin:'https://studio.example.test',manifestUrl:'https://studio.example.test/client-updates/current.manifest.json'};
  const jobRoot=path.join(root,'updates/jobs');
  monitor=setInterval(()=>{if(fs.existsSync(path.join(jobRoot,job.jobId+'.pause-request'))){fs.writeFileSync(path.join(jobRoot,job.jobId+'.pause-ack'),'{}');}if(fs.existsSync(path.join(jobRoot,job.jobId+'.stop-request'))&&old.exitCode===null)old.kill();},25);
  const control=createNativeUpdateProcessControl(job);
  const coordinator=new ClientUpdateCoordinator({rootDir:root,publicKey:keys.publicKey.export({type:'spki',format:'pem'}),platform:'win32',arch:'x64',trustedOrigins:[job.serverOrigin],fetch:async url=>url===job.manifestUrl?Response.json(make('new')):new Response(bytes),
    processControl:{...control,startVersion:async input=>{fs.symlinkSync(runtime,path.join(input.directory,'electron'),'junction');return control.startVersion(input);}}});
  const result=await coordinator.applyFromUrl(job.manifestUrl);
  assert.equal(result.status,'committed',JSON.stringify(result));
  const health=JSON.parse(fs.readFileSync(path.join(root,'client-state/run/client-health.json'),'utf8'));newPid=health.pid;
  assert.equal(health.visible,true);assert.equal(health.direct,true);
  assert.match(health.handle,/^\d+$/);
  const native=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WindowProbe { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }'; [WindowProbe]::IsWindowVisible([IntPtr]::new([long]${health.handle}))`],{encoding:'utf8',windowsHide:true}).trim();
  assert.equal(native,'True','必须验证 Win32 原生窗口可见，不能只信 Electron 状态');
  assert.equal(fs.readFileSync(path.join(root,'client-state/downloads/keep.txt'),'utf8'),'existing download');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'client-state/run/transfer-gate.json'),'utf8')).blocked,false);
  console.log('PASS: native signed update reopens a visible Electron window, preserves direct connection and existing downloads, and commits health before resuming transfers');
} finally {
  clearInterval(monitor);if(old?.exitCode===null)old.kill();if(newPid){try{process.kill(newPid);}catch{}}
  await new Promise(resolve=>setTimeout(resolve,1000));
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('team-update-gui-'));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
