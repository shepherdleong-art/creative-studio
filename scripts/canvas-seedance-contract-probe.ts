/** Default is dry-run. Execute only after the user approves this exact one-request batch and charging terms.
 * No media upload. One generation POST, no retries; durable intent prevents accidental reruns.
 * Reject hard budget constraints because the gateway cannot enforce a monetary cap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../lib/data-root.ts';

const body = { model: 'doubao-seedance-2-5-260628', prompt: '白色背景上一只蓝色立方体缓慢旋转', seconds: '4', resolution: '480p' };
const execute = process.argv.includes('--execute');
const budget = Number(process.argv.find((arg) => arg.startsWith('--approved-budget-cny='))?.split('=')[1]);
const baseUrl = process.env.CREATIVE_STUDIO_CANVAS_PROBE_BASE_URL ?? `http://127.0.0.1:${process.env.CREATIVE_STUDIO_LITELLM_PORT || '4000'}`;
const url = new URL(baseUrl);
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/') throw new Error('探测只允许当前画布本机代理（默认 127.0.0.1:4000）');
const receiptPath = path.join(dataRoot(), 'outputs', 'canvas-validation', 'company-25-480p-probe.receipt.json');
if (!execute) {
  console.log(JSON.stringify({ dryRun: true, postCount: 1, endpoint: `${baseUrl}/v1/videos`, body, receiptPath, note: '可能创建任务并计费；尚未执行。预算需要用户确认，网关无硬金额限额。' }, null, 2));
} else {
  if (!process.argv.includes('--acknowledge-paid-request')) throw new Error('必须先获得用户对这一次付费请求的明确授权，再填写 --acknowledge-paid-request');
  if (Number.isFinite(budget)) throw new Error('网关不支持硬金额上限，带预算上限的请求不能执行；需先澄清计费约束');
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const intent = { state: 'maybe_sent', startedAt: new Date().toISOString(), chargingAcknowledged: true, historicalEstimateCny: 7.56, body, postCount: 1 };
  fs.writeFileSync(receiptPath, JSON.stringify(intent, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    const response = await fetch(`${baseUrl}/v1/videos`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer litellm-local-passthrough' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
    const value = await response.json() as { id?: unknown; task_id?: unknown };
    const id = typeof value.id === 'string' ? value.id : typeof value.task_id === 'string' ? value.task_id : null;
    // Never store raw error bodies or signed URLs. Missing ID is uncertain even on a successful response.
    const receipt = { ...intent, state: id ? 'accepted' : response.status >= 400 && response.status < 500 ? 'rejected' : 'uncertain', httpStatus: response.status, providerTaskId: id, stoppedAt: new Date().toISOString() };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(receipt, null, 2));
  } catch {
    fs.writeFileSync(receiptPath, JSON.stringify({ ...intent, state: 'uncertain', stoppedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    throw new Error('探测结果不明，已停止；禁止自动重试，请先核查回执和供应商任务');
  }
}
