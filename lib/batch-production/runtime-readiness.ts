import path from 'node:path';
import { dataRoot } from '../data-root';
import { getDb } from '../db';
import {
  checkBatchProductionReadiness,
  type BatchProductionReadiness,
} from './readiness';

let readinessPromise: Promise<BatchProductionReadiness> | null = null;

export function getBatchProductionReadiness(): Promise<BatchProductionReadiness> {
  if (!readinessPromise) {
    const root = dataRoot();
    readinessPromise = checkBatchProductionReadiness({
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
