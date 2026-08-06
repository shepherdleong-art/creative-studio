import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDb } from '../db.ts';
import { dataRoot } from '../data-root.ts';
import { decryptProvisioningPayload, MAX_PROVISIONING_FILE_BYTES } from './crypto.ts';
import {
  configHashPrefix,
  MAX_LITE_LLM_CONFIG_BYTES,
  MAX_PROFILE_NAME_LENGTH,
  MAX_PROVIDER_ID_LENGTH,
  validateProvisioningPayload,
} from './schema.ts';
import {
  PROVISIONING_STATE_SCHEMA_VERSION,
} from './types.ts';
import type {
  ManagedProviderAllowlist,
  ProvisioningPayload,
  ProvisioningStateV2,
  ProvisioningStatus,
} from './types.ts';

/**
 * Deliberate boundary: the encrypted file is only a delivery mechanism.
 * Imported provider credentials remain authoritative in the existing SQLite
 * tables; COS credentials additionally live in this gitignored runtime env
 * file so Node can load them before provider modules are initialized.
 */
export const PROVISIONING_CONFIG_FILE_NAME = 'config.yaml';
export const PROVISIONING_RUNTIME_ENV_RELATIVE_PATH = path.join('data', 'provisioning', 'runtime.env');
export const PROVISIONING_STATE_RELATIVE_PATH = path.join('data', 'provisioning', 'state.json');

const RUNTIME_ENV_KEYS = [
  'CREATIVE_STUDIO_GATEWAY_API_KEY',
  'COMPANY_GATEWAY_API_KEY',
  'GATEWAY_API_KEY',
  'CREATIVE_STUDIO_COS_SECRET_ID',
  'CREATIVE_STUDIO_COS_SECRET_KEY',
  'CREATIVE_STUDIO_COS_DOMAIN',
  'CREATIVE_STUDIO_COS_SIGN_HOST',
  'CREATIVE_STUDIO_COS_PREFIX',
  'CREATIVE_STUDIO_COS_URL_TTL_SEC',
] as const;

const REQUIRED_RUNTIME_ENV_KEYS = [
  'CREATIVE_STUDIO_GATEWAY_API_KEY',
  'COMPANY_GATEWAY_API_KEY',
  'GATEWAY_API_KEY',
  'CREATIVE_STUDIO_COS_SECRET_ID',
  'CREATIVE_STUDIO_COS_SECRET_KEY',
  'CREATIVE_STUDIO_COS_DOMAIN',
] as const;

const MAX_PROVISIONING_STATE_FILE_BYTES = 128 * 1024;
const SAFE_PROVIDER_ID = new RegExp(`^[a-z0-9](?:[a-z0-9._-]{0,${MAX_PROVIDER_ID_LENGTH - 1}})$`);

type ProvisioningPaths = {
  root: string;
  configPath: string;
  runtimeEnvPath: string;
  statePath: string;
};

type FileSnapshot = { path: string; existed: boolean; bytes: Buffer | null; backupPath: string | null };

export interface ApplyProvisioningOptions {
  /** Test-only dependency injection; production uses dataRoot() and getDb(). */
  root?: string;
  db?: Database.Database;
  now?: Date;
}

function pathsFor(root: string): ProvisioningPaths {
  return {
    root,
    configPath: path.join(root, PROVISIONING_CONFIG_FILE_NAME),
    runtimeEnvPath: path.join(root, PROVISIONING_RUNTIME_ENV_RELATIVE_PATH),
    statePath: path.join(root, PROVISIONING_STATE_RELATIVE_PATH),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  if (Object.keys(value).length !== expected.length) return false;
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeProviderId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_PROVIDER_ID_LENGTH
    && SAFE_PROVIDER_ID.test(value);
}

function parseAllowlistIds(
  value: unknown,
  minLength: number,
  maxLength: number,
): string[] | null {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) return null;
  if (!value.every((item) => isSafeProviderId(item))) return null;
  const ids = value as string[];
  return new Set(ids).size === ids.length ? ids : null;
}

