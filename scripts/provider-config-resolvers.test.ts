import assert from 'node:assert/strict';
import {
  getVideoProviderConfigState,
  resolveVideoProviderRuntimeConfig,
} from '../lib/video-auth.ts';
import {
  resolveScriptProviderRuntimeConfig,
  toScriptProviderMeta,
} from '../lib/script-providers/config.ts';

assert.deepEqual(
  resolveScriptProviderRuntimeConfig(
    {
      id: 'gemini',
      name: 'Gemini',
      apiStyle: 'openai-compatible',
      keyEnv: 'GEMINI_API_KEY',
      baseUrlEnv: 'GEMINI_BASE_URL',
      modelEnv: 'GEMINI_MODEL',
      defaultModel: 'gemini-default',
      defaultBaseUrl: 'https://default.example.com',
      maxTokens: 1024,
    },
    {
      baseUrl: 'https://db.internal.test',
      apiKey: 'db-key',
      model: 'db-model',
      enabled: 1,
    },
    {
      GEMINI_API_KEY: 'env-key',
      GEMINI_BASE_URL: 'https://env.internal.test',
      GEMINI_MODEL: 'env-model',
    }
  ),
  {
    id: 'gemini',
    name: 'Gemini',
    apiStyle: 'openai-compatible',
    baseUrl: 'https://db.internal.test',
    apiKey: 'db-key',
    model: 'db-model',
    maxTokens: 1024,
    enabled: true,
    configured: true,
    missing: [],
    hasApiKey: true,
  }
);

const scriptEnvFallback = resolveScriptProviderRuntimeConfig(
  {
    id: 'qwen',
    name: 'Qwen',
    apiStyle: 'openai-compatible',
    keyEnv: 'QWEN_API_KEY',
    baseUrlEnv: 'QWEN_BASE_URL',
    modelEnv: 'QWEN_MODEL',
    defaultModel: 'qwen-default',
    defaultBaseUrl: 'https://qwen.default',
    maxTokens: 2048,
  },
  {
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: 1,
  },
  {
    QWEN_API_KEY: 'env-qwen-key',
  }
);

assert.equal(scriptEnvFallback.baseUrl, 'https://qwen.default');
assert.equal(scriptEnvFallback.apiKey, '');
assert.equal(scriptEnvFallback.model, 'qwen-default');
assert.equal(scriptEnvFallback.configured, false);
assert.deepEqual(scriptEnvFallback.missing, ['API Key']);
assert.deepEqual(toScriptProviderMeta(scriptEnvFallback), {
  id: 'qwen',
  name: 'Qwen',
  model: 'qwen-default',
  configured: false,
  apiStyle: 'openai-compatible',
  category: 'script',
  type: 'openai-compatible',
  enabled: 1,
  hasApiKey: false,
  missing: ['API Key'],
  maxTokens: 2048,
});

assert.deepEqual(
  getVideoProviderConfigState(
    {
      type: 'jimeng',
      baseUrlEnv: 'JIMENG_VIDEO_BASE_URL',
      apiKeyEnv: 'JIMENG_VIDEO_API_KEY',
      baseUrl: 'https://jimeng.db',
      apiKey: 'jimeng-db-key',
    },
    {
      JIMENG_VIDEO_BASE_URL: 'https://jimeng.env',
      JIMENG_VIDEO_API_KEY: 'jimeng-env-key',
    }
  ),
  { configured: true, missing: [] }
);

assert.deepEqual(
  getVideoProviderConfigState(
    {
      type: 'jimeng',
      baseUrlEnv: 'JIMENG_VIDEO_BASE_URL',
      apiKeyEnv: 'JIMENG_VIDEO_API_KEY',
      baseUrl: '',
      apiKey: '',
    },
    {
      JIMENG_VIDEO_BASE_URL: 'https://jimeng.env',
      JIMENG_VIDEO_API_KEY: 'jimeng-env-key',
    }
  ),
  { configured: false, missing: ['Base URL', 'API Key'] }
);

assert.deepEqual(
  resolveVideoProviderRuntimeConfig(
    {
      id: 'kling-3',
      name: 'Kling',
      type: 'kling',
      baseUrlEnv: 'KLING_VIDEO_BASE_URL',
      apiKeyEnv: 'KLING_VIDEO_API_KEY',
      baseUrl: 'https://kling.db',
      apiKey: '',
      accessKey: 'db-access',
      secretKey: 'db-secret',
      defaultModel: 'kling-v3',
      defaultDurationSec: 5,
      enabled: 1,
    },
    {
      KLING_VIDEO_BASE_URL: 'https://kling.env',
      KLING_VIDEO_ACCESS_KEY: 'env-access',
      KLING_VIDEO_SECRET_KEY: 'env-secret',
    }
  ),
  {
    id: 'kling-3',
    name: 'Kling',
    type: 'kling',
    baseUrl: 'https://kling.db',
    apiKey: '',
    accessKey: 'db-access',
    secretKey: 'db-secret',
    model: 'kling-v3',
    durationSec: 5,
    enabled: true,
    configured: true,
    missing: [],
    hasApiKey: true,
  }
);
