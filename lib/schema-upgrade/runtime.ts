import path from 'node:path';

export function schemaUpgradeRuntimePaths(root: string) {
  return {
    backupRoot: path.join(root, 'data', 'backups', 'schema-upgrades'),
    lockDatabasePath: path.join(root, 'data', 'schema-upgrade.lock.db'),
    auditFilePath: path.join(root, 'storage', 'logs', 'schema-upgrades.jsonl'),
  };
}

export function cacheSuccessfulReadiness<T extends { available: boolean }>(
  check: () => Promise<T>,
): () => Promise<T> {
  let readinessPromise: Promise<T> | null = null;
  return () => {
    if (!readinessPromise) {
      readinessPromise = check().then((result) => {
        if (!result.available) readinessPromise = null;
        return result;
      }, (error) => {
        readinessPromise = null;
        throw error;
      });
    }
    return readinessPromise;
  };
}
