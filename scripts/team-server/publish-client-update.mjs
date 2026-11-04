#!/usr/bin/env node
/**
 * 将 build-team-client 产出的已签名更新包发布到服务端受控的 /client-updates/ 目录。
 *
 * 发布顺序固定为：ZIP → 版本 manifest → current.manifest.json 指针。
 * 指针最后原子替换，客户端不会看到指向缺失包或未校验清单的中间态。
 * 只发布 ZIP 与 manifest，私钥、部署配置和客户端状态目录不得进入托管目录。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRIVATE_KEY_PEM = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
function fail(message) {
  process.stderr.write(`发布失败：${message}\n`);
  process.exit(1);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function readRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}必须是普通文件`);
  return fs.readFileSync(file);
}
function atomicWrite(target, bytes) {
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, bytes, { flag: 'wx' });
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

const source = option('source');
const deploymentRoot = option('deployment-root');
if (!source) fail('--source 必须是 build-team-client 的装配目录');
if (!deploymentRoot) fail('--deployment-root 必须是已安装的服务端部署根');
const sourceRoot = path.resolve(source);
const root = path.resolve(deploymentRoot);
if (!fs.existsSync(sourceRoot)) fail('--source 目录不存在');
if (!fs.existsSync(root)) fail('--deployment-root 目录不存在');
const rootStat = fs.lstatSync(root);
if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('--deployment-root 不得是链接或非目录');
let origin;
try {
  origin = new URL(option('origin') ?? process.env.CREATIVE_STUDIO_SERVER_ORIGIN ?? '');
} catch {
  fail('必须通过 --origin 或 CREATIVE_STUDIO_SERVER_ORIGIN 提供 HTTPS 服务地址');
}
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) {
  fail('服务地址必须是明确的 HTTPS origin');
}
const trustedOrigin = origin.origin;

const currentPath = path.join(sourceRoot, 'current.json');
if (!fs.existsSync(currentPath)) fail('装配目录缺少 current.json，拒绝发布未构建产物');
let current;
try {
  current = JSON.parse(readRegularFile(currentPath, 'current.json').toString('utf8'));
} catch (error) {
  fail(`current.json 无法解析：${error instanceof Error ? error.message : error}`);
}
const releaseId = current?.releaseId;
if (typeof releaseId !== 'string' || !RELEASE_ID.test(releaseId)) fail('current.json 的 releaseId 无效');
const manifestRelative = `updates/${releaseId}.manifest.json`;
const archiveRelative = `updates/${releaseId}.zip`;
const manifestPath = path.join(sourceRoot, manifestRelative);
const archivePath = path.join(sourceRoot, archiveRelative);
if (!fs.existsSync(manifestPath)) fail(`缺少版本 manifest：${manifestRelative}`);
if (!fs.existsSync(archivePath)) fail(`缺少更新包：${archiveRelative}`);
const manifestBytes = readRegularFile(manifestPath, '版本 manifest');
const archiveBytes = readRegularFile(archivePath, '更新包');
let manifest;
try {
  manifest = JSON.parse(manifestBytes.toString('utf8'));
} catch {
  fail('版本 manifest 不是合法 JSON');
}
if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('版本 manifest 结构无效');
if (manifest.schemaVersion !== 1 || manifest.releaseId !== releaseId) fail('manifest 与 current.json 的 releaseId 不一致');
if (!Number.isSafeInteger(manifest.size) || manifest.size !== archiveBytes.length) fail('更新包大小与 manifest 不一致');
if (typeof manifest.sha256 !== 'string' || manifest.sha256 !== sha256(archiveBytes)) fail('更新包哈希与 manifest 不一致');
const expectedPackageUrl = `${trustedOrigin}/client-updates/${releaseId}.zip`;
if (manifest.packageUrl !== expectedPackageUrl) fail(`manifest.packageUrl 必须精确等于 ${expectedPackageUrl}`);
if (manifest.platform !== 'win32' && manifest.platform !== 'darwin') fail('manifest.platform 无效');
if (!manifest.signature || manifest.signature.algorithm !== 'ed25519' || typeof manifest.signature.value !== 'string') {
  fail('manifest 缺少 ed25519 签名');
}
const publicKeyPath = path.join(sourceRoot, 'update-public-key.pem');
if (!fs.existsSync(publicKeyPath)) fail('装配目录缺少 update-public-key.pem');
const publicKeyBytes = readRegularFile(publicKeyPath, '更新公钥');
if (PRIVATE_KEY_PEM.test(publicKeyBytes.toString('utf8'))) fail('装配目录中的公钥文件包含私钥');
const { signature, ...payload } = manifest;
let signatureValid = false;
try {
  signatureValid = crypto.verify(
    null,
    Buffer.from(canonical(payload), 'utf8'),
    crypto.createPublicKey(publicKeyBytes),
    Buffer.from(signature.value, 'base64'),
  );
} catch {
  signatureValid = false;
}
if (!signatureValid) fail('manifest 签名验证失败');

const target = path.join(root, 'client-updates');
if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
const targetStat = fs.lstatSync(target);
if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) fail('托管目录 client-updates 不得是链接或非目录');

const files = [
  { name: `${releaseId}.zip`, bytes: archiveBytes, label: '更新包' },
  { name: `${releaseId}.manifest.json`, bytes: manifestBytes, label: '版本 manifest' },
];
const plan = [];
for (const file of files) {
  const destination = path.join(target, file.name);
  let existing = null;
  if (fs.existsSync(destination)) {
    existing = readRegularFile(destination, file.label);
    if (sha256(existing) !== sha256(file.bytes)) fail(`${file.name} 已存在且内容不同，拒绝覆盖已发布版本`);
  }
  plan.push({ ...file, destination, exists: existing !== null });
}
const pointerPath = path.join(target, 'current.manifest.json');
const pointerExisting = fs.existsSync(pointerPath) ? readRegularFile(pointerPath, '更新指针') : null;
const pointerUpToDate = pointerExisting !== null && pointerExisting.equals(manifestBytes);

if (args.includes('--dry-run')) {
  process.stdout.write(`${JSON.stringify({
    dryRun: true,
    source: sourceRoot,
    deploymentRoot: root,
    releaseId,
    manifestUrl: `${trustedOrigin}/client-updates/current.manifest.json`,
    publishOrder: [...plan.map((entry) => ({ name: entry.name, action: entry.exists ? 'reuse' : 'create' })),
      { name: 'current.manifest.json', action: pointerUpToDate ? 'reuse' : 'replace' }],
  }, null, 2)}\n`);
  process.exit(0);
}

for (const file of plan) {
  if (!file.exists) atomicWrite(file.destination, file.bytes);
}
if (!pointerUpToDate) atomicWrite(pointerPath, manifestBytes);

// 托管目录只允许出现已发布产物；任何私钥、配置或状态文件都视为发布污染。
for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
  if (entry.isSymbolicLink() || !entry.isFile()) fail(`托管目录只允许普通文件：${entry.name}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) fail(`托管目录包含非法文件名：${entry.name}`);
  if (/^(?:\.env|config\.yaml|workbench\.db)/i.test(entry.name)) fail(`托管目录包含部署数据：${entry.name}`);
  if (!entry.name.endsWith('.zip') && PRIVATE_KEY_PEM.test(fs.readFileSync(path.join(target, entry.name), 'utf8'))) {
    fail(`托管目录包含私钥：${entry.name}`);
  }
}

process.stdout.write(`${JSON.stringify({
  published: true,
  releaseId,
  deploymentRoot: root,
  clientUpdatesRoot: target,
  manifestUrl: `${trustedOrigin}/client-updates/current.manifest.json`,
  files: [...plan.map((entry) => entry.name), 'current.manifest.json'],
}, null, 2)}\n`);