function parseProvisioningState(value: unknown): ProvisioningStateV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'profileName', 'importedAt', 'configHash', 'managedProviders'])) {
    return null;
  }
  if (value.schemaVersion !== PROVISIONING_STATE_SCHEMA_VERSION) return null;
  if (typeof value.profileName !== 'string'
    || value.profileName.length < 1
    || value.profileName.length > MAX_PROFILE_NAME_LENGTH
    || value.profileName.trim() !== value.profileName
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.profileName)) {
    return null;
  }
  if (typeof value.importedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.importedAt)) {
    return null;
  }
  const importedAt = new Date(value.importedAt);
  if (Number.isNaN(importedAt.getTime()) || importedAt.toISOString() !== value.importedAt) return null;
  if (typeof value.configHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.configHash)) return null;
  if (!isRecord(value.managedProviders)
    || !hasExactKeys(value.managedProviders, ['image', 'script', 'video', 'tts'])) {
    return null;
  }
  const image = parseAllowlistIds(value.managedProviders.image, 1, 1);
  const script = parseAllowlistIds(value.managedProviders.script, 1, 1);
  const video = parseAllowlistIds(value.managedProviders.video, 1, 8);
  const tts = value.managedProviders.tts;
  if (!image || !script || !video
    || !Array.isArray(tts)
    || tts.length !== 1
    || tts[0] !== 'doubao-seed-tts-2') {
    return null;
  }
  return {
    schemaVersion: PROVISIONING_STATE_SCHEMA_VERSION,
    profileName: value.profileName,
    importedAt: value.importedAt,
    configHash: value.configHash.toLowerCase(),
    managedProviders: {
      image,
      script,
      video,
      tts: ['doubao-seed-tts-2'],
    },
  };
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeTempPath(target: string, suffix: string): string {
  return `${target}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.${suffix}`;
}

function writeTemp(temp: string, bytes: Buffer): void {
  let handle: number | undefined;
  let failure: unknown;
  try {
    handle = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } catch (error) {
    failure = error;
  }
  if (handle !== undefined) {
    try {
      fs.closeSync(handle);
    } catch (closeError) {
      // Preserve a write/fsync error when one already occurred. The caller
      // owns cleanup of the recorded temp path after this single close call.
      if (failure === undefined) failure = closeError;
    }
    handle = undefined;
  }
  if (failure !== undefined) throw failure;
}

function snapshot(filePath: string): FileSnapshot {
  if (!fs.existsSync(filePath)) return { path: filePath, existed: false, bytes: null, backupPath: null };
  return { path: filePath, existed: true, bytes: fs.readFileSync(filePath), backupPath: null };
}

function installFiles(writes: Array<{ path: string; bytes: Buffer }>, snapshots: FileSnapshot[]): void {
  const temps: Array<{ path: string; bytes: Buffer; temp: string }> = [];
  try {
    for (const write of writes) {
      ensureParent(write.path);
      temps.push({ ...write, temp: safeTempPath(write.path, 'tmp') });
    }
    for (const item of temps) writeTemp(item.temp, item.bytes);
    for (const item of temps) {
      const old = snapshots.find((entry) => entry.path === item.path);
      if (!old) throw new Error('file snapshot missing');
      if (old.existed) {
        const backupPath = safeTempPath(item.path, 'bak');
        fs.renameSync(item.path, backupPath);
        old.backupPath = backupPath;
      }
      fs.renameSync(item.temp, item.path);
      item.temp = '';
    }
  } catch (error) {
    for (const item of temps) {
      if (item.temp) {
        try { fs.unlinkSync(item.temp); } catch { /* best effort */ }
      }
    }
    throw error;
  }
}

