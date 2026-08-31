import assert from 'node:assert/strict';
import type { ProviderMeta } from '../lib/script-providers/types.ts';
import { selectScriptStudioRuntimeProviders } from '../lib/script-studio/provider-selection.ts';

function provider(overrides: Partial<ProviderMeta> & Pick<ProviderMeta, 'id' | 'name' | 'model'>): ProviderMeta {
  return {
    configured: true,
    apiStyle: 'openai-compatible',
    supportsVision: true,
    executionScope: 'external',
    ...overrides,
  };
}

const externalGpt = provider({
  id: 'gpt',
  name: 'GPT / OpenAI',
  model: 'gpt-5.5',
});
const externalGemini = provider({
  id: 'gemini',
  name: 'Gemini',
  model: 'gemini-3.7-flash',
});
const companyLuna = provider({
  id: 'company-luna',
  name: '公司 LiteLLM · GPT-5-6-Luna-Standard',
  model: 'GPT-5-6-Luna-Standard',
  executionScope: 'company',
});
const companyVisionModel = provider({
  id: 'company-vision-v2',
  name: '公司 LiteLLM · Vision V2',
  model: 'Company-Vision-V2',
  executionScope: 'company',
});

const selected = selectScriptStudioRuntimeProviders([externalGpt, companyLuna]);
assert.deepEqual(selected, {
  vision: { id: companyLuna.id, model: companyLuna.model },
  text: { id: companyLuna.id, model: companyLuna.model },
}, '外部 GPT 即使排在前面，详情页智能脚本也必须只选择公司 Luna');

assert.deepEqual(
  selectScriptStudioRuntimeProviders([companyVisionModel, companyLuna]),
  {
    vision: { id: companyLuna.id, model: companyLuna.model },
    text: { id: companyLuna.id, model: companyLuna.model },
  },
  '存在多个公司视觉模型时，默认值必须优先选择 Luna',
);

assert.throws(
  () => selectScriptStudioRuntimeProviders([externalGpt]),
  /公司 API|公司供应商/,
  '公司供应商缺失时不得回退到外部供应商',
);

assert.throws(
  () => selectScriptStudioRuntimeProviders([
    provider({
      ...companyLuna,
      id: 'disabled-luna',
      configured: false,
    }),
  ]),
  /公司 API|公司供应商/,
  '未配置的公司供应商不得被选择',
);

assert.throws(
  () => selectScriptStudioRuntimeProviders([
    provider({
      ...companyLuna,
      id: 'text-only-luna',
      supportsVision: false,
    }),
  ]),
  /支持视觉|公司 API|公司供应商/,
  '详情页链路要求公司供应商支持视觉，不能使用仅文本配置',
);

assert.deepEqual(
  selectScriptStudioRuntimeProviders([externalGpt, companyVisionModel]),
  {
    vision: { id: companyVisionModel.id, model: companyVisionModel.model },
    text: { id: companyVisionModel.id, model: companyVisionModel.model },
  },
  'Luna 不可用时，历史无选择任务仍可回退到其他公司视觉模型',
);

assert.deepEqual(
  selectScriptStudioRuntimeProviders([externalGemini, companyLuna], externalGemini.id),
  {
    vision: { id: externalGemini.id, model: externalGemini.model },
    text: { id: externalGemini.id, model: externalGemini.model },
  },
  '用户显式选择 Gemini 时，识图、证据核验和脚本生成必须固定使用 Gemini',
);

assert.throws(
  () => selectScriptStudioRuntimeProviders([externalGemini, companyLuna], 'missing-provider'),
  /所选脚本模型不存在|不可用/,
  '显式选择不存在的模型时必须失败关闭，不能静默回退到 Luna',
);

assert.throws(
  () => selectScriptStudioRuntimeProviders([
    provider({ ...externalGemini, id: 'gemini-text-only', supportsVision: false }),
    companyLuna,
  ], 'gemini-text-only'),
  /不支持图片读取|支持视觉/,
  '显式选择仅文本模型时必须在任务提交前失败关闭',
);

console.log('script-studio-runtime.test.ts: ok');
