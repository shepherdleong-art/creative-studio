import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const forbiddenPath = process.env.CREATIVE_STUDIO_APPLICATION_ROOT?.trim()
  ? path.join(process.env.CREATIVE_STUDIO_APPLICATION_ROOT, 'scripts', 'packaging', 'forbidden-paths.json')
  : path.resolve('scripts/packaging/forbidden-paths.json');
const forbiddenSpec = JSON.parse(fs.readFileSync(forbiddenPath, 'utf8')) as {
  consumers: Record<string, { topLevel: string[]; forbidden: string[] }>;
};

const TEXT_EXTENSIONS = new Set(['.cmd', '.css', '.html', '.js', '.json', '.map', '.md', '.mjs', '.cjs', '.ps1', '.py', '.txt', '.ts', '.tsx', '.xml', '.yaml', '.yml', '.pem', '.env', '.upload']);
const PRIVATE_KEY_PEM = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
export interface ServerReleaseCompatibility {
  minAppVersion: string;
  maxAppVersion: string;
  dataSchemaMin: number;
  dataSchemaMax: number;
}
export interface ServerReleaseManifest {
  schemaVersion: 1;
  mode: 'windows-team-server-v1';
  releaseId: string;
  appVersion: string;
  builtAt: string;
  sourceCommit: string;
  fixture: boolean;
  compatibility: ServerReleaseCompatibility;
  dependencyLockSha256: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}