function restoreFiles(snapshots: FileSnapshot[]): void {
  for (const snapshotItem of snapshots) {
    try {
      if (snapshotItem.existed) {
        if (snapshotItem.backupPath && fs.existsSync(snapshotItem.backupPath)) {
          if (fs.existsSync(snapshotItem.path)) fs.unlinkSync(snapshotItem.path);
          fs.renameSync(snapshotItem.backupPath, snapshotItem.path);
        } else if (snapshotItem.bytes) {
          fs.writeFileSync(snapshotItem.path, snapshotItem.bytes, { mode: 0o600 });
        }
      } else if (fs.existsSync(snapshotItem.path)) {
        fs.unlinkSync(snapshotItem.path);
      }
    } catch {
      // Keep the original error; a later startup can still use the backup.
    }
  }
}

function removeBackups(snapshots: FileSnapshot[]): void {
  for (const snapshotItem of snapshots) {
    if (snapshotItem.backupPath) {
      try { fs.unlinkSync(snapshotItem.backupPath); } catch { /* best effort */ }
    }
  }
}

function envValue(value: string): string {
  // JSON quoting keeps spaces, # and punctuation unambiguous and rejects
  // newlines before this point through schema validation.
  return JSON.stringify(value);
}

function runtimeEnvText(payload: ProvisioningPayload): Buffer {
  const key = payload.gatewayApiKey;
  const entries: Array<[string, string]> = [
    ['CREATIVE_STUDIO_GATEWAY_API_KEY', key],
    ['COMPANY_GATEWAY_API_KEY', key],
    ['GATEWAY_API_KEY', key],
    ['CREATIVE_STUDIO_COS_SECRET_ID', payload.cos.secretId],
    ['CREATIVE_STUDIO_COS_SECRET_KEY', payload.cos.secretKey],
    ['CREATIVE_STUDIO_COS_DOMAIN', payload.cos.domain],
    ['CREATIVE_STUDIO_COS_SIGN_HOST', payload.cos.signHost || ''],
    ['CREATIVE_STUDIO_COS_PREFIX', payload.cos.prefix || ''],
    ['CREATIVE_STUDIO_COS_URL_TTL_SEC', payload.cos.ttlSec === undefined ? '' : String(payload.cos.ttlSec)],
  ];
  return Buffer.from(`${entries.map(([name, value]) => `${name}=${envValue(value)}`).join('\n')}\n`, 'utf8');
}

