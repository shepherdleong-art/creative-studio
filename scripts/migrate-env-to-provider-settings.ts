import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

type EnvMap = Record<string, string>;
type ApiStyle = 'gemini' | 'openai-compatible';

interface ScriptProviderConfig {
  id: string;
  name: string;
  apiStyle: ApiStyle;
  keyEnv: string;
  baseUrlEnv: string;
  modelEnv: string;
}

interface EnvLine {
  raw: string;
  key?: string;
  value?: string;
}

interface UpdateSummary {
  category: 'image' | 'script' | 'video';
  providerId: string;
  providerName: string;
  fields: string[];
}

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const redactEnv = args.has('--redact-env');
const envPath = path.join(process.cwd(), '.env.local');
const dbPath = path.join(process.cwd(), 'data', 'workbench.db');
const defaultScriptProviderConfigs: ScriptProviderConfig[] = [
  {
    id: 'gemini',
    name: 'Gemini',
    apiStyle: 'openai-compatible',
    keyEnv: 'GEMINI_API_KEY',
    baseUrlEnv: 'GEMINI_BASE_URL',
    modelEnv: 'GEMINI_MODEL',
  },
  {
    id: 'qwen',
    name: '通义千问',
    apiStyle: 'openai-compatible',
    keyEnv: 'QWEN_API_KEY',
    baseUrlEnv: 'QWEN_BASE_URL',
    modelEnv: 'QWEN_MODEL',
  },
  {
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    apiStyle: 'openai-compatible',
    keyEnv: 'KIMI_API_KEY',
    baseUrlEnv: 'KIMI_BASE_URL',
    modelEnv: 'KIMI_MODEL',
  },
  {
    id: 'gpt',
    name: 'GPT / OpenAI',
    apiStyle: 'openai-compatible',
    keyEnv: 'GPT_API_KEY',
    baseUrlEnv: 'GPT_BASE_URL',
    modelEnv: 'GPT_MODEL',
  },
];

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvFile(filePath: string): { env: EnvMap; lines: EnvLine[] } {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).map((raw) => {
    const match = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return { raw };
    return { raw, key: match[1], value: parseEnvValue(match[2]) };
  });
  const env: EnvMap = {};
  for (const line of lines) {
    if (line.key) env[line.key] = line.value || '';
  }
  return { env, lines };
}

function isReal(value: string | undefined): value is string {
  const trimmed = (value || '').trim();
  return Boolean(trimmed) && !isPlaceholderValue(trimmed);
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes('example.com')) return true;
  if (/(?<![a-zA-Z-])your-/i.test(normalized)) return true;
  return false;
}

function compactFields(fields: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (isReal(value)) output[field] = value.trim();
  }
  return output;
}

