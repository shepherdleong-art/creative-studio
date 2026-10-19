#!/usr/bin/env node
// Usage: node scripts/reassembled-workbench.mjs doctor|import|review DATA_ROOT [MANIFEST.json|BINDING_ID]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [command, rootArg, argument] = process.argv.slice(2);
try {
  if (!['doctor', 'import', 'review'].includes(command) || !rootArg || (command !== 'doctor' && !argument)) throw new Error('用法：reassembled-workbench.mjs doctor|import|review 数据目录 [导入清单.json|成片登记ID]');
  const root = fs.realpathSync(rootArg);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'storage/run/electron-service.json'), 'utf8'));
  const url = new URL(state.origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || state.origin !== url.origin) throw new Error('桌面实例地址不是本机地址');
  const read = async (response) => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || result.error || `HTTP ${response.status}`);
    return result;
  };
  const identity = await read(await fetch(`${url.origin}/api/reassembled-films/capabilities`, { signal: AbortSignal.timeout(10000) }));
  const dataIdentity = createHash('sha256').update(root).digest('hex');
  if (identity.instanceId !== state.instanceId || identity.dataIdentity !== dataIdentity || identity.apiVersion !== 1) throw new Error('桌面实例或数据目录身份不匹配，请重启发现流程');
  if (command === 'doctor') console.log(JSON.stringify(identity, null, 2));
  else {
    if (command === 'review' && !/^[a-zA-Z0-9_-]{1,128}$/.test(argument)) throw new Error('成片登记 ID 无效');
    const token = fs.readFileSync(path.join(root, 'storage/run/reassembled-agent-token'), 'utf8').trim();
    const endpoint = command === 'import' ? 'import' : `${argument}/review`;
    const result = await read(await fetch(`${url.origin}/api/reassembled-films/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reassembled-Token': token, 'X-Desktop-Instance': identity.instanceId, 'X-Data-Identity': dataIdentity },
      ...(command === 'import' ? { body: fs.readFileSync(argument, 'utf8') } : {}), signal: AbortSignal.timeout(300000),
    }));
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