function upsertDatabase(payload: ProvisioningPayload, db: Database.Database, now: string): void {
  const imageKey = payload.image.apiKey || payload.gatewayApiKey;
  const scriptKey = payload.script.apiKey || payload.gatewayApiKey;
  if (!payload.tts.apiKey) throw new Error('tts credential missing');
  const ttsKey = payload.tts.apiKey;

  db.prepare(`
      INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, baseUrl=excluded.baseUrl, apiKeyEnv=excluded.apiKeyEnv,
        apiKey=excluded.apiKey, model=excluded.model, type=excluded.type,
        enabled=excluded.enabled, defaultCostPerImage=excluded.defaultCostPerImage
    `).run(
      payload.image.id,
      payload.image.name,
      payload.image.baseUrl,
      'CREATIVE_STUDIO_GATEWAY_API_KEY',
      imageKey,
      payload.image.model,
      payload.image.type,
      payload.image.enabled ? 1 : 0,
      payload.image.defaultCostPerImage ?? 0,
    );

    db.prepare(`
      INSERT INTO script_providers
        (id, name, type, apiStyle, baseUrl, apiKey, model, keyEnv, baseUrlEnv, modelEnv,
         defaultBaseUrl, defaultModel, maxTokens, enabled, isBuiltin, supportsVision,
         visionCostPerRequest, executionScope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'company')
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, type=excluded.type, apiStyle=excluded.apiStyle,
        baseUrl=excluded.baseUrl, apiKey=excluded.apiKey, model=excluded.model,
        maxTokens=excluded.maxTokens, enabled=excluded.enabled, supportsVision=excluded.supportsVision,
        visionCostPerRequest=excluded.visionCostPerRequest, executionScope='company'
    `).run(
      payload.script.id,
      payload.script.name,
      payload.script.type,
      payload.script.apiStyle,
      payload.script.baseUrl,
      scriptKey,
      payload.script.model,
      'CREATIVE_STUDIO_GATEWAY_API_KEY',
      '',
      '',
      payload.script.baseUrl,
      payload.script.model,
      payload.script.maxTokens ?? 8192,
      payload.script.enabled ? 1 : 0,
      payload.script.supportsVision ? 1 : 0,
      payload.script.visionCostPerRequest ?? 0,
    );

    const upsertVideo = db.prepare(`
      INSERT INTO video_providers
        (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled,
         defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
      VALUES (?, ?, ?, '', ?, '', ?, ?, ?, ?, ?, '', '')
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, type=excluded.type, apiKeyEnv=excluded.apiKeyEnv,
        defaultModel=excluded.defaultModel, enabled=excluded.enabled,
        defaultDurationSec=excluded.defaultDurationSec, baseUrl=excluded.baseUrl,
        apiKey=excluded.apiKey, accessKey='', secretKey=''
    `);
    for (const video of payload.videos) {
      upsertVideo.run(
        video.id,
        video.name,
        video.type,
        'CREATIVE_STUDIO_GATEWAY_API_KEY',
        video.model,
        video.enabled ? 1 : 0,
        video.defaultDurationSec ?? 5,
        video.baseUrl,
        video.apiKey || payload.gatewayApiKey,
      );
    }

    const ttsExists = db.prepare(`SELECT 1 FROM final_edit_tts_providers WHERE id=?`).get('doubao-seed-tts-2');
    if (!ttsExists) throw new Error('tts provider missing');
    db.prepare(`
      UPDATE final_edit_tts_providers
      SET name=?, type=?, baseUrl=?, apiKey=?, keyEnv=?, model=?, enabled=?,
          costPerThousandCharacters=?, updatedAt=?
      WHERE id=?
    `).run(
      payload.tts.name,
      payload.tts.type,
      payload.tts.baseUrl,
      ttsKey,
      'DOUBAO_TTS_API_KEY',
      payload.tts.model,
      payload.tts.enabled ? 1 : 0,
      payload.tts.costPerThousandCharacters ?? 0,
      now,
      'doubao-seed-tts-2',
    );
}

function managedProvidersFromPayload(payload: ProvisioningPayload): ManagedProviderAllowlist {
  return {
    image: [payload.image.id],
    script: [payload.script.id],
    video: Array.from(new Set(payload.videos.map((provider) => provider.id))),
    tts: ['doubao-seed-tts-2'],
  };
}

export function applyProvisioningPayload(input: unknown, options: ApplyProvisioningOptions = {}): ProvisioningStatus {
  const payload = validateProvisioningPayload(input);
  const root = options.root || dataRoot();
  const paths = pathsFor(root);
  const importedAt = (options.now || new Date()).toISOString();
  const configHash = crypto.createHash('sha256').update(payload.liteLlmConfigYaml, 'utf8').digest('hex');
  const state = Buffer.from(JSON.stringify({
    schemaVersion: PROVISIONING_STATE_SCHEMA_VERSION,
    profileName: payload.profileName,
    importedAt,
    configHash,
    managedProviders: managedProvidersFromPayload(payload),
  }) + '\n', 'utf8');
  const writes = [
    { path: paths.configPath, bytes: Buffer.from(payload.liteLlmConfigYaml, 'utf8') },
    { path: paths.runtimeEnvPath, bytes: runtimeEnvText(payload) },
    { path: paths.statePath, bytes: state },
  ];
  const snapshots = writes.map((write) => snapshot(write.path));
  const db = options.db || getDb();
  try {
    db.transaction(() => {
      // Publish config and runtime credentials first; state is the final commit point.
      installFiles(writes.slice(0, 2), snapshots);
      upsertDatabase(payload, db, importedAt);
      installFiles([writes[2]], snapshots);
    })();
    removeBackups(snapshots);
    applyProvisionedRuntimeEnvFromPayload(payload);
  } catch {
    restoreFiles(snapshots);
    removeBackups(snapshots);
    throw new Error('统一配置导入失败');
  }
  return {
    configured: true,
    profileName: payload.profileName,
    importedAt,
    configHashPrefix: configHashPrefix(payload.liteLlmConfigYaml),
  };
}

