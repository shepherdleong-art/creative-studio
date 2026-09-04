import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import yaml from 'js-yaml';

const ALLOWED_ENV_NAMES = [
  'CREATIVE_STUDIO_COS_SECRET_ID',
  'CREATIVE_STUDIO_COS_SECRET_KEY',
  'CREATIVE_STUDIO_COS_DOMAIN',
  'CREATIVE_STUDIO_COS_PREFIX',
  'CREATIVE_STUDIO_COS_SIGN_HOST',
  'DOUBAO_TTS_API_KEY',
  'CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER',
];

const REQUIRED_MODEL_ALIASES = [
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast-260128',
  'doubao-seedream-5-0-image',
  'image2-high',
  'image2-medium',
  'image2-low',
  'qiniuyun/gpt-image-2-medium',
  'nano-banana-2.5',
  'nano-banana-3.0',
  'nano-banana-3.1',
  'kling-1.6',
  'kling-2.0',
  'kling-2.1',
  'kling-2.5',
  'kling-2.6',
  'kling-3.0',
  'kling-3.0-Omni',
  'kling-O1',
  'GPT-5-6-Luna-Standard',
  'GPT-5-5',
];

const TEXT_EXTENSIONS = new Set([
  '.cmd', '.css', '.html', '.js', '.json', '.map', '.md', '.mjs', '.cjs',
  '.ps1', '.py', '.txt', '.ts', '.tsx', '.yaml', '.yml',
]);

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseEnv(filePath, errors) {
  const values = new Map();
  for (const [index, rawLine] of fs.readFileSync(filePath, 'utf8').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      errors.push(`.env.local 第 ${index + 1} 行格式无效`);
      continue;
    }
    const [, name, rawValue] = match;
    if (values.has(name)) errors.push(`.env.local 重复变量：${name}`);
    values.set(name, unquote(rawValue));
  }

  const allowed = new Set(ALLOWED_ENV_NAMES);
  for (const name of values.keys()) {
    if (!allowed.has(name)) errors.push(`.env.local 包含未审核变量：${name}`);
  }
  for (const name of ALLOWED_ENV_NAMES) {
    if (!values.has(name)) errors.push(`.env.local 缺少变量：${name}`);
    else if (!values.get(name)) errors.push(`.env.local 变量为空：${name}`);
  }
  if (values.get('CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER') !== '1') {
    errors.push('CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER 必须为 1');
  }
  return values;
}

