/**
 * 公司网关 /v1/videos 字段识别探测（只读诊断，不产生计费任务）。
 *
 * 原理（2026-08-17 实测确认）：网关把不认识的字段原样转发给腾讯校验，
 * 参数校验阶段的 400 在任务创建前返回，不创建任务、不计费。
 * 给候选字段传故意非法的值：
 *   - 报「参数不认识」→ 字段不存在；
 *   - 报「值非法/类型错误」→ 字段被认下，可进入真实任务验证。
 *
 * 密钥从本机数据库读取，不打印；响应原文只截前 500 字符。
 * 用法：先启动 LiteLLM sidecar，再 node scripts/company-gateway-field-probe.mjs
 */
import Database from 'better-sqlite3';

const db = new Database('data/workbench.db', { readonly: true });
const provider = db
  .prepare("SELECT apiKey, baseUrl FROM video_providers WHERE defaultModel = 'kling-3.0' AND type = 'openai-video'")
  .get();
db.close();
if (!provider?.apiKey || !provider?.baseUrl) {
  console.error('未找到公司可灵供应商配置（kling-3.0 / openai-video）');
  process.exit(1);
}
const base = provider.baseUrl.replace(/\/$/, '');

// 基底字段都是网关已认的已知好形状；images 用假 URL——只要候选字段触发
// 校验失败，请求就会在创建任务前 400，不会走到拉取图片那一步。
const BASE_BODY = {
  model: 'kling-3.0',
  prompt: 'field recognition probe',
  seconds: '5',
  images: ['https://example.com/probe-first.png'],
};

const PROBES = [
  ['LastFrameUrl: 123（腾讯原生字段）', { LastFrameUrl: 123 }],
  ['OutputConfig: 字符串（腾讯原生字段）', { OutputConfig: 'invalid-not-an-object' }],
  ['last_frame_url: 123（snake_case 变体）', { last_frame_url: 123 }],
  ['lastFrameUrl: 123（camelCase 变体）', { lastFrameUrl: 123 }],
];

for (const [label, extra] of PROBES) {
  console.log(`\n=== ${label} ===`);
  try {
    const res = await fetch(`${base}/v1/videos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({ ...BASE_BODY, ...extra }),
    });
    const text = await res.text();
    console.log('HTTP', res.status);
    console.log(text.slice(0, 500));
  } catch (error) {
    console.log('请求失败：', error instanceof Error ? error.message : error);
  }
}