export function importProvisioningPackage(input: Uint8Array | Buffer, password: string, options: ApplyProvisioningOptions = {}): ProvisioningStatus {
  if (input.byteLength > MAX_PROVISIONING_FILE_BYTES) throw new Error('统一配置导入失败');
  const payload = decryptProvisioningPayload(input, password);
  return applyProvisioningPayload(payload, options);
}

function parseRuntimeEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !RUNTIME_ENV_KEYS.includes(match[1] as typeof RUNTIME_ENV_KEYS[number])) continue;
    let value = match[2];
    if (value.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed === 'string') value = parsed;
      } catch { continue; }
    }
    if (value.length <= 2048) result[match[1]] = value;
  }
  return result;
}

/** Load the persisted runtime env before provider/scheduler initialization. */
export function loadProvisionedRuntimeEnv(root = dataRoot()): void {
  const envPath = pathsFor(root).runtimeEnvPath;
  if (!fs.existsSync(envPath)) return;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(envPath);
  } catch {
    return;
  }
  if (bytes.length > 128 * 1024) return;
  const values = parseRuntimeEnv(bytes.toString('utf8'));
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value) process.env[key] = value;
  }
}

function applyProvisionedRuntimeEnvFromPayload(payload: ProvisioningPayload): void {
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
  process.env.CREATIVE_STUDIO_GATEWAY_API_KEY = payload.gatewayApiKey;
  process.env.COMPANY_GATEWAY_API_KEY = payload.gatewayApiKey;
  process.env.GATEWAY_API_KEY = payload.gatewayApiKey;
  process.env.CREATIVE_STUDIO_COS_SECRET_ID = payload.cos.secretId;
  process.env.CREATIVE_STUDIO_COS_SECRET_KEY = payload.cos.secretKey;
  process.env.CREATIVE_STUDIO_COS_DOMAIN = payload.cos.domain;
  if (payload.cos.signHost) process.env.CREATIVE_STUDIO_COS_SIGN_HOST = payload.cos.signHost;
  if (payload.cos.prefix) process.env.CREATIVE_STUDIO_COS_PREFIX = payload.cos.prefix;
  if (payload.cos.ttlSec !== undefined) process.env.CREATIVE_STUDIO_COS_URL_TTL_SEC = String(payload.cos.ttlSec);
}

export function readProvisioningState(root = dataRoot()): ProvisioningStateV2 | null {
  const paths = pathsFor(root);
  try {
    const stateBytes = fs.readFileSync(paths.statePath);
    if (stateBytes.length > MAX_PROVISIONING_STATE_FILE_BYTES) return null;
    const parsed = parseProvisioningState(JSON.parse(stateBytes.toString('utf8')));
    if (!parsed) return null;
    const runtimeBytes = fs.readFileSync(paths.runtimeEnvPath);
    if (runtimeBytes.length > 128 * 1024) return null;
    const runtimeValues = parseRuntimeEnv(runtimeBytes.toString('utf8'));
    if (REQUIRED_RUNTIME_ENV_KEYS.some((key) => !runtimeValues[key] || !runtimeValues[key].trim())) return null;
    const configBytes = fs.readFileSync(paths.configPath);
    if (configBytes.length > MAX_LITE_LLM_CONFIG_BYTES) return null;
    const actualHash = crypto.createHash('sha256').update(configBytes).digest('hex');
    if (actualHash !== parsed.configHash) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readProvisioningStatus(root = dataRoot()): ProvisioningStatus {
  const state = readProvisioningState(root);
  if (!state) return { configured: false, profileName: null, importedAt: null, configHashPrefix: null };
  return {
    configured: true,
    profileName: state.profileName,
    importedAt: state.importedAt,
    configHashPrefix: state.configHash.slice(0, 12),
  };
}
