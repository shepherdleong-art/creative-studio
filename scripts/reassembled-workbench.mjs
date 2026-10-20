#!/usr/bin/env node
// P2: shot DATA_ROOT GROUP_ID CLIP_ID | rework DATA_ROOT GROUP_ID CLIP_ID COMMAND.json
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [command, rootArg, argument, clipId, commandFile] = process.argv.slice(2);
try {
  if (!['doctor', 'connect', 'disconnect', 'import', 'review', 'shot', 'rework', 'current', 'propose', 'begin', 'production', 'sync'].includes(command) || !rootArg || (!['doctor', 'connect', 'disconnect'].includes(command) && !argument)) throw new Error('用法：doctor|connect|disconnect 数据目录；import|review 数据目录 导入清单.json|成片登记ID；shot 数据目录 成片组ID 镜头ID；rework 数据目录 成片组ID 镜头ID 命令.json；current 数据目录 成片组ID；propose 数据目录 成片组ID 提案.json；begin 数据目录 开工.json；production 数据目录 制作批次ID；sync 数据目录 制作片号ID 同步.json');
  const root = fs.realpathSync(rootArg);
  if (['doctor', 'connect', 'disconnect'].includes(command) && argument !== undefined) throw new Error('该命令只接受数据目录');
  if (command === 'disconnect') { const { unregisterLauncher } = await import('./reassembled-launch.mjs'); console.log(JSON.stringify(unregisterLauncher(root), null, 2)); process.exit(0); }
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(root, 'storage/run/electron-service.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('未发现运行中的 Creative Studio 桌面版。请先安装或启动桌面版，确认它使用同一数据目录，再运行 doctor；尚未创建项目或提交任务。');
    throw new Error('桌面服务状态无法读取，请重新启动桌面版后运行 doctor；尚未创建项目或提交任务。');
  }
  if (!state || typeof state.origin !== 'string' || typeof state.instanceId !== 'string' || !state.instanceId) throw new Error('桌面服务状态不完整，请重新启动桌面版后运行 doctor');
  const url = new URL(state.origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || state.origin !== url.origin) throw new Error('桌面实例地址不是本机地址');
  const read = async (response) => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || result.error || `HTTP ${response.status}`);
    return result;
  };
  let identity;
  try { identity = await read(await fetch(`${url.origin}/api/reassembled-films/capabilities`, { signal: AbortSignal.timeout(10000) })); }
  catch { throw new Error('无法连接该桌面实例，请确认桌面版已启动并使用同一数据目录，再运行 doctor；尚未创建项目或提交任务。'); }
  const dataIdentity = createHash('sha256').update(root).digest('hex');
  if (identity.instanceId !== state.instanceId || identity.dataIdentity !== dataIdentity || identity.apiVersion !== 1) throw new Error('桌面实例或数据目录身份不匹配，请重启发现流程');
  if (command === 'doctor') console.log(JSON.stringify(identity, null, 2));
  else if (command === 'connect') { const { registerLauncher } = await import('./reassembled-launch.mjs'); console.log(JSON.stringify(await registerLauncher(root), null, 2)); }
  else {
    if (['begin', 'production', 'sync'].includes(command)) {
      if (!identity.capabilities?.includes('film-production-sync/1')) throw new Error('当前桌面尚未支持制作过程同步，请更新应用');
      if (command !== 'begin' && (!/^[a-zA-Z0-9_-]{1,128}$/.test(argument) || (command === 'sync' && !clipId))) throw new Error('请明确制作身份和同步文件');
    }
    if (command === 'current' || command === 'propose') {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(argument) || (command === 'propose' && !clipId)) throw new Error('请明确成片组和提案文件');
      if (!identity.capabilities?.includes('film-content-proposals/1')) throw new Error('当前桌面尚未支持成片内容提案，请更新应用');
    }
    if (command === 'shot' || command === 'rework') {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(argument) || !clipId || clipId.length > 128 || (command === 'rework' && !commandFile)) throw new Error('请明确成片组、镜头 ID 和返工命令文件');
      if (!identity.capabilities?.includes('shot-rework-candidates/1')) throw new Error('当前桌面尚未支持 P2 返工，请更新应用');
    }
    if (command === 'review' && !/^[a-zA-Z0-9_-]{1,128}$/.test(argument)) throw new Error('成片登记 ID 无效');
    const token = fs.readFileSync(path.join(root, 'storage/run/reassembled-agent-token'), 'utf8').trim();
    const endpoint = command === 'begin' ? '/api/reassembled-films/productions' : command === 'production' ? `/api/reassembled-films/productions/${encodeURIComponent(argument)}` : command === 'sync' ? `/api/reassembled-films/productions/items/${encodeURIComponent(argument)}` : command === 'current' || command === 'propose' ? `/api/final-edit-groups/${encodeURIComponent(argument)}/film-content` : command === 'shot' || command === 'rework'
      ? `/api/final-edit-groups/${encodeURIComponent(argument)}/rework/${encodeURIComponent(clipId)}`
      : `/api/reassembled-films/${command === 'import' ? 'import' : `${argument}/review`}`;
    const result = await read(await fetch(`${url.origin}${endpoint}`, {
      method: ['shot', 'current', 'production'].includes(command) ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Reassembled-Token': token, 'X-Desktop-Instance': identity.instanceId, 'X-Data-Identity': dataIdentity },
      ...(['import', 'begin'].includes(command) ? { body: fs.readFileSync(argument, 'utf8') } : command === 'rework' ? { body: fs.readFileSync(commandFile, 'utf8') } : ['propose', 'sync'].includes(command) ? { body: fs.readFileSync(clipId, 'utf8') } : {}), signal: AbortSignal.timeout(300000),
    }));
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
