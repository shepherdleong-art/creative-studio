import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { TeamBackupManifest, TeamBackupSuccess } from './backup.ts';
import { assertNoSymlinkPath, readJsonFile, removeDirectorySafely, safeMaintenanceId, sha256File, sha256Text, writeJsonAtomic } from './paths.ts';

interface Retirement {
  version: 1;
  backupId: string;
  deploymentId: string;
  manifestSha256: string;
  configSha256: string;
  pinId: string | null;
}
type ReleasePin = ((id: string) => void) | undefined;

function namespace(root: string, deploymentId: string) {
  return path.join(root, 'daily-retired-v1', safeMaintenanceId(deploymentId, 'deploymentId'));
}

async function removeRetiredConfig(snapshot: string, expectedHash: string) {
  const directory = path.join(snapshot, 'config');
  const file = path.join(directory, 'deployment.json');
  assertNoSymlinkPath(file);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || await sha256File(file) !== expectedHash
    || (await fsp.readdir(directory)).length !== 1) throw new Error('到期配置与核验记录不符');
  try {
    await fsp.unlink(file);
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    // 配置文件的 DACL 原样保留。仅给已经移出的这个父目录添加不继承的 DELETE_CHILD。
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 15_000 };
    const identity = execFileSync(path.join(system, 'whoami.exe'), ['/user','/fo','csv','/nh'], options);
    const sid = identity.match(/"(S-1-(?:\d+-)+\d+)"\s*$/i)?.[1];
    if (!sid) throw new Error('无法核实当前轮换账号');
    execFileSync(path.join(system, 'icacls.exe'), [directory, '/grant', '*' + sid + ':(DC)'], options);
    // Windows 上 libuv 的 unlink 还会请求写属性权限。DeleteFile 只需父目录的子项删除权。
    execFileSync(path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; [IO.File]::Delete($env:STUDIO_RETIRED_CONFIG_FILE)",
    ], { ...options, env: { ...process.env, STUDIO_RETIRED_CONFIG_FILE: file } });
  }
}

async function finishRetirement(job: string, intent: Retirement, releasePin: ReleasePin) {
  const snapshot = path.join(job, 'snapshot');
  assertNoSymlinkPath(snapshot);
  if (fs.existsSync(snapshot)) {
    const manifest = path.join(snapshot, 'manifest.json');
    if (fs.existsSync(manifest) && await sha256File(manifest) !== intent.manifestSha256) {
      throw new Error('已移出快照的清单发生变化');
    }
    await removeRetiredConfig(snapshot, intent.configSha256);
    await removeDirectorySafely(job, snapshot);
  }
  if (intent.pinId) {
    if (!releasePin) return; // 下次持有数据库的轮换重试，先保留 pin 身份。
    releasePin(intent.pinId);
  }
  await fsp.unlink(path.join(job, 'intent.json'));
  await fsp.rmdir(job);
}

export async function retireVerifiedDaily(root: string, manifest: TeamBackupManifest, releasePin: ReleasePin) {
  const id = safeMaintenanceId(manifest.backupId, 'backupId');
  if (manifest.type !== 'daily') throw new Error('只能清理到期日备');
  const source = path.join(root, 'daily', id);
  const job = path.join(namespace(root, manifest.deploymentId), id);
  const detached = path.join(job, 'snapshot');
  assertNoSymlinkPath(source);
  assertNoSymlinkPath(detached);
  const success = await readJsonFile<TeamBackupSuccess>(path.join(source, 'success.json'));
  const contents = await fsp.readFile(path.join(source, 'manifest.json'), 'utf8');
  const current: TeamBackupManifest = JSON.parse(contents);
  if (success.status !== 'success' || success.backupId !== id || success.type !== 'daily'
    || success.manifestSha256 !== sha256Text(contents) || current.backupId !== id || current.type !== 'daily'
    || current.deploymentId !== manifest.deploymentId || current.createdAt !== manifest.createdAt
    || current.config.sha256 !== manifest.config.sha256 || current.pin?.id !== manifest.pin?.id) throw new Error('到期日备身份变化');
  const intent: Retirement = { version: 1, backupId: id, deploymentId: manifest.deploymentId,
    manifestSha256: success.manifestSha256, configSha256: manifest.config.sha256, pinId: manifest.pin?.id ?? null };
  await fsp.mkdir(job, { recursive: true, mode: 0o700 });
  if (fs.existsSync(detached)) throw new Error('到期暂存位置已有快照');
  const intentFile = path.join(job, 'intent.json');
  if (fs.existsSync(intentFile)) {
    const prior = await readJsonFile<Retirement>(intentFile);
    if (JSON.stringify(prior) !== JSON.stringify(intent)) throw new Error('到期操作身份不符');
  } else {
    await writeJsonAtomic(intentFile, intent);
  }
  await fsp.rename(source, detached);
  await finishRetirement(job, intent, releasePin);
}

export async function resumeDailyRetirements(root: string, deploymentId: string, releasePin: ReleasePin) {
  const parent = namespace(root, deploymentId);
  assertNoSymlinkPath(parent);
  if (!fs.existsSync(parent)) return;
  for (const entry of await fsp.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('未知到期暂存项');
    const id = safeMaintenanceId(entry.name, 'backupId');
    const job = path.join(parent, id);
    const source = path.join(root, 'daily', id);
    // 发布目录仍存在说明原子移出未发生。由正常轮换重新评估这个日期。
    if (fs.existsSync(source)) continue;
    const intentFile = path.join(job, 'intent.json');
    assertNoSymlinkPath(intentFile);
    if (!fs.existsSync(intentFile)) {
      await fsp.rmdir(job); // 只允许已收尾的空目录。
      continue;
    }
    const intent = await readJsonFile<Retirement>(intentFile);
    if (intent.version !== 1 || intent.backupId !== id || intent.deploymentId !== deploymentId
      || !/^[a-f0-9]{64}$/.test(intent.manifestSha256) || !/^[a-f0-9]{64}$/.test(intent.configSha256)
      || !(intent.pinId === null || typeof intent.pinId === 'string')) throw new Error('到期回执无效');
    await finishRetirement(job, intent, releasePin);
  }
}
