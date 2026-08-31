import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  SchemaUpgradeBackupManifest,
  SchemaUpgradeScope,
} from './backup.ts';

export type SchemaUpgradeRecoveryCandidate = {
  backupId: string;
  scope: SchemaUpgradeScope;
  createdAt: string;
  applicationVersion: string;
  sourceVersions: number[];
  targetVersion: number;
  databaseBytes: number;
  databaseSha256: string;
} & (
  | { verification: 'verified' }
  | {
      verification: 'invalid';
      code: 'database_missing' | 'size_mismatch' | 'hash_mismatch' | 'integrity_failed';
    }
);

function isManifest(value: unknown): value is SchemaUpgradeBackupManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<SchemaUpgradeBackupManifest>;
  return manifest.kind === 'schema-upgrade'
    && (manifest.scope === 'batch-production' || manifest.scope === 'video-provider-gateway' || manifest.scope === 'script-studio')
    && typeof manifest.applicationVersion === 'string'
    && typeof manifest.createdAt === 'string'
    && Array.isArray(manifest.sourceVersions)
    && typeof manifest.targetVersion === 'number'
    && typeof manifest.databaseBytes === 'number'
    && typeof manifest.sha256 === 'string';
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function candidateBase(backupId: string, manifest: SchemaUpgradeBackupManifest) {
  return {
    backupId,
    scope: manifest.scope,
    createdAt: manifest.createdAt,
    applicationVersion: manifest.applicationVersion,
    sourceVersions: manifest.sourceVersions,
    targetVersion: manifest.targetVersion,
    databaseBytes: manifest.databaseBytes,
    databaseSha256: manifest.sha256,
  };
}

async function verifyCandidate(
  directory: string,
  backupId: string,
  manifest: SchemaUpgradeBackupManifest,
): Promise<SchemaUpgradeRecoveryCandidate> {
  const base = candidateBase(backupId, manifest);
  const databasePath = path.join(directory, 'workbench.db');
  let stat;
  try {
    stat = await fsPromises.stat(databasePath);
  } catch {
    return { ...base, verification: 'invalid', code: 'database_missing' };
  }
  if (!stat.isFile() || stat.size !== manifest.databaseBytes) {
    return { ...base, verification: 'invalid', code: 'size_mismatch' };
  }
  if (await sha256File(databasePath) !== manifest.sha256) {
    return { ...base, verification: 'invalid', code: 'hash_mismatch' };
  }

  try {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const integrityRows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
      if (
        integrityRows.length !== 1
        || integrityRows[0]?.integrity_check !== 'ok'
        || foreignKeyViolations.length > 0
      ) {
        return { ...base, verification: 'invalid', code: 'integrity_failed' };
      }
    } finally {
      db.close();
    }
  } catch {
    return { ...base, verification: 'invalid', code: 'integrity_failed' };
  }
  return { ...base, verification: 'verified' };
}

export async function listSchemaUpgradeRecoveryCandidates(options: {
  backupRoot: string;
  scope: SchemaUpgradeScope;
}): Promise<SchemaUpgradeRecoveryCandidate[]> {
  let entries;
  try {
    entries = await fsPromises.readdir(options.backupRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const candidates: SchemaUpgradeRecoveryCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = path.join(options.backupRoot, entry.name);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await fsPromises.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!isManifest(manifest) || manifest.scope !== options.scope) continue;
    candidates.push(await verifyCandidate(directory, entry.name, manifest));
  }
  return candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