function parseConfig(filePath, errors) {
  const text = fs.readFileSync(filePath, 'utf8');
  let config;
  try {
    config = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch {
    errors.push('config.yaml 不是有效且无重复键的 YAML');
    return [];
  }

  const isRecord = (value) => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
  );
  const assertExactFields = (value, expected, label) => {
    if (!isRecord(value)) {
      errors.push(`config.yaml 的 ${label} 必须是对象`);
      return false;
    }
    const actual = Object.keys(value);
    for (const name of expected) {
      if (!actual.includes(name)) errors.push(`config.yaml 的 ${label} 缺少字段：${name}`);
    }
    for (const name of actual) {
      if (!expected.includes(name)) errors.push(`config.yaml 的 ${label} 包含未审核字段：${name}`);
    }
    return true;
  };

  if (!assertExactFields(
    config,
    ['model_list', 'router_settings', 'num_retries', 'timeout', 'litellm_settings'],
    '顶层',
  )) return [];

  if (!Array.isArray(config.model_list)) {
    errors.push('config.yaml 的 model_list 必须是数组');
  }
  const models = Array.isArray(config.model_list) ? config.model_list : [];
  const aliases = [];
  const apiKeys = [];
  models.forEach((entry, index) => {
    const label = `model_list[${index}]`;
    if (!assertExactFields(entry, ['model_name', 'litellm_params'], label)) return;
    const alias = typeof entry.model_name === 'string' ? entry.model_name.trim() : '';
    aliases.push(alias);
    if (!alias) errors.push(`config.yaml 的 ${label}.model_name 必须是非空字符串`);
    const safeModelLabel = REQUIRED_MODEL_ALIASES.includes(alias) ? alias : `#${index + 1}`;

    if (!assertExactFields(entry.litellm_params, ['model', 'api_base', 'api_key'], `${label}.litellm_params`)) {
      return;
    }
    const params = entry.litellm_params;
    if (typeof params.model !== 'string' || !params.model.trim()) {
      errors.push(`config.yaml 模型 ${safeModelLabel} 的 model 必须是非空字符串`);
    }
    if (typeof params.api_base !== 'string' || !/^https:\/\//i.test(params.api_base.trim())) {
      errors.push(`config.yaml 模型 ${safeModelLabel} 的 api_base 必须是 HTTPS 地址`);
    }
    const apiKey = typeof params.api_key === 'string' ? params.api_key.trim() : '';
    apiKeys.push(apiKey);
    if (!apiKey || /your-|example|placeholder|changeme|os\.environ|\$\{/i.test(apiKey)) {
      errors.push(`config.yaml 模型 ${safeModelLabel} 的 api_key 为空或仍是占位值`);
    }
  });

  if (assertExactFields(config.router_settings, ['routing_strategy'], 'router_settings')) {
    if (typeof config.router_settings.routing_strategy !== 'string' || !config.router_settings.routing_strategy.trim()) {
      errors.push('config.yaml 的 router_settings.routing_strategy 必须是非空字符串');
    }
  }
  if (!Number.isInteger(config.num_retries) || config.num_retries < 0) {
    errors.push('config.yaml 的 num_retries 必须是非负整数');
  }
  if (typeof config.timeout !== 'number' || !Number.isFinite(config.timeout) || config.timeout <= 0) {
    errors.push('config.yaml 的 timeout 必须是正数');
  }
  if (assertExactFields(config.litellm_settings, ['drop_params'], 'litellm_settings')) {
    if (typeof config.litellm_settings.drop_params !== 'boolean') {
      errors.push('config.yaml 的 litellm_settings.drop_params 必须是布尔值');
    }
  }

  const actual = new Set(aliases);
  const required = new Set(REQUIRED_MODEL_ALIASES);
  for (const alias of REQUIRED_MODEL_ALIASES) {
    if (!actual.has(alias)) errors.push(`config.yaml 缺少模型别名：${alias}`);
  }
  for (const [index, alias] of aliases.entries()) {
    if (!required.has(alias)) errors.push(`config.yaml 的 model_list[${index}] 包含未审核模型别名`);
  }
  if (aliases.length !== actual.size) errors.push('config.yaml 存在重复 model_name');
  return apiKeys;
}

function walk(root, visit) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      visit(absolute, entry);
      if (entry.isDirectory()) pending.push(absolute);
    }
  }
}

