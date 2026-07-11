// lib/final-video/vision.ts
/**
 * 源图视觉识别：复用现有 script_providers 凭据体系（供应商需 supportsVision=1），
 * 按 (imageAssetId, providerId, model) 缓存到 clip_visual_descriptions，普通运行命中即跳过，
 * 显式 force=true 才重新调用远程模型并覆盖。只描述实际源图像素，不读取/依赖 script_drafts
 * 里的 visualIntent、voiceover 等旧字段。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getDb } from '../db.ts';
import { dataRoot } from '../data-root.ts';
import { assertPathWithinRoot } from './fs-safety.ts';
import { resolveStoredScriptProvider, getScriptProviderDefaults } from '../script-providers/store.ts';
import { describeImageOpenAiCompatible } from '../script-providers/openai-compatible.ts';
import { describeImageGeminiNative } from '../script-providers/gemini.ts';
import type { ClipPoolItem } from './types.ts';

const VISION_TIMEOUT_MS = 90_000;
const MAX_INLINE_BYTES = 4 * 1024 * 1024; // 4MB
const MAX_LONGEST_SIDE = 1600;
const VISION_CONCURRENCY = 2;

const VISION_PROMPT = '请描述这张电商产品图片的实际画面内容：主体、动作或姿态、场景/背景、构图与光线氛围。只描述画面本身，不要编造画面中不存在的信息，不要输出与画面无关的营销文案。用简体中文回答，控制在 100 字以内。';

/** Same extension→MIME map as app/api/images/[...path]/route.ts; anything else defaults to jpeg. */
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function assertInsideDataRoot(imagePath: string): string {
  const resolved = path.resolve(imagePath);
  return assertPathWithinRoot(path.resolve(dataRoot()), resolved, '图片路径不在数据目录内');
}

/**
 * 读取源图并转 base64。原图 <= 4MB 直接按扩展名推断 MIME 使用原字节；超过 4MB 时用 sharp
 * 缩放到最长边 1600px 并重新编码为 jpeg（quality 85），此时 mimeType 固定为 image/jpeg。
 */
async function loadImageForVision(imagePath: string): Promise<{ base64: string; mimeType: string }> {
  const resolved = assertInsideDataRoot(imagePath);
  const original = fs.readFileSync(resolved);

  if (original.byteLength <= MAX_INLINE_BYTES) {
    const ext = path.extname(resolved).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES[ext] || 'image/jpeg';
    return { base64: original.toString('base64'), mimeType };
  }

  const resized = await sharp(original)
    .resize({ width: MAX_LONGEST_SIDE, height: MAX_LONGEST_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { base64: resized.toString('base64'), mimeType: 'image/jpeg' };
}

interface CachedDescriptionRow { description: string }

function getCachedDescription(imageAssetId: string, providerId: string, model: string): string | null {
  const row = getDb()
    .prepare(`SELECT description FROM clip_visual_descriptions WHERE imageAssetId = ? AND providerId = ? AND model = ?`)
    .get(imageAssetId, providerId, model) as CachedDescriptionRow | undefined;
  return row ? row.description : null;
}

function upsertDescription(imageAssetId: string, providerId: string, model: string, description: string): void {
  getDb().prepare(`
    INSERT INTO clip_visual_descriptions (id, imageAssetId, description, providerId, model)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(imageAssetId, providerId, model) DO UPDATE SET description = excluded.description, updatedAt = datetime('now')
  `).run(randomUUID(), imageAssetId, description, providerId, model);
}

/**
 * 描述单张源图，命中缓存即跳过远程调用；force=true 强制重新调用并覆盖缓存。
 * 远程调用固定 90s 超时；provider 必须 supportsVision 且 configured，否则在发起任何网络请求前抛错。
 */
export async function describeClipImage(input: {
  imageAssetId: string;
  imagePath: string;
  providerId: string;
  force?: boolean;
}): Promise<{ description: string; model: string }> {
  const runtime = resolveStoredScriptProvider(input.providerId);
  if (!runtime.supportsVision) throw new Error(`${runtime.name} 未开启图片理解能力`);
  if (!runtime.configured) throw new Error(`${runtime.name} 未配置完整：${runtime.missing.join(', ')}`);

  if (!input.force) {
    const cached = getCachedDescription(input.imageAssetId, input.providerId, runtime.model);
    if (cached !== null) return { description: cached, model: runtime.model };
  }

  const { base64, mimeType } = await loadImageForVision(input.imagePath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const description = (runtime.apiStyle === 'native-gemini'
      ? await describeImageGeminiNative({ prompt: VISION_PROMPT, imageBase64: base64, mimeType }, runtime, controller.signal)
      : await describeImageOpenAiCompatible(getScriptProviderDefaults(input.providerId), { prompt: VISION_PROMPT, imageBase64: base64, mimeType }, runtime, controller.signal)
    ).trim();
    if (!description) throw new Error(`${runtime.name} 返回了空描述`);
    upsertDescription(input.imageAssetId, input.providerId, runtime.model, description);
    return { description, model: runtime.model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发 2 描述整个候选池。单图失败只记入 failures，不影响其它图片；失败的 clip 原样返回
 * （不清空已有 visualDescription），成功的 clip 返回带新 description 的拷贝。返回顺序与
 * 输入顺序一致，与并发完成顺序无关。
 */
export async function describeClipPool(input: {
  clips: ClipPoolItem[];
  providerId: string;
  force?: boolean;
}): Promise<{ clips: ClipPoolItem[]; failures: Array<{ clipId: string; message: string }> }> {
  const results: ClipPoolItem[] = [...input.clips];
  const failures: Array<{ clipId: string; message: string }> = [];

  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.clips.length) return;
      const clip = input.clips[index];
      try {
        const { description, model } = await describeClipImage({
          imageAssetId: clip.sourceImageId,
          imagePath: clip.sourceImagePath,
          providerId: input.providerId,
          force: input.force,
        });
        results[index] = {
          ...clip,
          visualDescription: description,
          descriptionProviderId: input.providerId,
          descriptionModel: model,
        };
      } catch (error) {
        failures.push({ clipId: clip.clipId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const workerCount = Math.min(VISION_CONCURRENCY, input.clips.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { clips: results, failures };
}