export function assertServerReleaseCompatibility(value: unknown): ServerReleaseCompatibility {
  const item = value as ServerReleaseCompatibility | null;
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!item || !semver.test(item.minAppVersion) || !semver.test(item.maxAppVersion)
    || !Number.isSafeInteger(item.dataSchemaMin) || item.dataSchemaMin < 1
    || !Number.isSafeInteger(item.dataSchemaMax) || item.dataSchemaMax < item.dataSchemaMin) {
    throw new Error('release manifest 缺少有效的应用／数据兼容范围');
  }
  return { minAppVersion: item.minAppVersion, maxAppVersion: item.maxAppVersion,
    dataSchemaMin: item.dataSchemaMin, dataSchemaMax: item.dataSchemaMax };
}
export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
export function walkPayload(root: string): string[] {
  const result: string[] = [];
  const pending = [path.resolve(root)];
  while (pending.length) {
    const directory = pending.pop()!;
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
export function relativePayloadPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
export function assertExactTopLevel(root: string, consumer: string): void {
  const spec = forbiddenSpec.consumers[consumer as keyof typeof forbiddenSpec.consumers] as { topLevel: string[]; forbidden: string[] };
  const expected = [...spec.topLevel].toSorted();
  const actual = fs.readdirSync(root).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${consumer} 顶层白名单不符：${actual.join(',')}`);
  for (const name of spec.forbidden) if (fs.existsSync(path.join(root, name))) throw new Error(`${consumer} 包含禁入根路径：${name}`);
}
export function scanDistributionPayload(root: string, profile: string, secretCandidates: Array<{ label: string; value: string }> = []): { ok: boolean; files: number } {
  const files = walkPayload(root);
  const errors: string[] = [];
  for (const file of files) {
    const relative = relativePayloadPath(root, file);
    const basename = path.basename(file).toLowerCase();
    if (basename === '.env' || basename.startsWith('.env.') || basename === 'config.yaml' || basename.startsWith('config.yaml.')) errors.push(`环境/网关配置不得入包：${relative}`);
    if (/\.(?:db|db-wal|db-shm|sqlite|sqlite3)$/i.test(basename)) errors.push(`数据库不得入包：${relative}`);
    if (profile === 'teamClient' && /(?:private|secret|credential)/i.test(basename) && basename !== 'update-public-key.pem') errors.push(`敏感文件名不得入包：${relative}`);
    if (profile === 'teamClient' && (/\.node$/i.test(basename) || /^(?:ffmpeg|ffprobe|python|node)(?:\.exe)?$/i.test(basename))) errors.push(`轻客户端不得包含生产原生负载：${relative}`);
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) || fs.statSync(file).size > 32 * 1024 * 1024) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (PRIVATE_KEY_PEM.test(text)) errors.push(`私钥不得入包：${relative}`);
    for (const candidate of secretCandidates) {
      if (typeof candidate.value === 'string' && candidate.value.length >= 8 && text.includes(candidate.value)) errors.push(`敏感值 ${candidate.label} 出现在负载：${relative}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { ok: true, files: files.length };
}
export function writeReleaseManifest(root: string, options: {
  releaseId: string; appVersion: string; sourceCommit: string; fixture?: boolean;
  compatibility: ServerReleaseCompatibility;
}): ServerReleaseManifest {
  const lockPath = path.join(root, 'service', 'distribution-lock.json');
  const files = walkPayload(root).filter((file) => path.resolve(file) !== path.resolve(path.join(root, 'release-manifest.json')))
    .map((file) => ({ path: relativePayloadPath(root, file), size: fs.statSync(file).size, sha256: sha256File(file) }));
  const manifest: ServerReleaseManifest = { schemaVersion: 1, mode: 'windows-team-server-v1',
    releaseId: options.releaseId, appVersion: options.appVersion, builtAt: new Date().toISOString(),
    sourceCommit: options.sourceCommit, fixture: options.fixture === true,
    compatibility: assertServerReleaseCompatibility(options.compatibility), dependencyLockSha256: sha256File(lockPath), files };
  fs.writeFileSync(path.join(root, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return manifest;
}
function assertSafeManifestPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('release manifest 含非法路径');
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('release manifest 含越界路径');
  return value;
}
export function assertRunnableServerPayload(root: string): void {
  for (const relative of ['app/server.js', 'app/runtime/team-server-entry.cjs', 'runtimes/node/node.exe',
    'tools/caddy/caddy.exe', 'tools/winsw/WinSW.exe', 'app/scripts/team-server/maintenance.mjs']) {
    const target = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) throw new Error(`发布包缺少必需运行入口：${relative}`);
  }
}
function assertManifestIdentity(manifest: ServerReleaseManifest): void {
  if (manifest.schemaVersion !== 1 || manifest.mode !== 'windows-team-server-v1'
    || !Array.isArray(manifest.files) || manifest.files.length === 0
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.releaseId) || manifest.releaseId.includes('..')
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.appVersion)
    || typeof manifest.sourceCommit !== 'string' || !manifest.sourceCommit.trim()
    || typeof manifest.builtAt !== 'string' || !Number.isFinite(Date.parse(manifest.builtAt))
    || typeof manifest.fixture !== 'boolean' || !/^[0-9a-f]{64}$/.test(manifest.dependencyLockSha256)) {
    throw new Error('release manifest 不是可安装的正式 server 包');
  }
}
export function verifyReleaseManifest(root: string, { allowFixture = false }: { allowFixture?: boolean } = {}): ServerReleaseManifest {
  const manifestPath = path.join(root, 'release-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as ServerReleaseManifest;
  assertManifestIdentity(manifest);
  if (manifest.fixture && !allowFixture) throw new Error('release manifest 不是可安装的正式 server 包');
  assertServerReleaseCompatibility(manifest.compatibility);
  assertRunnableServerPayload(root);
  const expected = new Set<string>();
  for (const entry of manifest.files) {
    const relative = assertSafeManifestPath(entry.path);
    if (relative === 'release-manifest.json' || expected.has(relative) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('release manifest 条目无效或重复');
    expected.add(relative);
    const file = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(file) || fs.statSync(file).size !== entry.size || sha256File(file) !== entry.sha256) throw new Error(`release 文件哈希不符：${relative}`);
  }
  const actual = walkPayload(root).map((file) => relativePayloadPath(root, file)).filter((relative) => relative !== 'release-manifest.json');
  if (actual.length !== expected.size || actual.some((relative) => !expected.has(relative))) throw new Error('release 含 manifest 未登记的文件');
  assertExactTopLevel(root, 'serverReleaseGuard');
  scanDistributionPayload(root, 'server');
  const lockPath = path.join(root, 'service', 'distribution-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
    node: { binarySha256: string }; caddy: { binarySha256: string }; winsw: { sha256: string };
    python: { version: string; litellmVersion: string; sha256: string };
    media: Array<{ files: Array<{ path: string; sha256: string }> }>;
  };
  if (sha256File(lockPath) !== manifest.dependencyLockSha256) throw new Error('依赖锁与 release manifest 不符');
  const binaryChecks: Array<[string, string]> = [
    [path.join(root, 'runtimes', 'node', 'node.exe'), lock.node.binarySha256],
    [path.join(root, 'tools', 'caddy', 'caddy.exe'), lock.caddy.binarySha256],
    [path.join(root, 'tools', 'winsw', 'WinSW.exe'), lock.winsw.sha256],
  ];
  for (const media of lock.media) for (const entry of media.files) binaryChecks.push([path.join(root, 'app', ...entry.path.split('/')), entry.sha256]);
  for (const [file, expectedHash] of binaryChecks) {
    if (!/^[0-9a-f]{64}$/.test(expectedHash ?? '') || !fs.existsSync(file) || sha256File(file) !== expectedHash) throw new Error(`锁定运行时或媒体负载哈希不符：${relativePayloadPath(root, file)}`);
  }
  const pythonManifest = path.join(root, 'runtimes', 'python', 'runtime-manifest.json');
  if (fs.existsSync(pythonManifest)) {
    const python = JSON.parse(fs.readFileSync(pythonManifest, 'utf8')) as { pythonVersion: string; litellmVersion: string; archiveSha256: string };
    if (python.pythonVersion !== lock.python.version || python.litellmVersion !== lock.python.litellmVersion
      || python.archiveSha256 !== lock.python.sha256) throw new Error('Python/LiteLLM 运行时与受控锁不符');
  }
  return manifest;
}

/** Verify neutral uploaded bytes without creating executable/script files in the web process. */
export function verifyStagedReleaseManifest(manifest: ServerReleaseManifest, read: (relative: string) => Buffer,
  actualPaths: string[]): ServerReleaseManifest {
  assertManifestIdentity(manifest);
  assertServerReleaseCompatibility(manifest.compatibility);
  const expected = new Set<string>();
  const errors: string[] = [];
  for (const entry of manifest.files) {
    const relative = assertSafeManifestPath(entry.path);
    if (relative === 'release-manifest.json' || expected.has(relative) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('release manifest 条目无效或重复');
    expected.add(relative);
    const content = read(relative);
    if (content.length !== entry.size || crypto.createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error(`release 文件哈希不符：${relative}`);
    const basename = path.posix.basename(relative).toLowerCase();
    if (basename === '.env' || basename.startsWith('.env.') || basename === 'config.yaml' || basename.startsWith('config.yaml.')) errors.push(`环境/网关配置不得入包：${relative}`);
    if (/\.(?:db|db-wal|db-shm|sqlite|sqlite3)$/i.test(basename)) errors.push(`数据库不得入包：${relative}`);
    if (TEXT_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()) && content.length <= 32 * 1024 * 1024
      && PRIVATE_KEY_PEM.test(content.toString('utf8'))) errors.push(`私钥不得入包：${relative}`);
    const top = relative.split('/')[0];
    const spec = forbiddenSpec.consumers.serverReleaseGuard;
    if (!spec.topLevel.includes(top) || spec.forbidden.includes(top)) throw new Error(`发布包包含非白名单路径：${relative}`);
  }
  const actual = [...actualPaths].toSorted();
  if (actual.length !== expected.size || actual.some((relative) => !expected.has(relative))) throw new Error('release 含 manifest 未登记的文件');
  if (errors.length) throw new Error(errors.join('\n'));
  for (const required of ['app/server.js', 'app/runtime/team-server-entry.cjs', 'runtimes/node/node.exe',
    'tools/caddy/caddy.exe', 'tools/winsw/WinSW.exe', 'app/scripts/team-server/maintenance.mjs']) {
    if (!expected.has(required)) throw new Error(`发布包缺少必需运行入口：${required}`);
  }
  const lock = JSON.parse(read('service/distribution-lock.json').toString('utf8')) as {
    node: { binarySha256: string }; caddy: { binarySha256: string }; winsw: { sha256: string };
    python: { version: string; litellmVersion: string; sha256: string };
    media: Array<{ files: Array<{ path: string; sha256: string }> }>;
  };
  if (crypto.createHash('sha256').update(read('service/distribution-lock.json')).digest('hex') !== manifest.dependencyLockSha256) throw new Error('依赖锁与 release manifest 不符');
  const binaries: Array<[string, string]> = [
    ['runtimes/node/node.exe', lock.node.binarySha256], ['tools/caddy/caddy.exe', lock.caddy.binarySha256],
    ['tools/winsw/WinSW.exe', lock.winsw.sha256],
  ];
  for (const media of lock.media) for (const entry of media.files) binaries.push([`app/${entry.path}`, entry.sha256]);
  for (const [relative, hash] of binaries) {
    if (!/^[0-9a-f]{64}$/.test(hash ?? '') || crypto.createHash('sha256').update(read(relative)).digest('hex') !== hash) throw new Error(`锁定运行时或媒体负载哈希不符：${relative}`);
  }
  if (expected.has('runtimes/python/runtime-manifest.json')) {
    const python = JSON.parse(read('runtimes/python/runtime-manifest.json').toString('utf8')) as { pythonVersion: string; litellmVersion: string; archiveSha256: string };
    if (python.pythonVersion !== lock.python.version || python.litellmVersion !== lock.python.litellmVersion
      || python.archiveSha256 !== lock.python.sha256) throw new Error('Python/LiteLLM 运行时与受控锁不符');
  }
  return manifest;
}
