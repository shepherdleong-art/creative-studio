import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { dataRoot } from '../data-root.ts';
import { getDb } from '../db.ts';
import { readRuntimeConfig } from './config.ts';
import type { TeamReleaseCurrentVersion } from './maintenance/release-candidates.ts';
import { readTeamReleasePointer } from './maintenance/release.ts';
import { assertNoSymlinkPath, writeJsonAtomic } from './maintenance/paths.ts';
import packageMetadata from '../../package.json' with { type: 'json' };

export function teamReleaseCandidateRoot(root = dataRoot()): string {
  return path.join(root, 'storage', 'maintenance', 'release-candidates');
}
function currentDataSchemaVersion(): number {
  const version = getDb().prepare('SELECT MAX(version) AS version FROM team_schema_migrations').pluck().get() as unknown;
  if (!Number.isSafeInteger(version) || (version as number) < 1) throw new Error('当前数据结构版本无法验证');
  return version as number;
}

/** Only deployment-owned state is a current-version source; uploaded JSON never supplies it. */
export async function readCurrentTeamReleaseVersion(): Promise<TeamReleaseCurrentVersion & { releaseId?: string }> {
  const serviceRoot = process.env.CREATIVE_STUDIO_SERVICE_ROOT?.trim();
  if (serviceRoot) {
    const pointer = await readTeamReleasePointer(serviceRoot);
    const releaseRoot = process.env.CREATIVE_STUDIO_RELEASE_ROOT?.trim();
    if (!releaseRoot) throw new Error('当前发布目录未配置，拒绝猜测版本');
    const { readInstalledReleaseVersionMetadata } = await import('./maintenance/distribution.ts');
    const manifest = await readInstalledReleaseVersionMetadata(releaseRoot, pointer);
    return { appVersion: manifest.appVersion, dataSchemaVersion: currentDataSchemaVersion(), releaseId: manifest.releaseId };
  }
  const releaseId = process.env.CREATIVE_STUDIO_SERVER_RELEASE_ID?.trim();
  if (!releaseId || releaseId === 'unknown') throw new Error('缺少可信当前发布身份');
  const packageVersion = packageMetadata.version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageVersion)) throw new Error('当前应用版本无效');
  return { appVersion: packageVersion, dataSchemaVersion: currentDataSchemaVersion(), releaseId };
}

export function assertFixtureReleaseUploadAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (readRuntimeConfig().mode !== 'server') return false;
  return env.NODE_ENV !== 'production' && env.CREATIVE_STUDIO_TEAM_RELEASE_FIXTURE_UPLOAD === '1';
}

export async function receiveTeamReleaseArchive(request: Request): Promise<{ archivePath: string; originalName: string; cleanup: () => Promise<void> }> {
  let originalName = 'server-release.zip';
  let source: Request = request;
  if (request.headers.get('content-type')?.includes('multipart/form-data')) {
    let form: FormData;
    try { form = await request.formData(); } catch { throw new Error('上传表单不完整，请重新选择发布包'); }
    const fields = form.getAll('file');
    if (fields.length !== 1 || !(fields[0] instanceof File) || ![...form.keys()].every((key) => key === 'file')) throw new Error('请只选择一个服务器发布 ZIP 包');
    const file = fields[0];
    if (!/\.zip$/i.test(file.name) || (file.type && file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed')) throw new Error('只接受 .zip 服务器发布包');
    originalName = file.name;
    source = new Request(request.url, { method: 'POST', headers: { 'Content-Length': String(file.size) }, body: file.stream(), duplex: 'half' } as RequestInit & { duplex: 'half' });
  } else if (request.headers.get('content-type') !== 'application/zip') throw new Error('只接受受控服务器发布 ZIP 包');
  const lengthText = source.headers.get('content-length');
  const maxBytes = 8 * 1024 ** 3;
  if (lengthText && (!/^\d+$/.test(lengthText) || Number(lengthText) < 1 || Number(lengthText) > maxBytes)) {
    throw new Error('上传包为空或超过 8 GiB 限制');
  }
  if (!source.body) throw new Error('请选择服务器发布 ZIP 包');
  const root = path.join(teamReleaseCandidateRoot(), '.incoming');
  assertNoSymlinkPath(root);
  await fsPromises.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fsPromises.mkdtemp(path.join(root, `${process.pid}-`));
  const archivePath = path.join(directory, 'package.zip');
  let bytes = 0;
  let committed = false;
  try {
    const output = fs.createWriteStream(archivePath, { flags: 'wx', mode: 0o600 });
    try {
      for await (const chunk of Readable.fromWeb(source.body as import('node:stream/web').ReadableStream<Uint8Array>)) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) throw new Error('上传包超过 8 GiB 限制');
        if (!output.write(chunk)) await new Promise<void>((resolve, reject) => {
          output.once('drain', resolve); output.once('error', reject);
        });
      }
      await new Promise<void>((resolve, reject) => { output.end(); output.once('finish', resolve); output.once('error', reject); });
    } finally {
      if (!output.closed) output.destroy();
    }
    if (bytes === 0 || (lengthText && bytes !== Number(lengthText))) throw new Error('上传中断，未形成完整发布包');
    committed = true;
    return {
      archivePath, originalName,
      cleanup: () => fsPromises.rm(directory, { recursive: true, force: true }),
    };
  } finally {
    if (!committed) await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

export interface ReleaseUploadFailure {
  schemaVersion: 1;
  uploadId: string;
  kind: 'server-release-upload';
  status: 'failed';
  requestedBy: string;
  code: string;
  message: string;
  createdAt: string;
}
export async function recordTeamReleaseUploadFailure(requestedBy: string, error: unknown): Promise<ReleaseUploadFailure> {
  const record: ReleaseUploadFailure = {
    schemaVersion: 1, uploadId: randomUUID(), kind: 'server-release-upload', status: 'failed', requestedBy,
    code: 'release_upload_rejected', message: error instanceof Error ? error.message.slice(0, 1000) : '发布包校验失败。',
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(teamReleaseCandidateRoot(), 'failures', `${record.uploadId}.json`), record);
  return record;
}
export async function listTeamReleaseUploadFailures(): Promise<ReleaseUploadFailure[]> {
  const directory = path.join(teamReleaseCandidateRoot(), 'failures');
  if (!fs.existsSync(directory)) return [];
  const records: ReleaseUploadFailure[] = [];
  for (const name of await fsPromises.readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const record = JSON.parse(await fsPromises.readFile(path.join(directory, name), 'utf8')) as ReleaseUploadFailure;
    if (record.schemaVersion === 1 && record.kind === 'server-release-upload' && record.status === 'failed') records.push(record);
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
