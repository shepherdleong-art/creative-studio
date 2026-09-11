#!/usr/bin/env node
/**
 * P7 受控真实样本驱动（对运行中的画布实例发真实生成请求）。
 *
 * 用法：
 *   node scripts/canvas-p7-sample.mjs R01
 *   node scripts/canvas-p7-sample.mjs R02 [--images a.png,b.png]
 *
 * 约定（验收清单 §5）：
 * - 每个样本只提交一次，不做并行盲重试；
 * - 记录 taskId、远端 ID、精确模型、输入摘要、本地产物与规格；
 * - 产物落到 outputs/canvas-validation/p7/ 供人工预览，摘要追加到同目录的 samples.jsonl；
 * - 登录密钥、签名地址一律不打印。
 *
 * 前置：画布实例已用 CREATIVE_STUDIO_CANVAS_ENABLE=1 与
 *      CREATIVE_STUDIO_CANVAS_EXECUTOR=company 启动，且 canvas-p7-readiness.mjs 零阻塞。
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const BASE = process.env.CANVAS_BASE_URL || 'http://127.0.0.1:3100';
const OUT_DIR = path.join(process.cwd(), 'outputs', 'canvas-validation', 'p7');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sampleId = (process.argv[2] || '').toUpperCase();
const imagesArgIndex = process.argv.indexOf('--images');
const imagePaths = imagesArgIndex >= 0 ? (process.argv[imagesArgIndex + 1] || '').split(',').filter(Boolean) : [];

/** 目前可用的公司模型（七牛与 Seedance 2.5 因不在公司内网暂不可用，见执行记录）。 */
const SAMPLES = {
  R01: {
    title: 'P7 R01 文生图',
    kind: 'image',
    modelKey: 'external-packy-gpt-image-2',
    generationMode: 'text-to-image',
    prompt: '一张浅色布艺三人沙发，放在午后阳光的客厅里，简洁自然光，产品摄影',
    parameters: { aspectRatio: '3:4', resolution: '2K' },
    mode: 'single',
  },
  R02: {
    title: 'P7 R02 图生图与多参考',
    kind: 'image',
    modelKey: 'external-packy-gpt-image-2',
    generationMode: 'image-to-image',
    prompt: '把 @参考1 的沙发放到 @参考2 的客厅场景里，保持沙发主体与材质不变，光线柔和',
    parameters: { aspectRatio: '3:4', resolution: '1K' },
    mode: 'single',
  },
  R03: {
    title: 'P7 R03 文生视频',
    kind: 'video',
    modelKey: 'external-jimeng-seedance-2-0',
    generationMode: 'text-to-video',
    prompt: '镜头缓慢推近米白色布艺沙发，展现织物纹理，稳定运镜，客厅自然光',
    parameters: { durationSec: 5, aspectRatio: '16:9' },
    mode: 'single',
  },
  R04: {
    title: 'P7 R04 图生视频',
    kind: 'video',
    modelKey: 'external-jimeng-seedance-2-0',
    generationMode: 'image-to-video',
    prompt: '镜头围绕沙发缓慢横移，保持产品形态稳定',
    parameters: { durationSec: 5 },
    mode: 'single',
  },
  R07: {
    title: 'P7 R07 视频生视频（参考视频 + 参考图 + 参考音频）',
    kind: 'video',
    modelKey: 'external-jimeng-seedance-2-0',
    generationMode: 'video-to-video',
    prompt: '参考 @参考1 的运镜与节奏，把 @参考2 里的沙发放进明亮客厅，产品形态稳定；参考音频只作为节奏提示',
    parameters: { durationSec: 5, aspectRatio: '16:9' },
    mode: 'single',
    // 三类素材一次提交：验证 reference_video／reference_image／reference_audio 三种 content 项
    materials: [
      { kind: 'video', role: 'reference' },
      { kind: 'image', role: 'subject' },
      { kind: 'audio', role: 'audio' },
    ],
  },
  R08: {
    title: 'P7 R08 参考生成（多模态参考图）',
    kind: 'video',
    modelKey: 'external-jimeng-seedance-2-0',
    generationMode: 'reference-to-video',
    prompt: '以 @参考1 的沙发为主体，参考 @参考2 的客厅光线与色调，生成一段自然运镜的产品视频',
    parameters: { durationSec: 5, aspectRatio: '16:9' },
    mode: 'single',
    materials: [
      { kind: 'image', role: 'subject' },
      { kind: 'image', role: 'scene' },
    ],
  },
  R09: {
    title: 'P7 R09 首尾帧（两张图都必须带角色）',
    kind: 'video',
    modelKey: 'external-jimeng-seedance-2-0',
    generationMode: 'image-to-video',
    prompt: '从 @参考1 的画面自然过渡到 @参考2 的画面，稳定运镜',
    parameters: { durationSec: 5 },
    mode: 'single',
    materials: [
      { kind: 'image', role: 'first-frame' },
      { kind: 'image', role: 'last-frame' },
    ],
  },
};

