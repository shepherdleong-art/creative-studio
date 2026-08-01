import path from 'node:path';
import { dataRoot } from './data-root';
import { getDb } from './db';
import {
  checkVideoProviderGatewayReadiness,
  type VideoProviderGatewayReadiness,
} from './video-provider-schema-readiness';

let readinessPromise: Promise<VideoProviderGatewayReadiness> | null = null;

export function getVideoProviderGatewayReadiness(): Promise<VideoProviderGatewayReadiness> {
  if (!readinessPromise) {
    const root = dataRoot();
    readinessPromise = checkVideoProviderGatewayReadiness({
      db: getDb(),
      backupRoot: path.join(root, 'data', 'backups', 'schema-upgrades'),
      lockDatabasePath: path.join(root, 'data', 'schema-upgrade.lock.db'),
      auditFilePath: path.join(root, 'storage', 'logs', 'schema-upgrades.jsonl'),
    }).then((result) => {
      if (!result.available) readinessPromise = null;
      return result;
    }, (error) => {
      readinessPromise = null;
      throw error;
    });
  }
  return readinessPromise;
}
