import { readRuntimeConfig } from '../team-service/config.ts';
import { isVisibleVideoProvider } from '../provider-list-visibility.ts';
import { getVideoProviderConfigState, type VideoProviderEnvConfig } from '../video-auth.ts';
import { projectTeamVideoModels, unifiedKlingProviderAvailability } from '../media-core/unified-media/video-model-list.ts';
import type Database from 'better-sqlite3';
import { videoDurationOptions, describeVideoDurationOptions } from '../video-duration.ts';
import { videoReferenceCapability } from '../video-reference-contract.ts';
import { OneClickFilmError } from './errors.ts';
import { getVideoAdapter } from '../video-providers/index.ts';
import { seedanceContract } from '../video-providers/seedance-contract.ts';
import { parseUsageSnapshot } from '../usage-snapshot.ts';
import { calculateUsageCostMicros } from '../usage-pricing.ts';
import { videoJobUsageMeasurement } from '../usage-video-measurement.ts';

export function estimateFrozenVideoCost(usageSnapshot: unknown, durationSec: number): number | null {
  const parsed = parseUsageSnapshot(usageSnapshot);
  if (!parsed.ok) return null;
  const { snapshot } = parsed.parsed;
  const quantity = videoJobUsageMeasurement(snapshot, durationSec)?.quantity;
  return quantity === undefined ? null : calculateUsageCostMicros(snapshot.priceComponents, quantity);
}

/**
 * 第三步的模型/参数能力（06）。
 *
 * 首版口径：Seedance 2.5（4–30 秒）、MiniMax H3（4–15 秒）、Wan 3.0（2–30 秒），
 * 正文默认 15 秒。画幅与参考组合按通道实际声明的能力决定，
 * 服务端给出与界面一致的判定，不按模型名猜。
 */

export const ONE_CLICK_FILM_MODELS = [
  { key: 'seedance-2.5', label: 'Seedance 2.5', modelPattern: /seedance-2-5/i },
  { key: 'minimax-h3', label: 'MiniMax H3', modelPattern: /minimax-h3/i },
  { key: 'wan-3.0', label: 'Wan 3.0', modelPattern: /wan-3/i },
] as const;

export const ONE_CLICK_FILM_DEFAULT_DURATION = 15;
export const ONE_CLICK_FILM_DEFAULT_RATIO = '3:4';

export type OneClickFilmModelKey = (typeof ONE_CLICK_FILM_MODELS)[number]['key'];
export type GenerationModeChoice = 'draft' | 'direct';

export interface VideoModelOption {
  key: OneClickFilmModelKey | 'other';
  label: string;
  providerId: string;
  providerName: string;
  providerType: string;
  model: string;
  durations: number[];
  durationLabel: string;
  aspectRatios: string[];
  resolutions: string[];
  modes: GenerationModeChoice[];
  hasApiKey: boolean;
}

function keyFor(model: string): OneClickFilmModelKey | 'other' {
  return ONE_CLICK_FILM_MODELS.find((entry) => entry.modelPattern.test(model))?.key ?? 'other';
}

function labelFor(key: OneClickFilmModelKey | 'other', fallback: string): string {
  return ONE_CLICK_FILM_MODELS.find((entry) => entry.key === key)?.label ?? fallback;
}

export function listVideoModelOptions(db: Database.Database): VideoModelOption[] {
  const rows = db.prepare('SELECT * FROM video_providers WHERE enabled=1 ORDER BY name').all() as
    Array<VideoProviderEnvConfig & { id: string; name: string }>;
  const mode = readRuntimeConfig().mode;
  const models = projectTeamVideoModels(rows.filter(isVisibleVideoProvider).map((row) => {
    const state = getVideoProviderConfigState(row);
    return { id: row.id, name: row.name, type: row.type, defaultModel: row.defaultModel?.trim() ?? '', configured: state.configured };
  }), {
    mode, unifiedAvailable: mode === 'server' && unifiedKlingProviderAvailability(db).some((channel) => channel.configured),
    unifiedCapabilities: {},
  });
  return models.map((row) => {
    const durations = [...videoDurationOptions(row.type, row.defaultModel)];
    const reference = videoReferenceCapability(row.type, row.defaultModel);
    const key = keyFor(row.defaultModel);
    return {
      key,
      label: labelFor(key, row.name),
      providerId: row.id,
      providerName: row.name,
      providerType: row.type,
      model: row.defaultModel,
      durations,
      durationLabel: describeVideoDurationOptions(durations),
      aspectRatios: reference.supported ? [...reference.aspectRatios] : ['3:4', '9:16', '16:9', '1:1'],
      resolutions: reference.supported ? [...reference.resolutions] : [],
      // 样片只在 Seedance 2.5 的支持通道开放；其余只能直出。
      modes: seedanceContract(row.defaultModel)?.draft && getVideoAdapter(row.type)?.submitFinal ? ['draft', 'direct'] : ['direct'],
      hasApiKey: row.configured,
    };
  });
}

export interface GenerationSettingsCheck {
  ok: boolean;
  message: string;
}

/** 提交前校验：时长、画幅、生成模式必须落在该通道声明的范围内。 */
export function validateGenerationSettings(input: {
  option: VideoModelOption | undefined;
  durationSec: number;
  aspectRatio: string;
  mode: GenerationModeChoice;
}): GenerationSettingsCheck {
  if (!input.option) return { ok: false, message: '请选择视频通道' };
  if (!input.option.durations.includes(input.durationSec)) {
    return {
      ok: false,
      message: `${input.option.label} 的正文时长须为 ${input.option.durationLabel}，当前是 ${input.durationSec} 秒`,
    };
  }
  if (!input.option.aspectRatios.includes(input.aspectRatio)) {
    return {
      ok: false,
      message: `${input.option.label} 不支持 ${input.aspectRatio} 画幅，可选 ${input.option.aspectRatios.join('、')}`,
    };
  }
  if (!input.option.modes.includes(input.mode)) {
    return {
      ok: false,
      message: `${input.option.label} 只能${input.option.modes.map((mode) => (mode === 'draft' ? '样片生成' : '直接生成')).join('或')}`,
    };
  }
  return { ok: true, message: '' };
}

export function assertGenerationSettings(check: GenerationSettingsCheck): void {
  if (!check.ok) throw new OneClickFilmError('invalid_input', check.message);
}