const sample = SAMPLES[sampleId];
if (!sample) {
  console.error(`未知样本：${sampleId || '(空)'}。可用：${Object.keys(SAMPLES).join('、')}`);
  process.exit(2);
}

async function api(pathname, init) {
  // FormData 上传不能带 content-type：boundary 由 fetch 自己生成
  const isForm = init?.body instanceof FormData;
  const response = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { ...(isForm ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${pathname} -> ${response.status} ${payload.message ?? text.slice(0, 200)}`);
  }
  return payload;
}

/** 合成素材：用户已同意先用合成图跑通链路，不代表画面质量验收。 */
async function ensureSyntheticImages() {
  if (imagePaths.length > 0) return imagePaths;
  const first = path.join(OUT_DIR, 'sample-sofa-a.png');
  const second = path.join(OUT_DIR, 'sample-room-b.png');
  if (!fs.existsSync(first)) {
    fs.writeFileSync(first, await sharp({
      create: { width: 768, height: 1024, channels: 3, background: '#c9b79c' },
    }).png().toBuffer());
  }
  if (!fs.existsSync(second)) {
    fs.writeFileSync(second, await sharp({
      create: { width: 768, height: 1024, channels: 3, background: '#dfe6ea' },
    }).png().toBuffer());
  }
  return [first, second];
}

/** 参考视频来源：默认复用 R04 的真实产物（5 秒，落在方舟参考视频 2–15 秒区间内）。 */
function findReferenceVideo() {
  if (process.env.CANVAS_SAMPLE_VIDEO) return process.env.CANVAS_SAMPLE_VIDEO;
  const candidates = fs.readdirSync(OUT_DIR).filter((name) => /^R04-.*\.mp4$/.test(name)).sort();
  if (candidates.length === 0) {
    throw new Error('缺少参考视频：先跑 R04 产出产物，或设置 CANVAS_SAMPLE_VIDEO=<mp4 路径>。');
  }
  return path.join(OUT_DIR, candidates[candidates.length - 1]);
}

/** 合成参考音频：手写 PCM WAV，时长可被 ffprobe 探出（方舟要求单段 2–15 秒）。 */
function ensureSyntheticAudio(seconds = 3) {
  const target = path.join(OUT_DIR, `sample-tone-${seconds}s.wav`);
  if (fs.existsSync(target)) return target;
  const sampleRate = 8000;
  const samples = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 8000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(target, Buffer.concat([header, data]));
  return target;
}

/** 按样本声明的素材清单解析本地文件：图片走合成图（可被 --images 覆盖），视频／音频各有来源。 */
async function resolveMaterialSource(spec, index) {
  if (spec.kind === 'image') {
    const files = await ensureSyntheticImages();
    const file = files[Math.min(index, files.length - 1)];
    return { file, mimeType: file.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }
  if (spec.kind === 'video') return { file: findReferenceVideo(), mimeType: 'video/mp4' };
  if (spec.kind === 'audio') return { file: ensureSyntheticAudio(), mimeType: 'audio/wav' };
  throw new Error(`未知素材类型：${spec.kind}`);
}

/** 旧样本（R01–R04）用的固定素材：图片列表，或视频样本的首帧。 */
async function legacyMaterials() {
  if (sample.generationMode === 'text-to-image' || sample.generationMode === 'text-to-video') return [];
  const files = await ensureSyntheticImages();
  const wanted = sample.kind === 'video' ? files.slice(0, 1) : files;
  const roles = sample.kind === 'video' ? ['first-frame'] : ['subject', 'scene'];
  return wanted.map((file, index) => ({
    file,
    mimeType: 'image/png',
    kind: 'image',
    role: roles[index] ?? 'reference',
  }));
}

const startedAt = new Date().toISOString();
const { canvas } = await api('/api/canvas', { method: 'POST', body: JSON.stringify({ name: sample.title }) });
const canvasId = canvas.id;
console.log(`[${sampleId}] 画布已创建 ${canvasId}`);

const materialSpecs = [];
if (sample.materials) {
  for (const [index, spec] of sample.materials.entries()) {
    materialSpecs.push({ ...spec, ...(await resolveMaterialSource(spec, index)) });
  }
} else {
  materialSpecs.push(...await legacyMaterials());
}

const materials = [];
for (const [index, spec] of materialSpecs.entries()) {
  const form = new FormData();
  form.append('file', new File([fs.readFileSync(spec.file)], path.basename(spec.file), { type: spec.mimeType }));
  const uploaded = await api(`/api/canvas/${canvasId}/assets`, { method: 'POST', body: form });
  materials.push({
    nodeId: `m${index + 1}`,
    assetId: uploaded.asset.id,
    filename: path.basename(spec.file),
    bytes: uploaded.asset.byteSize,
    mediaKind: spec.kind,
    role: spec.role,
  });
}

const nodes = [
  ...materials.map((entry, index) => ({
    id: entry.nodeId,
    kind: 'material',
    position: { x: 0, y: index * 240 },
    data: { title: entry.filename, assetId: entry.assetId, mediaKind: entry.mediaKind },
  })),
  {
    id: 'g1',
    kind: sample.kind === 'video' ? 'video-generation' : 'image-generation',
    position: { x: 420, y: 0 },
    data: {
      title: sampleId,
      modelKey: sample.modelKey,
      generationMode: sample.generationMode,
      prompt: sample.prompt,
      parameters: sample.parameters,
      references: [],
      referenceLabelCounter: 0,
    },
  },
];
const edges = materials.map((entry, index) => ({ id: `e${index + 1}`, source: entry.nodeId, target: 'g1' }));

const saved = await api(`/api/canvas/${canvasId}`, {
  method: 'PATCH',
  body: JSON.stringify({ expectedGraphRevision: canvas.graphRevision, graph: { schemaVersion: 1, nodes, edges } }),
});
const references = saved.canvas.graph.nodes.find((node) => node.id === 'g1')?.data?.references ?? [];
console.log(`[${sampleId}] 图已保存 revision=${saved.canvas.graphRevision}，参考槽位=${references.length}`);

// 显式标注用途：样本声明什么角色就写什么角色（首帧／尾帧／参考／音频）
{
  const rolesByNode = new Map(materials.map((entry) => [entry.nodeId, entry.role]));
  const graph = saved.canvas.graph;
  const target = graph.nodes.find((node) => node.id === 'g1');
  const needsPatch = Boolean(target) && references.some((slot) => (
    rolesByNode.has(slot.sourceNodeId) && slot.role !== rolesByNode.get(slot.sourceNodeId)
  ));
  if (target && needsPatch) {
    graph.nodes = graph.nodes.map((node) => (
      node.id === 'g1'
        ? {
          ...node,
          data: {
            ...node.data,
            references: node.data.references.map((slot) => ({
              ...slot,
              role: rolesByNode.get(slot.sourceNodeId) ?? slot.role,
            })),
          },
        }
        : node
    ));
    const roleSaved = await api(`/api/canvas/${canvasId}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedGraphRevision: saved.canvas.graphRevision, graph }),
    });
    saved.canvas.graphRevision = roleSaved.canvas.graphRevision;
    console.log(`[${sampleId}] 参考角色已写入：${[...rolesByNode.values()].join('、')}`);
  }
}

