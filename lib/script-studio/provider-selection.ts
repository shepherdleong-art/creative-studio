import type { ProviderMeta } from '../script-providers/types.ts';
import { ScriptStudioError } from './errors.ts';

export interface ScriptStudioRuntimeProvider {
  id: string;
  model: string;
}

export function selectScriptStudioRuntimeProviders(
  providers: readonly ProviderMeta[],
  requestedProviderId?: string | null,
): {
  vision: ScriptStudioRuntimeProvider;
  text: ScriptStudioRuntimeProvider;
} {
  const requestedId = requestedProviderId?.trim();
  if (requestedId) {
    const requested = providers.find((provider) => provider.id === requestedId);
    if (!requested || !requested.configured) {
      throw new ScriptStudioError(
        'provider_unavailable',
        '所选脚本模型不存在、未配置或已停用，请重新选择',
      );
    }
    if (!requested.supportsVision) {
      throw new ScriptStudioError(
        'provider_unavailable',
        '所选脚本模型不支持图片读取，无法用于详情页智能脚本',
      );
    }
    const selected = { id: requested.id, model: requested.model };
    return { vision: selected, text: selected };
  }

  const candidates = providers.filter((provider) => (
    provider.configured
    && provider.executionScope === 'company'
    && provider.supportsVision
  ));
  const companyProvider = candidates.find((provider) => (
    `${provider.name} ${provider.model}`.toLocaleLowerCase().includes('luna')
  )) ?? candidates[0];
  if (!companyProvider) {
    throw new ScriptStudioError(
      'provider_unavailable',
      '详情页智能脚本生产链路只使用公司 API；未找到已配置、已启用且支持视觉的公司供应商',
    );
  }
  const selected = { id: companyProvider.id, model: companyProvider.model };
  return {
    vision: selected,
    text: selected,
  };
}
