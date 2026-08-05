import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDb } from '../db.ts';
import { dataRoot } from '../data-root.ts';
import { decryptProvisioningPayload, MAX_PROVISIONING_FILE_BYTES } from './crypto.ts';
import { configHashPrefix, validateProvisioningPayload } from './schema.ts';
import type { ProvisioningPayload, ProvisioningStatus } from './types.ts';

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

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeTempPath(target: string, suffix: string): string {
  return `${target}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.${suffix}`;
}

function writeTemp(target: string, bytes: Buffer): string {
  ensureParent(target);
  const temp = safeTempPath(target, 'tmp');
  const handle = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return temp;
}

function snapshot(filePath: string): FileSnapshot {
  if (!fs.existsSync(filePath)) return { path: filePath, existed: false, bytes: null, backupPath: null };
  return { path: filePath, existed: true, bytes: fs.readFileSync(filePath), backupPath: null };
}

function installFiles(writes: Array<{ path: string; bytes: Buffer }>, snapshots: FileSnapshot[]): void {
  const temps = writes.map((write) => ({ ...write, temp: writeTemp(write.path, write.bytes) }));
  try {
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

  db.transaction(() => {
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
  })();
}

export function applyProvisioningPayload(input: unknown, options: ApplyProvisioningOptions = {}): ProvisioningStatus {
  const payload = validateProvisioningPayload(input);
  const root = options.root || dataRoot();
  const paths = pathsFor(root);
  const importedAt = (options.now || new Date()).toISOString();
  const state = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    profileName: payload.profileName,
    importedAt,
    configHash: crypto.createHash('sha256').update(payload.liteLlmConfigYaml, 'utf8').digest('hex'),
  }) + '\n', 'utf8');
  const writes = [
    { path: paths.configPath, bytes: Buffer.from(payload.liteLlmConfigYaml, 'utf8') },
    { path: paths.runtimeEnvPath, bytes: runtimeEnvText(payload) },
    { path: paths.statePath, bytes: state },
  ];
  const snapshots = writes.map((write) => snapshot(write.path));
  try {
    installFiles(writes, snapshots);
    upsertDatabase(payload, options.db || getDb(), importedAt);
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

export function readProvisioningStatus(root = dataRoot()): ProvisioningStatus {
  const paths = pathsFor(root);
  const statePath = paths.statePath;
  if (!fs.existsSync(statePath) || !fs.existsSync(paths.configPath) || !fs.existsSync(paths.runtimeEnvPath)) {
    return { configured: false, profileName: null, importedAt: null, configHashPrefix: null };
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const row = value as Record<string, unknown>;
    const profileName = typeof row.profileName === 'string' && row.profileName.length <= 128 ? row.profileName : null;
    const importedAt = typeof row.importedAt === 'string' && row.importedAt.length <= 64 ? row.importedAt : null;
    const configHash = typeof row.configHash === 'string' && /^[a-f0-9]{64}$/i.test(row.configHash) ? row.configHash : '';
    if (!profileName || !importedAt || !configHash) return { configured: false, profileName: null, importedAt: null, configHashPrefix: null };
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(paths.configPath)).digest('hex');
    if (actualHash.toLowerCase() !== configHash.toLowerCase()) return { configured: false, profileName: null, importedAt: null, configHashPrefix: null };
    return { configured: true, profileName, importedAt, configHashPrefix: configHash.slice(0, 12) };
  } catch {
    return { configured: false, profileName: null, importedAt: null, configHashPrefix: null };
  }
}