const run = await api(`/api/canvas/${canvasId}/runs`, {
  method: 'POST',
  body: JSON.stringify({ mode: 'single', targetNodeId: 'g1', expectedGraphRevision: saved.canvas.graphRevision, requestKey: `p7-${sampleId}-${Date.now()}` }),
});
const taskId = run.tasks[0].id;
console.log(`[${sampleId}] 任务已创建 taskId=${taskId} 计划=${run.plan.tasks[0].capabilityKey}`);

let task = null;
let nodeState = null;
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  const view = await api(`/api/canvas/${canvasId}`);
  task = (view.canvas.tasks ?? []).find((entry) => entry.id === taskId) ?? null;
  nodeState = (view.canvas.nodeStates ?? []).find((entry) => entry.nodeId === 'g1') ?? null;
  if (task && ['succeeded', 'failed', 'blocked', 'cancelled', 'uncertain', 'download_failed'].includes(task.phase)) break;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

const record = {
  sampleId,
  canvasId,
  taskId,
  startedAt,
  finishedAt: new Date().toISOString(),
  modelKey: sample.modelKey,
  generationMode: sample.generationMode,
  prompt: sample.prompt,
  parameters: sample.parameters,
  inputs: materials.map(({ filename, bytes, assetId, mediaKind, role }) => ({ filename, bytes, assetId, mediaKind, role })),
  providerTaskId: task?.providerTaskId ?? null,
  phase: task?.phase ?? 'timeout',
  errorCode: task?.errorCode ?? null,
  errorMessage: task?.errorMessage ?? null,
  outputAssetId: task?.outputAssetId ?? nodeState?.currentAssetId ?? null,
  localArtifact: null,
  artifactSpec: null,
};

if (record.outputAssetId) {
  const response = await fetch(`${BASE}/api/canvas/assets/${record.outputAssetId}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = sample.kind === 'video' ? 'mp4' : 'png';
  const artifactPath = path.join(OUT_DIR, `${sampleId}-${record.outputAssetId.slice(0, 8)}.${extension}`);
  fs.writeFileSync(artifactPath, buffer);
  record.localArtifact = path.relative(process.cwd(), artifactPath);
  if (sample.kind === 'image') {
    const metadata = await sharp(buffer).metadata();
    record.artifactSpec = { format: metadata.format, width: metadata.width, height: metadata.height, bytes: buffer.byteLength };
  } else {
    record.artifactSpec = { mimeType: response.headers.get('content-type'), bytes: buffer.byteLength };
  }
}

fs.appendFileSync(path.join(OUT_DIR, 'samples.jsonl'), `${JSON.stringify(record)}\n`);
console.log(`[${sampleId}] ${JSON.stringify(record, null, 2)}`);
process.exit(record.phase === 'succeeded' ? 0 : 1);
