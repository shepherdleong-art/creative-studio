import type Database from 'better-sqlite3';
import { companyImageCapsForModel } from '../../company-gateway-size.ts';
import type { CanvasModelCapability } from '../capabilities.ts';
import { COMPANY_CANVAS_IMAGE2_CAPABILITY, COMPANY_CANVAS_QINIUYUN_IMAGE_CAPABILITY } from './company-capabilities.ts';

// 精确协议白名单；设置里的未知别名不能套用其他模型的提交合同。
const SPECS = [
  { model: 'image2-medium', id: 'company-gateway-image2-medium', key: 'company-image2-medium', max: 6 },
  { model: 'qiniuyun/gpt-image-2-medium', id: 'company-gateway-qiniuyun-gpt-image-2-medium', key: 'company-qiniuyun-image-2', max: 6 },
  { model: 'doubao-seedream-5-0-pro-image', id: 'company-gateway-seedream-5-0-pro', key: 'company-seedream-5-0-pro', max: 14 },
  { model: 'nano-banana-3.0', id: 'company-gateway-nano-banana-pro', key: 'company-nano-banana-pro', max: 14 },
  { model: 'nano-banana-3.1', id: 'company-gateway-nano-banana-2', key: 'company-nano-banana-2', max: 14 },
] as const;

export function configuredCanvasImages(db: Database.Database): CanvasModelCapability[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'providers'").get()) return [];
  const rows = db.prepare(`SELECT id, name, model FROM providers
    WHERE type = 'gateway-task-image' AND enabled = 1 AND length(trim(baseUrl)) > 0 AND length(trim(apiKey)) > 0
    ORDER BY name, id`).all() as Array<{ id: string; name: string; model: string }>;
  return rows.flatMap((row) => {
    const spec = SPECS.find((entry) => entry.model === row.model);
    if (!spec) return [];
    const caps = companyImageCapsForModel(row.model)!;
    const template = row.model === 'qiniuyun/gpt-image-2-medium'
      ? COMPANY_CANVAS_QINIUYUN_IMAGE_CAPABILITY : COMPANY_CANVAS_IMAGE2_CAPABILITY;
    return [{
      ...template,
      // 保留 canonical 键兼容旧图；用户新增的同模型渠道按供应商行隔离。
      key: row.id === spec.id ? spec.key : `${spec.key}:provider:${encodeURIComponent(row.id)}`,
      displayName: row.name,
      providerIdentity: row.id,
      modelAlias: row.model,
      inputs: template.inputs.map((input) => input.kind === 'image' ? { ...input, max: spec.max } : input),
      parameters: [
        { key: 'aspectRatio', label: '比例', type: 'enum' as const, options: caps.ratios, default: '1:1' },
        { key: 'resolution', label: '清晰度', type: 'enum' as const, options: caps.tiers, default: '2K' },
      ],
      evidence: 'mapped' as const,
      evidenceNote: '沿用主工作台已接入的精确模型协议与尺寸约束；画布请求映射由本地回归覆盖，完整画布真实生成仍待验证。',
    }];
  });
}