function findForbiddenFiles(payloadRoot, errors) {
  const forbiddenRoots = new Set([
    '.venv-litellm', 'data', 'storage', 'outputs', 'docs', '.git', '.cache',
    'dist', 'desktop', 'installer',
  ]);
  for (const name of forbiddenRoots) {
    if (fs.existsSync(path.join(payloadRoot, name))) errors.push(`payload 包含禁止根路径：${name}`);
  }

  const desktopRoot = path.join(payloadRoot, 'dist-desktop');
  const allowedDesktopFiles = new Set(['main.js', 'preload.js', 'service.js', 'ipc.js']);
  if (fs.existsSync(desktopRoot)) {
    walk(desktopRoot, (absolute, entry) => {
      const relative = path.relative(desktopRoot, absolute).split(path.sep).join('/');
      if (entry.isDirectory() || entry.isSymbolicLink() || !allowedDesktopFiles.has(relative)) {
        errors.push(`dist-desktop 包含未审核构建产物：${relative}`);
      }
    });
  }

  walk(payloadRoot, (absolute, entry) => {
    if (!entry.isFile() && !entry.isSymbolicLink()) return;
    const relative = path.relative(payloadRoot, absolute).split(path.sep).join('/');
    const basename = entry.name.toLocaleLowerCase('en-US');
    const allowedCredentialFile = relative === '.env.local' || relative === 'config.yaml';
    if (!allowedCredentialFile && (basename === '.env' || basename.startsWith('.env.'))) {
      errors.push(`payload 包含嵌套环境文件：${relative}`);
    }
    if (!allowedCredentialFile && (basename === 'config.yaml' || basename.startsWith('config.yaml.'))) {
      errors.push(`payload 包含嵌套/备份网关配置：${relative}`);
    }
    if (/\.(?:db|db-wal|db-shm|sqlite|sqlite3)$/i.test(basename)) {
      errors.push(`payload 包含数据库文件：${relative}`);
    }
  });
}

function scanSecretCopies(payloadRoot, candidates, errors) {
  const scanRoots = ['.next/standalone', 'dist-desktop', 'scripts'];
  const scanFiles = [];
  for (const relativeRoot of scanRoots) {
    const absoluteRoot = path.join(payloadRoot, ...relativeRoot.split('/'));
    if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) continue;
    walk(absoluteRoot, (absolute, entry) => {
      if (entry.isFile()) scanFiles.push(absolute);
    });
  }
  for (const entry of fs.readdirSync(payloadRoot, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'config.yaml' || entry.name === '.env.local') continue;
    scanFiles.push(path.join(payloadRoot, entry.name));
  }

  for (const filePath of scanFiles) {
    const extension = path.extname(filePath).toLocaleLowerCase('en-US');
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const stat = fs.statSync(filePath);
    if (stat.size > 32 * 1024 * 1024) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const candidate of candidates) {
      if (text.includes(candidate.value)) {
        const relative = path.relative(payloadRoot, filePath).split(path.sep).join('/');
        errors.push(`敏感值 ${candidate.label} 出现在允许位置之外：${relative}`);
      }
    }
  }
}

export function verifyPortablePayload(payloadPath) {
  const payloadRoot = path.resolve(payloadPath);
  const errors = [];
  if (!fs.existsSync(payloadRoot) || !fs.statSync(payloadRoot).isDirectory()) {
    return { ok: false, errors: ['payload 目录不存在'] };
  }
  const envPath = path.join(payloadRoot, '.env.local');
  const configPath = path.join(payloadRoot, 'config.yaml');
  if (!fs.existsSync(envPath)) errors.push('payload 缺少 .env.local');
  if (!fs.existsSync(configPath)) errors.push('payload 缺少 config.yaml');
  if (errors.length > 0) return { ok: false, errors };

  const envValues = parseEnv(envPath, errors);
  const configKeys = parseConfig(configPath, errors);
  findForbiddenFiles(payloadRoot, errors);

  const candidates = [];
  for (const [name, value] of envValues) {
    if (/(?:SECRET|API_KEY)/.test(name) && value.length >= 8) {
      candidates.push({ label: `.env.local:${name}`, value });
    }
  }
  configKeys.forEach((value, index) => {
    if (value.length >= 8) candidates.push({ label: `config.yaml:api_key#${index + 1}`, value });
  });
  scanSecretCopies(payloadRoot, candidates, errors);
  return { ok: errors.length === 0, errors };
}

const payload = readArg('--payload');
if (!payload) {
  console.error('payload 验证失败：缺少 --payload 参数');
  process.exitCode = 1;
} else {
  const result = verifyPortablePayload(payload);
  if (result.ok) {
    console.log('payload 敏感边界扫描通过。');
  } else {
    for (const error of result.errors) console.error(`payload 验证失败：${error}`);
    process.exitCode = 1;
  }
}
