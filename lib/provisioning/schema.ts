import { createHash } from 'node:crypto';
import { getFinalEditTtsAdapter } from '../final-edit/adapters/tts-registry.ts';
import type {
  ProvisioningCosConfig,
  ProvisioningPayload,
  ProvisioningProvider,
} from './types.ts';

export const MAX_LITE_LLM_CONFIG_BYTES = 512 * 1024;
export const MAX_PROFILE_NAME_LENGTH = 128;
export const MAX_PROVIDER_STRING_LENGTH = 256;
export const MAX_PROVIDER_ID_LENGTH = 64;
export const MAX_SECRET_LENGTH = 1024;

const SCRIPT_TYPES = new Set(['openai-compatible', 'openai-responses', 'anthropic-messages']);
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** A single deliberately boring error for all validation failures. */
export class ProvisioningValidationError extends Error {
  constructor() {
    super('统一配置文件内容无效');
    this.name = 'ProvisioningValidationError';
  }
}

function fail(): never {
  throw new ProvisioningValidationError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) fail();
}

function stringValue(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    fail();
  }
  const result = (value as string).trim();
  if (required && !result) fail();
  if (result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) fail();
  return result;
}

function secretValue(value: unknown, required = true): string {
  const result = stringValue(value, MAX_SECRET_LENGTH, required);
  if (result && isPlaceholder(result)) fail();
  return result;
}

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('example.')
    || lower.includes('placeholder')
    || lower.includes('replace_with')
    || lower.includes('replace-with')
    || lower.includes('replace_me')
    || lower.includes('replace-me')
    || lower.includes('changeme')
    || lower.includes('change_me')
    || lower.includes('change-me')
    || lower.includes('sample-key')
    || lower.includes('dummy-key')
    || lower.includes('test-key')
    || lower.includes('your-gateway')
    || /^your[-_]/.test(lower)
    || /^sk-(?:x+|your|test|example)/.test(lower)
    || /^(?:x{3,}|n\/a|none)$/.test(lower)
    || lower.includes('your-api-key')
    || lower.includes('your_api_key')
    || lower === 'xxx'
    || lower === 'todo';
}

function hasForbiddenRawUrlSyntax(value: string): boolean {
  if (value.includes('?') || value.includes('#')) return true;
  const schemeSeparator = value.indexOf('://');
  if (schemeSeparator < 0) return false;
  const authorityStart = schemeSeparator + 3;
  const pathStart = value.indexOf('/', authorityStart);
  const authorityEnd = pathStart < 0 ? value.length : pathStart;
  return value.slice(authorityStart, authorityEnd).includes('@');
}

function validateLoopbackBaseUrl(value: unknown): string {
  const raw = stringValue(value, MAX_PROVIDER_STRING_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail();
  }
  if (parsed.protocol !== 'http:'
    || hasForbiddenRawUrlSyntax(raw)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) fail();
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) fail();
  return parsed.toString().replace(/\/$/, '');
}

function validateTtsBaseUrl(value: unknown): string {
  const raw = stringValue(value, MAX_PROVIDER_STRING_LENGTH);
  try {
    const parsed = new URL(raw);
    if (hasForbiddenRawUrlSyntax(raw)
      || parsed.username
      || parsed.password
      || parsed.origin !== 'https://openspeech.bytedance.com') fail();
    return getFinalEditTtsAdapter('doubao-seed-tts-2').validateBaseUrl(raw);
  } catch {
    fail();
  }
}

