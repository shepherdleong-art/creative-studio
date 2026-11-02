import { PACKY_IMAGE_MODEL_OPTIONS } from '../../image-model-capabilities.ts';
import { SEEDREAM_5_PRO, SEEDREAM_PROVIDER_ID, SEEDREAM_RATIOS } from '../../seedream-image.ts';
import { directSeedanceCapability } from './seedance-capabilities.ts';
import { SEEDANCE_20, SEEDANCE_25 } from '../../video-providers/seedance-contract.ts';
/**
 * 外部（非公司）供应商的画布能力表。
 *
 * **只注册真正可用的行**：数据库里存在、已启用、且已配置 API Key 的供应商才会出现在画布模型列表里。
 * 协议支持范围与仓库既有适配器一致，未支持的组合不注册（界面不开放提交必然失败的模型）。
 * 证据层级固定为 mapped（本地请求映射已验证），真实样例由 P7 样本补齐后才谈 verified。
 */

import type Database from 'better-sqlite3';
import type { CanvasModelCapability } from '../capabilities.ts';

interface ExternalModelSpec {
  providerId: string;
  table: 'providers' | 'video_providers';
  capability: CanvasModelCapability;
}

const EXTERNAL_MODEL_SPECS: ReadonlyArray<ExternalModelSpec> = [
  {
    providerId: SEEDREAM_PROVIDER_ID,
    table: 'providers',
    capability: {
      key: 'external-ark-seedream-5-0-pro', displayName: 'Seedream 5.0 Pro（方舟直连）',
      providerKind: 'external', providerIdentity: SEEDREAM_PROVIDER_ID, modelAlias: SEEDREAM_5_PRO,
      mediaKind: 'image', modes: ['text-to-image', 'image-to-image'],
      mediaInputMinimums: [{ modes: ['image-to-image'], min: 1, kinds: ['image'] }],
      inputs: [
        { kind: 'image', roles: ['subject', 'product', 'style', 'scene', 'reference'], min: 0, max: 10,
          mimeTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 30 * 1024 * 1024 },
        { kind: 'text', roles: ['reference'], min: 0, max: 1 },
      ],
      parameters: [
        { key: 'aspectRatio', label: '比例', type: 'enum', options: SEEDREAM_RATIOS, default: '1:1' },
        { key: 'resolution', label: '清晰度', type: 'enum', options: ['1K', '2K'], default: '2K' },
      ],
      cancellation: false, evidence: 'mapped',
      evidenceNote: '2026-10-07 按方舟官方 images/generations 协议接入；本地请求与恢复测试覆盖，未调用真实模型。',
    },
  },
  {
    providerId: 'packy-gpt-image-2',
    table: 'providers',
    capability: {
      key: 'external-packy-gpt-image-2',
      displayName: 'Packy GPT-Image-2',
      providerKind: 'external',
      providerIdentity: 'packy-gpt-image-2',
      modelAlias: 'gpt-image-2',
      mediaKind: 'image',
      modes: ['text-to-image', 'image-to-image'],
      inputs: [
        // 图1 = 待编辑底图，其后按节点顺序是参考图（不做自动提示词前缀）
        { kind: 'image', roles: ['subject', 'product', 'style', 'scene', 'reference'], min: 0, max: 6 },
        { kind: 'text', roles: ['reference'], min: 0, max: 1 },
      ],
      parameters: [
        { key: 'aspectRatio', label: '比例', type: 'enum', options: ['1:1', '3:4', '4:3', '16:9', '9:16'], default: '1:1' },
        { key: 'resolution', label: '清晰度', type: 'enum', options: ['1K', '2K', '4K'], default: '1K' },
      ],
      cancellation: false,
      evidence: 'verified',
      evidenceNote: '真实链路样例：R01 文生图（1728×2304 PNG）、R02 图生图＋双参考（864×1152 PNG），均经画布链路真实提交并归档到 outputs/canvas-validation/p7。4K 档位与 6 张以上参考图的组合未跑过，仍属文档依据。',
    },
  },
  { providerId: 'jimeng-2-0', table: 'video_providers', capability: directSeedanceCapability(SEEDANCE_20) },
  { providerId: 'jimeng-2-0', table: 'video_providers', capability: directSeedanceCapability(SEEDANCE_25) },
];

/** 只有「行存在 + 已启用 + 已配置 Key」的外部模型才注册，避免开放提交必然失败的入口。 */
export function registerExternalCanvasCapabilities(
  db: Database.Database,
  register: (capability: CanvasModelCapability) => unknown,
): string[] {
  const registered: string[] = [];
  const publish = (template: CanvasModelCapability, row: { id: string; name: string }, model = template.modelAlias) => {
    const canonical = row.id === template.providerIdentity && model === template.modelAlias;
    const capability: CanvasModelCapability = {
      ...template,
      key: canonical ? template.key : `${template.key}:provider:${encodeURIComponent(row.id)}:model:${encodeURIComponent(model)}`,
      providerIdentity: row.id, modelAlias: model,
      displayName: template.mediaKind === 'video' ? `${row.name} · ${model === SEEDANCE_25 ? 'Seedance 2.5' : 'Seedance 2.0'}` : row.name,
      ...(canonical ? {} : { evidence: 'mapped', evidenceNote: '复用已接入的精确模型协议；此供应商行尚未做真实画布生成验收。' }),
    };
    register(capability);
    registered.push(capability.key);
  };
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'providers'").get()) {
    const rows = db.prepare(`SELECT id, name, type, model FROM providers
      WHERE enabled = 1 AND length(trim(apiKey)) > 0 AND length(trim(baseUrl)) > 0 ORDER BY name, id`)
      .all() as Array<{ id: string; name: string; type: string; model: string }>;
    for (const row of rows) {
      const seedream = EXTERNAL_MODEL_SPECS.find((spec) => spec.providerId === SEEDREAM_PROVIDER_ID)!;
      const images = EXTERNAL_MODEL_SPECS.find((spec) => spec.capability.modelAlias === 'gpt-image-2')!;
      if (row.type === 'ark-images' && row.model === SEEDREAM_5_PRO) publish(seedream.capability, row);
      else if (['packy-images', 'openai-compatible'].includes(row.type) && PACKY_IMAGE_MODEL_OPTIONS.some((entry) => entry.model === row.model)) {
        publish(images.capability, row, row.model);
      } else if (row.type === 'packy-gemini-image' && PACKY_IMAGE_MODEL_OPTIONS.some((entry) => entry.model === row.model && entry.model.startsWith('gemini-'))) {
        publish({ ...images.capability, key: `external-gemini-image:${encodeURIComponent(row.model)}`,
          evidence: 'mapped', evidenceNote: '复用主项目 Gemini 图片聊天协议，提示词按画布原文提交。',
          parameters: images.capability.parameters.map((parameter) => parameter.key === 'resolution' && row.model.endsWith('-2k')
            ? { ...parameter, options: ['2K'], default: '2K' } : parameter),
        }, row, row.model);
      }
    }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'video_providers'").get()) {
    const rows = db.prepare(`SELECT id, name FROM video_providers
      WHERE type = 'jimeng' AND enabled = 1 AND length(trim(apiKey)) > 0 AND length(trim(baseUrl)) > 0 ORDER BY name, id`)
      .all() as Array<{ id: string; name: string }>;
    for (const row of rows) {
      for (const model of [SEEDANCE_20, SEEDANCE_25] as const) publish(directSeedanceCapability(model), row);
    }
  }
  return registered;
}
