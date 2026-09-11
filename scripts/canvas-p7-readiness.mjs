#!/usr/bin/env node
/**
 * P7 真实样本前置检查（执行任务书 P7 第 2 条）。
 *
 * 只读、不发起任何真实模型调用、不上传素材：
 * - 画布数据根与供应商路由是否指向画布自己的 4100 代理；
 * - 两个必需模型别名是否在代理的模型列表里；
 * - COS 是否已配置（只看「有没有」，绝不打印密钥或签名）；
 * - 画布开关与执行器模式是否符合真实验收要求。
 *
 * 用法：node scripts/canvas-p7-readiness.mjs
 * 退出码：0 全部就绪；1 有阻塞项（逐条列出）。
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const repoRoot = process.cwd();
const dataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT || repoRoot;
const dbPath = path.join(dataRoot, 'data', 'workbench.db');

const blockers = [];
const notes = [];

function line(label, value) {
  console.log(`${label.padEnd(28)} ${value}`);
}

console.log('=== 画布 P7 前置检查（只读，不发起真实调用） ===\n');
line('数据根', dataRoot);
line('数据库', fs.existsSync(dbPath) ? dbPath : `${dbPath}（不存在）`);
if (!fs.existsSync(dbPath)) blockers.push('画布数据库不存在：先启动一次画布（会创建表结构）');

// 1. 供应商路由
const requiredVideoProviders = [
  { id: 'company-qiniuyun-kling-3-0', model: 'qiniuyun/kling-3.0', label: '七牛可灵 3.0（必需）' },
  { id: 'company-seedance-2-5', model: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5（必需）' },
];
const optionalVideoProviders = [
  { id: 'company-kling-3-0', model: 'kling-3.0', label: '腾讯可灵 3.0' },
  { id: 'company-seedance-2-0-fast', model: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast' },
];
// 画布当前注册的图片模型（qiniuyun 图片路由在 config.yaml 里不存在，未注册）
const imageProviders = [
  { id: 'company-gateway-image2-medium', model: 'image2-medium', label: 'image2-medium（R01/R02 用）' },
];

if (fs.existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    line('视频供应商', '');
    for (const entry of [...requiredVideoProviders, ...optionalVideoProviders]) {
      const row = db.prepare(
        `SELECT id, name, defaultModel, baseUrl, enabled FROM video_providers WHERE id = ?`,
      ).get(entry.id);
      const state = !row
        ? '缺失'
        : Number(row.enabled) !== 1
          ? '已停用'
          : String(row.baseUrl).includes(':4100')
            ? '就绪（4100）'
            : `路由异常：${row.baseUrl}`;
      line(`  ${entry.label}`, state);
      if (!row && entry.label.includes('必需')) blockers.push(`缺少公司供应商行：${entry.id}`);
      if (row && Number(row.enabled) !== 1 && entry.label.includes('必需')) {
        blockers.push(`公司供应商被停用：${entry.id}`);
      }
      if (row && !String(row.baseUrl).includes(':4100')) {
        blockers.push(`${entry.id} 的 baseUrl 不是画布独立代理：${row.baseUrl}`);
      }
    }
    line('图片供应商', '');
    for (const entry of imageProviders) {
      const row = db.prepare(
        `SELECT id, name, model, baseUrl, enabled FROM providers WHERE id = ?`,
      ).get(entry.id);
      const state = !row
        ? '缺失'
        : Number(row.enabled) !== 1
          ? '已停用'
          : String(row.baseUrl).includes(':4100')
            ? '就绪（4100）'
            : `路由异常：${row.baseUrl}`;
      line(`  ${entry.label}`, state);
      if (row && !String(row.baseUrl).includes(':4100')) {
        blockers.push(`${entry.id} 的 baseUrl 不是画布独立代理：${row.baseUrl}`);
      }
    }
  } finally {
    db.close();
  }
}

// 2. 画布开关与执行器
const enable = process.env.CREATIVE_STUDIO_CANVAS_ENABLE ?? '(未设置)';
const executor = process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR ?? '(未设置)';
line('画布开关', enable);
line('执行器', executor);
notes.push('真实样本必须用 CREATIVE_STUDIO_CANVAS_ENABLE=1 与 CREATIVE_STUDIO_CANVAS_EXECUTOR=company 启动；'
  + 'fixture 产物不等于真实模型能力。');

// 3. COS 配置（只看存在性）
const envFile = path.join(repoRoot, '.env.local');
let cosKeys = { id: false, key: false, domain: false };
if (fs.existsSync(envFile)) {
  const text = fs.readFileSync(envFile, 'utf8');
  cosKeys = {
    id: /CREATIVE_STUDIO_COS_SECRET_ID\s*=\s*\S+/.test(text),
    key: /CREATIVE_STUDIO_COS_SECRET_KEY\s*=\s*\S+/.test(text),
    domain: /CREATIVE_STUDIO_COS_DOMAIN\s*=\s*\S+/.test(text),
  };
}
line('.env.local', fs.existsSync(envFile) ? '存在' : '不存在');
line('COS 配置', `secretId=${cosKeys.id ? 'set' : 'unset'} secretKey=${cosKeys.key ? 'set' : 'unset'} domain=${cosKeys.domain ? 'set' : 'unset'}`);
if (!cosKeys.id || !cosKeys.key || !cosKeys.domain) {
  blockers.push('COS 未配置完整：七牛渠道与公司尾帧会在 POST 前 fail closed（R05 无法执行）');
}

// 3.5 代理前置文件（只读；不打印 config.yaml 内容）
const venvPython = path.join(repoRoot, '.venv-litellm', 'bin', 'python');
const configPath = path.join(repoRoot, 'config.yaml');
line('.venv-litellm', fs.existsSync(venvPython) ? '存在' : '缺失');
line('config.yaml', fs.existsSync(configPath) ? '存在' : '缺失');
if (!fs.existsSync(venvPython) || !fs.existsSync(configPath)) {
  blockers.push('独立代理组件缺失（.venv-litellm 或 config.yaml）：4100 无法启动');
} else {
  const configText = fs.readFileSync(configPath, 'utf8');
  for (const alias of ['qiniuyun/kling-3.0', 'doubao-seedance-2-5-260628', 'image2-medium']) {
    const present = configText.includes(alias);
    line(`  路由 ${alias}`, present ? '在 config.yaml 内' : '**不在 config.yaml 内**');
    if (!present) blockers.push(`config.yaml 缺少模型路由：${alias}`);
  }
}

// 4. 代理健康与模型列表
const proxy = 'http://127.0.0.1:4100';
async function probeProxy() {
  try {
    const health = await fetch(`${proxy}/health/liveliness`, { signal: AbortSignal.timeout(2_000) });
    line('4100 健康', String(health.status));
    if (!health.ok) blockers.push(`4100 代理健康检查失败：${health.status}`);
  } catch (error) {
    line('4100 健康', `不可达（${error instanceof Error ? error.message : error}）`);
    blockers.push('4100 代理未运行：真实样本前需用画布入口启动（不要复用 3000/4000 实例）');
    return;
  }
  try {
    const response = await fetch(`${proxy}/v1/models`, { signal: AbortSignal.timeout(5_000) });
    const payload = await response.json();
    const ids = new Set((payload?.data ?? []).map((entry) => entry?.id));
    for (const entry of [...requiredVideoProviders, ...imageProviders]) {
      const present = ids.has(entry.model);
      line(`  模型 ${entry.model}`, present ? '在列表内' : '**不在列表内**');
      if (!present && entry.model === 'image2-medium') {
        blockers.push('代理模型列表缺少 image2-medium（R01/R02 必需）');
      }
      if (!present && entry.model === 'qiniuyun/kling-3.0') {
        blockers.push('代理模型列表缺少 qiniuyun/kling-3.0（R05 必需）');
      }
    }
  } catch (error) {
    notes.push(`无法读取模型列表：${error instanceof Error ? error.message : error}`);
  }
}
await probeProxy();

// 4.5 公司网关可达性：光有本地代理不够，公司网关不可达时任何真实样本都会 500
const GATEWAY_HOST = 'llm-gateway-idc.linshimuye.com';
try {
  const dns = await import('node:dns/promises');
  const net = await import('node:net');
  const addresses = await dns.lookup(GATEWAY_HOST, { all: true });
  const reachable = await new Promise((resolve) => {
    const socket = net.connect({ host: GATEWAY_HOST, port: 443 });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(4_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
  // TCP 通不等于 HTTPS 通：代理客户端 TUN／全局路由会在 TLS 层截流，
  // 只报 TCP 会得到「可达」的假象（本次 R01 就是这样失败的）。
  let httpsResult = '未测试';
  if (reachable) {
    try {
      const response = await fetch(`https://${GATEWAY_HOST}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(6_000),
      });
      httpsResult = `HTTPS ${response.status}`;
    } catch (error) {
      httpsResult = `HTTPS 失败（${error instanceof Error ? error.message : error}）`;
    }
  }
  line('公司网关', reachable ? `TCP 可达（${addresses.length} 个地址）；${httpsResult}` : `TCP 不可达（DNS ${addresses.length} 个地址）`);
  if (reachable && httpsResult !== '未测试' && !httpsResult.startsWith('HTTPS 2') && !httpsResult.startsWith('HTTPS 3') && !httpsResult.startsWith('HTTPS 4')) {
    blockers.push(
      `公司网关 HTTPS 不可用（${httpsResult}）：本机代理客户端或路由层可能截流了公司网关请求；`
      + '真实样本会在提交阶段 500，P7 不具备执行条件（本次 R01 实测已证实）。',
    );
  }
  if (!reachable) {
    blockers.push(
      '公司网关不可达：当前不在公司内网或网关未开放，任何真实样本都会在提交阶段 500，'
      + 'P7 不具备执行条件（本次实测已证实，见执行记录 R01 尝试）。',
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  line('公司网关', `DNS 解析失败（${message}）`);
  blockers.push(`公司网关域名解析失败：${message}；P7 不具备执行条件`);
}

// 5. 结论
console.log('\n=== 结论 ===');
if (blockers.length === 0) {
  console.log('前置检查通过。仍需用户确认：真实调用授权、样本素材路径、是否允许上传 COS。');
} else {
  console.log('存在阻塞项：');
  for (const item of blockers) console.log(`  - ${item}`);
}
if (notes.length > 0) {
  console.log('\n提示：');
  for (const item of notes) console.log(`  - ${item}`);
}
process.exit(blockers.length === 0 ? 0 : 1);
