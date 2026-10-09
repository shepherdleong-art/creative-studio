import type Database from 'better-sqlite3';
import type { CanvasModelCapability } from '../capabilities.ts';
import { COMPANY_CANVAS_CAPABILITIES, COMPANY_CANVAS_KLING_3_0_CAPABILITY, COMPANY_CANVAS_SEEDANCE_2_0_CANDIDATE } from './company-capabilities.ts';
import { companyVideoCapsForModel } from '../../company-gateway-size.ts';
import { SEEDANCE_20, SEEDANCE_25, SEEDANCE_FAST } from '../../video-providers/seedance-contract.ts';
import { directSeedanceCapability } from './seedance-capabilities.ts';

const kling25: CanvasModelCapability = {
  ...COMPANY_CANVAS_KLING_3_0_CAPABILITY,
  key: 'company-kling-2-5', providerIdentity: 'company-kling-2-5',
  modelAlias: 'kling-2.5', displayName: '公司可灵 2.5',
  parameters: [
    { key: 'durationSec', label: '时长（秒）', type: 'enum', options: ['5', '10'], default: '5' },
    { key: 'resolution', label: '分辨率', type: 'enum', options: ['1080p'], default: '1080p' },
    { key: 'aspectRatio', label: '比例', type: 'enum', options: companyVideoCapsForModel('kling-2.5')!.ratios, default: '16:9' },
  ],
  evidenceNote: '沿用主工作台 Kling 2.5 的 OutputConfig 1080P、5/10 秒与 LastFrameUrl 合同；画布本地请求回归通过，首尾帧真实生成仍待验证。',
};

const SPECS = [...COMPANY_CANVAS_CAPABILITIES.filter((capability) => capability.mediaKind === 'video'), COMPANY_CANVAS_SEEDANCE_2_0_CANDIDATE, kling25];

export function configuredCanvasVideos(db: Database.Database): CanvasModelCapability[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'video_providers'").get()) return [];
  const rows = db.prepare(`SELECT id, name, defaultModel FROM video_providers
    WHERE type = 'openai-video' AND enabled = 1 AND length(trim(baseUrl)) > 0 AND length(trim(apiKey)) > 0
    ORDER BY name, id`).all() as Array<{ id: string; name: string; defaultModel: string }>;
  return rows.flatMap((row) => {
    const spec = SPECS.find((entry) => entry.modelAlias === row.defaultModel);
    if (!spec) return [];
    const key = row.id === spec.providerIdentity ? spec.key : `${spec.key}:provider:${encodeURIComponent(row.id)}`;
    if (row.defaultModel === SEEDANCE_20 || row.defaultModel === SEEDANCE_25 || row.defaultModel === SEEDANCE_FAST) {
      return [{ ...directSeedanceCapability(row.defaultModel),
        key: `${key}:ark-v1`, providerKind: 'company' as const, providerIdentity: row.id, displayName: row.name,
        evidenceNote: '用户确认公司网关支持方舟原生协议；复用直连六模式与参数校验，媒体强制 COS，画布真实生成尚未验收。',
      }];
    }
    return [{ ...spec, key,
      providerIdentity: row.id, displayName: row.name,
    }];
  });
}
