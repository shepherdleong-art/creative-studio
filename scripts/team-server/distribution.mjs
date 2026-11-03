import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const localForbiddenSpec = path.join(moduleRoot, 'packaging', 'forbidden-paths.json');
const forbiddenSpecPath = fs.existsSync(localForbiddenSpec)
  ? localForbiddenSpec
  : path.join(moduleRoot, '..', 'packaging', 'forbidden-paths.json');
export const forbiddenSpec = JSON.parse(fs.readFileSync(forbiddenSpecPath, 'utf8'));
const TEXT_EXTENSIONS = new Set(['.cmd', '.css', '.html', '.js', '.json', '.map', '.md', '.mjs', '.cjs', '.ps1', '.py', '.txt', '.ts', '.tsx', '.xml', '.yaml', '.yml', '.pem', '.env']);
const PRIVATE_KEY_PEM = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function walkPayload(root) {
  const result = [];
  const pending = [path.resolve(root)];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('分发负载不得包含符号链接或目录链接');
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) result.push(absolute);
      else throw new Error('分发负载只允许普通文件和目录');
    }
  }
  return result.sort();
}

export function relativePayloadPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

export function assertExactTopLevel(root, consumer) {
  const expected = [...forbiddenSpec.consumers[consumer].topLevel].sort();
  const actual = fs.readdirSync(root).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${consumer} 顶层白名单不符：${actual.join(',')}`);
  }
  for (const name of forbiddenSpec.consumers[consumer].forbidden) {
    if (fs.existsSync(path.join(root, name))) throw new Error(`${consumer} 包含禁入根路径：${name}`);
  }
}

export function scanDistributionPayload(root, profile, secretCandidates = []) {
  const files = walkPayload(root);
  const errors = [];
  for (const file of files) {
    const relative = relativePayloadPath(root, file);
    const basename = path.basename(file).toLowerCase();
    if (basename === '.env' || basename.startsWith('.env.') || basename === 'config.yaml' || basename.startsWith('config.yaml.')) {
      errors.push(`环境/网关配置不得入包：${relative}`);
    }
    if (/\.(?:db|db-wal|db-shm|sqlite|sqlite3)$/i.test(basename)) errors.push(`数据库不得入包：${relative}`);
    if (profile === 'teamClient' && /(?:private|secret|credential)/i.test(basename) && basename !== 'update-public-key.pem') {
      errors.push(`敏感文件名不得入包：${relative}`);
    }
    if (profile === 'teamClient' && (/\.node$/i.test(basename) || /^(?:ffmpeg|ffprobe|python|node)(?:\.exe)?$/i.test(basename))) {
      errors.push(`轻客户端不得包含生产原生负载：${relative}`);
    }
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) || fs.statSync(file).size > 32 * 1024 * 1024) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (PRIVATE_KEY_PEM.test(text)) errors.push(`私钥不得入包：${relative}`);
    for (const candidate of secretCandidates) {
      if (typeof candidate.value === 'string' && candidate.value.length >= 8 && text.includes(candidate.value)) {
        errors.push(`敏感值 ${candidate.label} 出现在负载：${relative}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { ok: true, files: files.length };
}

export function writeReleaseManifest(root, { releaseId, appVersion, sourceCommit, fixture = false }) {
  const lockPath = path.join(root, 'service', 'distribution-lock.json');
  const files = walkPayload(root)
    .filter((file) => path.resolve(file) !== path.resolve(path.join(root, 'release-manifest.json')))
    .map((file) => ({
      path: relativePayloadPath(root, file),
      size: fs.statSync(file).size,
      sha256: sha256File(file),
    }));
  const manifest = {
    schemaVersion: 1,
    mode: 'windows-team-server-v1',
    releaseId,
    appVersion,
    builtAt: new Date().toISOString(),
    sourceCommit,
    fixture,
    dependencyLockSha256: sha256File(lockPath),
    files,
  };
  fs.writeFileSync(path.join(root, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return manifest;
}

function assertSafeManifestPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('release manifest 含非法路径');
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('release manifest 含越界路径');
  return value;
}

export function verifyReleaseManifest(root, { allowFixture = false } = {}) {
  const manifestPath = path.join(root, 'release-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (manifest.schemaVersion !== 1 || manifest.mode !== 'windows-team-server-v1'
    || !Array.isArray(manifest.files) || manifest.files.length === 0
    || (manifest.fixture === true && !allowFixture)) throw new Error('release manifest 不是可安装的正式 server 包');
  const expected = new Set();
  for (const entry of manifest.files) {
    const relative = assertSafeManifestPath(entry.path);
    if (relative === 'release-manifest.json' || expected.has(relative) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('release manifest 条目无效或重复');
    expected.add(relative);
    const file = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(file) || fs.statSync(file).size !== entry.size || sha256File(file) !== entry.sha256) {
      throw new Error(`release 文件哈希不符：${relative}`);
    }
  }
  const actual = walkPayload(root).map((file) => relativePayloadPath(root, file))
    .filter((relative) => relative !== 'release-manifest.json');
  if (actual.length !== expected.size || actual.some((relative) => !expected.has(relative))) {
    throw new Error('release 含 manifest 未登记的文件');
  }
  assertExactTopLevel(root, 'serverReleaseGuard');
  scanDistributionPayload(root, 'server');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'service', 'distribution-lock.json'), 'utf8'));
  if (sha256File(path.join(root, 'service', 'distribution-lock.json')) !== manifest.dependencyLockSha256) {
    throw new Error('依赖锁与 release manifest 不符');
  }
  const binaryChecks = [
    [path.join(root, 'runtimes', 'node', 'node.exe'), lock.node.binarySha256],
    [path.join(root, 'tools', 'caddy', 'caddy.exe'), lock.caddy.binarySha256],
    [path.join(root, 'tools', 'winsw', 'WinSW.exe'), lock.winsw.sha256],
  ];
  for (const media of lock.media) {
    for (const entry of media.files) binaryChecks.push([path.join(root, 'app', ...entry.path.split('/')), entry.sha256]);
  }
  for (const [file, expectedHash] of binaryChecks) {
    if (!/^[0-9a-f]{64}$/.test(expectedHash ?? '') || !fs.existsSync(file) || sha256File(file) !== expectedHash) {
      throw new Error(`锁定运行时或媒体负载哈希不符：${relativePayloadPath(root, file)}`);
    }
  }
  const pythonManifest = path.join(root, 'runtimes', 'python', 'runtime-manifest.json');
  if (fs.existsSync(pythonManifest)) {
    const python = JSON.parse(fs.readFileSync(pythonManifest, 'utf8'));
    if (python.pythonVersion !== lock.python.version || python.litellmVersion !== lock.python.litellmVersion
      || python.archiveSha256 !== lock.python.sha256) throw new Error('Python/LiteLLM 运行时与受控锁不符');
  }
  return manifest;
}