function providerObject(value: unknown, role: 'image' | 'script' | 'video' | 'tts'): ProvisioningProvider {
  if (!isRecord(value)) fail();
  assertExactKeys(value, [
    'id', 'name', 'type', 'apiStyle', 'baseUrl', 'model', 'enabled', 'apiKey',
    'maxTokens', 'supportsVision', 'visionCostPerRequest', 'defaultCostPerImage',
    'defaultDurationSec', 'executionScope', 'costPerThousandCharacters',
  ]);

  const id = stringValue(value.id, MAX_PROVIDER_ID_LENGTH);
  if (!SAFE_ID.test(id)) fail();
  const name = stringValue(value.name, MAX_PROVIDER_STRING_LENGTH);
  const apiStyle = stringValue(value.apiStyle, 64) as ProvisioningProvider['apiStyle'];
  const type = stringValue(value.type, 64);
  const model = stringValue(value.model, MAX_PROVIDER_STRING_LENGTH);
  if (isPlaceholder(model)) fail();
  if (typeof value.enabled !== 'boolean') fail();
  const apiKey = value.apiKey === undefined ? undefined : secretValue(value.apiKey);

  let baseUrl: string;
  if (role === 'tts') {
    if (type !== 'doubao-http-chunked' || apiStyle !== 'doubao-http-chunked') fail();
    baseUrl = validateTtsBaseUrl(value.baseUrl);
    if (id !== 'doubao-seed-tts-2') fail();
    if (apiKey === undefined || !apiKey) fail();
  } else {
    baseUrl = validateLoopbackBaseUrl(value.baseUrl);
    if (role !== 'script' && apiStyle !== 'openai-compatible') fail();
  }

  if (role === 'image' && type !== 'gateway-task-image') fail();
  if (role === 'script') {
    if (!SCRIPT_TYPES.has(type) || !SCRIPT_TYPES.has(apiStyle)) fail();
    if (type !== apiStyle) fail();
    if (value.executionScope !== 'company') fail();
  }
  if (role === 'video' && type !== 'openai-video') fail();
  if ((role === 'image' || role === 'video') && value.executionScope !== undefined && value.executionScope !== 'company') fail();

  const result: ProvisioningProvider = {
    id, name, type, apiStyle, baseUrl, model,
    enabled: value.enabled,
  };
  if (apiKey !== undefined) result.apiKey = apiKey;
  if (role === 'script') {
    result.executionScope = 'company';
    if (value.maxTokens !== undefined) {
      if (!Number.isInteger(value.maxTokens) || Number(value.maxTokens) < 512 || Number(value.maxTokens) > 131072) fail();
      result.maxTokens = Number(value.maxTokens);
    }
    if (value.supportsVision !== undefined) {
      if (typeof value.supportsVision !== 'boolean') fail();
      result.supportsVision = value.supportsVision;
    }
    if (value.visionCostPerRequest !== undefined) {
      if (typeof value.visionCostPerRequest !== 'number' || !Number.isFinite(value.visionCostPerRequest) || value.visionCostPerRequest < 0 || value.visionCostPerRequest > 1_000_000) fail();
      result.visionCostPerRequest = value.visionCostPerRequest;
    }
  }
  if (role === 'image' && value.defaultCostPerImage !== undefined) {
    if (typeof value.defaultCostPerImage !== 'number' || !Number.isFinite(value.defaultCostPerImage) || value.defaultCostPerImage < 0 || value.defaultCostPerImage > 1_000_000) fail();
    result.defaultCostPerImage = value.defaultCostPerImage;
  }
  if (role === 'video' && value.defaultDurationSec !== undefined) {
    if (!Number.isInteger(value.defaultDurationSec) || Number(value.defaultDurationSec) < 2 || Number(value.defaultDurationSec) > 30) fail();
    result.defaultDurationSec = Number(value.defaultDurationSec);
  }
  if (role === 'tts' && value.costPerThousandCharacters !== undefined) {
    if (typeof value.costPerThousandCharacters !== 'number' || !Number.isFinite(value.costPerThousandCharacters) || value.costPerThousandCharacters < 0 || value.costPerThousandCharacters > 1_000_000) fail();
    result.costPerThousandCharacters = value.costPerThousandCharacters;
  }
  return result;
}

function cosObject(value: unknown): ProvisioningCosConfig {
  if (!isRecord(value)) fail();
  assertExactKeys(value, ['secretId', 'secretKey', 'domain', 'signHost', 'prefix', 'ttlSec']);
  const secretId = secretValue(value.secretId);
  const secretKey = secretValue(value.secretKey);
  const domain = stringValue(value.domain, MAX_PROVIDER_STRING_LENGTH);
  if (isPlaceholder(domain) || /[\s/?#]/.test(domain)) fail();
  const result: ProvisioningCosConfig = { secretId, secretKey, domain };
  if (value.signHost !== undefined) {
    const signHost = stringValue(value.signHost, MAX_PROVIDER_STRING_LENGTH);
    if (isPlaceholder(signHost) || /[\s/?#]/.test(signHost)) fail();
    result.signHost = signHost;
  }
  if (value.prefix !== undefined) {
    const prefix = stringValue(value.prefix, 128, false);
    if (prefix.startsWith('/') || prefix.includes('..')) fail();
    result.prefix = prefix;
  }
  if (value.ttlSec !== undefined) {
    if (!Number.isInteger(value.ttlSec) || Number(value.ttlSec) < 60 || Number(value.ttlSec) > 7 * 24 * 3600) fail();
    result.ttlSec = Number(value.ttlSec);
  }
  return result;
}

/** Strictly parse and normalize a schema-v1 JSON payload. */
export function validateProvisioningPayload(input: unknown): ProvisioningPayload {
  if (!isRecord(input)) fail();
  assertExactKeys(input, [
    'schemaVersion', 'profileName', 'gatewayApiKey', 'liteLlmConfigYaml',
    'image', 'script', 'videos', 'tts', 'cos',
  ]);
  if (input.schemaVersion !== 1) fail();
  const profileName = stringValue(input.profileName, MAX_PROFILE_NAME_LENGTH);
  const gatewayApiKey = secretValue(input.gatewayApiKey);
  const yaml = stringValue(input.liteLlmConfigYaml, MAX_LITE_LLM_CONFIG_BYTES);
  if (Buffer.byteLength(yaml, 'utf8') > MAX_LITE_LLM_CONFIG_BYTES || !yaml.trim()) fail();
  if (isPlaceholder(yaml)) fail();
  const image = providerObject(input.image, 'image');
  const script = providerObject(input.script, 'script');
  if (!Array.isArray(input.videos) || input.videos.length < 1 || input.videos.length > 8) fail();
  const videos = input.videos.map((item) => providerObject(item, 'video'));
  const videoIds = new Set(videos.map((item) => item.id));
  const videoModels = new Set(videos.map((item) => item.model));
  if (videoIds.size !== videos.length || videoModels.size !== videos.length) fail();
  const tts = providerObject(input.tts, 'tts');
  const cos = cosObject(input.cos);
  return {
    schemaVersion: 1,
    profileName,
    gatewayApiKey,
    liteLlmConfigYaml: yaml,
    image,
    script,
    videos,
    tts,
    cos,
  };
}

export function configHashPrefix(configYaml: string): string {
  return createHash('sha256').update(configYaml, 'utf8').digest('hex').slice(0, 12);
}
