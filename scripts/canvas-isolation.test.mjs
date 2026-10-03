import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-owned-'));
const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-foreign-'));
for (const name of ['stop.command','scripts/canvas-profile.sh','scripts/stop-litellm.sh','scripts/runtime/ports.mjs','scripts/runtime/process-tree.mjs']) {
 fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});
 fs.copyFileSync(name,path.join(root,name));
}
const children=[];
async function listener(cwd) {
 const file=path.join(cwd,'listener.cjs');
 fs.writeFileSync(file,"require('net').createServer().listen(3100,'127.0.0.1',()=>console.log('ready'));\n");
 const child=spawn(process.execPath,[file],{cwd,stdio:['ignore','pipe','pipe']});children.push(child);
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('listener exited before ready')));});
 return child;
}
const stop = ()=>exec('bash',[path.join(root,'stop.command')],{cwd:root,timeout:20000});
try {
 const foreign=await listener(foreignRoot);
 await stop();assert.doesNotThrow(()=>process.kill(foreign.pid,0),'foreign port owner must survive');
 const gone=new Promise(r=>foreign.once('exit',r));foreign.kill();await gone;
 const owned=await listener(root);
 await stop();
 assert.throws(()=>process.kill(owned.pid,0),'owned port owner must stop');
 const {stdout}=await exec('bash',['-c','source "$1"; printf "%s|%s|%s" "$PORT" "$CREATIVE_STUDIO_LITELLM_PORT" "$CREATIVE_STUDIO_DATA_ROOT"','bash',path.join(root,'scripts/canvas-profile.sh')],{env:{...process.env,CREATIVE_STUDIO_DATA_ROOT:foreignRoot,PORT:'3000'}});
 assert.equal(stdout,`3100|4100|${fs.realpathSync(root)}`);
 console.log('Canvas isolation: foreign listener survives, owned listener stops, inherited original data root overridden.');
} finally {
 for(const child of children) if(child.exitCode===null) child.kill();
 fs.rmSync(root,{recursive:true,force:true});fs.rmSync(foreignRoot,{recursive:true,force:true});
}