function updateRow(
  table: string,
  id: string,
  fields: Record<string, string>,
  applyChanges: boolean
): string[] {
  const entries = Object.entries(fields);
  if (entries.length === 0) return [];
  if (applyChanges) {
    const assignments = entries.map(([field]) => `${field} = ?`).join(', ');
    db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(
      ...entries.map(([, value]) => value),
      id
    );
  }
  return entries.map(([field]) => field);
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function imageBaseUrlCandidates(apiKeyEnv: string): string[] {
  const prefix = apiKeyEnv.replace(/_API_KEY$/, '');
  const candidates = [`${prefix}_BASE_URL`];
  if (prefix === 'PACKY_IMAGE') candidates.push('PACKY_BASE_URL');
  return candidates;
}

function firstReal(env: EnvMap, keys: string[]): { key?: string; value?: string } {
  for (const key of keys) {
    if (isReal(env[key])) return { key, value: env[key] };
  }
  return {};
}

function redactEnvFile(lines: EnvLine[], keysToRedact: Set<string>): void {
  const backupPath = `${envPath}.backup-${timestamp()}`;
  fs.copyFileSync(envPath, backupPath);
  const next = lines.map((line) => {
    if (!line.key || !keysToRedact.has(line.key)) return line.raw;
    return `${line.key}=`;
  }).join('\n');
  fs.writeFileSync(envPath, next.endsWith('\n') ? next : `${next}\n`);
  console.log(`env backup: ${path.relative(process.cwd(), backupPath)}`);
  console.log(`redacted env keys: ${keysToRedact.size}`);
}

if (!fs.existsSync(envPath)) {
  console.error('.env.local not found');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error('data/workbench.db not found; start the app once before running this migration');
  process.exit(1);
}

const { env, lines } = parseEnvFile(envPath);
const db = new Database(dbPath);
const summaries: UpdateSummary[] = [];
const keysToRedact = new Set<string>();

const imageProviders = db.prepare(`
  SELECT id, name, apiKeyEnv
  FROM providers
  ORDER BY name
`).all() as Array<{ id: string; name: string; apiKeyEnv: string }>;

for (const provider of imageProviders) {
  const fields: Record<string, string | undefined> = {};
  if (isReal(env[provider.apiKeyEnv])) {
    fields.apiKey = env[provider.apiKeyEnv];
    keysToRedact.add(provider.apiKeyEnv);
  }
  const baseUrl = firstReal(env, imageBaseUrlCandidates(provider.apiKeyEnv));
  if (baseUrl.value && baseUrl.key) {
    fields.baseUrl = baseUrl.value;
    keysToRedact.add(baseUrl.key);
  }
  const updated = updateRow('providers', provider.id, compactFields(fields), apply);
  if (updated.length > 0) {
    summaries.push({
      category: 'image',
      providerId: provider.id,
      providerName: provider.name,
      fields: updated,
    });
  }
}

for (const config of defaultScriptProviderConfigs) {
  const fields = compactFields({
    baseUrl: env[config.baseUrlEnv],
    apiKey: env[config.keyEnv],
    model: env[config.modelEnv],
  });
  if (fields.baseUrl) keysToRedact.add(config.baseUrlEnv);
  if (fields.apiKey) keysToRedact.add(config.keyEnv);
  if (fields.model) keysToRedact.add(config.modelEnv);
  const updated = updateRow('script_providers', config.id, fields, apply);
  if (updated.length > 0) {
    summaries.push({
      category: 'script',
      providerId: config.id,
      providerName: config.name,
      fields: updated,
    });
  }
}

const videoProviders = db.prepare(`
  SELECT id, name, type, baseUrlEnv, apiKeyEnv, modelEnv
  FROM video_providers
  ORDER BY name
`).all() as Array<{
  id: string;
  name: string;
  type: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  modelEnv: string;
}>;

for (const provider of videoProviders) {
  const fields: Record<string, string | undefined> = {
    baseUrl: env[provider.baseUrlEnv],
    defaultModel: env[provider.modelEnv],
  };
  if (isReal(fields.baseUrl)) keysToRedact.add(provider.baseUrlEnv);
  if (isReal(fields.defaultModel)) keysToRedact.add(provider.modelEnv);

  if (provider.type === 'kling') {
    if (isReal(env.KLING_VIDEO_ACCESS_KEY)) {
      fields.accessKey = env.KLING_VIDEO_ACCESS_KEY;
      keysToRedact.add('KLING_VIDEO_ACCESS_KEY');
    }
    if (isReal(env.KLING_VIDEO_SECRET_KEY)) {
      fields.secretKey = env.KLING_VIDEO_SECRET_KEY;
      keysToRedact.add('KLING_VIDEO_SECRET_KEY');
    }
    if (isReal(env[provider.apiKeyEnv])) {
      fields.apiKey = env[provider.apiKeyEnv];
      keysToRedact.add(provider.apiKeyEnv);
    }
  } else if (isReal(env[provider.apiKeyEnv])) {
    fields.apiKey = env[provider.apiKeyEnv];
    keysToRedact.add(provider.apiKeyEnv);
  }

  const updated = updateRow('video_providers', provider.id, compactFields(fields), apply);
  if (updated.length > 0) {
    summaries.push({
      category: 'video',
      providerId: provider.id,
      providerName: provider.name,
      fields: updated,
    });
  }
}

console.log(apply ? 'mode: applied' : 'mode: dry-run');
for (const summary of summaries) {
  console.log(`${summary.category}/${summary.providerId}: ${summary.fields.join(', ')}`);
}
console.log(`providers touched: ${summaries.length}`);
console.log(`env keys eligible for redaction: ${keysToRedact.size}`);

if (apply && redactEnv) {
  redactEnvFile(lines, keysToRedact);
} else if (redactEnv && !apply) {
  console.log('redaction skipped in dry-run; add --apply to modify files');
}

db.close();
