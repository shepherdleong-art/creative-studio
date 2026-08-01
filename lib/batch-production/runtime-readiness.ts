import { dataRoot } from '../data-root';
import { getDb } from '../db';
import {
  cacheSuccessfulReadiness,
  schemaUpgradeRuntimePaths,
} from '../schema-upgrade/runtime';
import {
  checkBatchProductionReadiness,
  type BatchProductionReadiness,
} from './readiness';

const checkRuntimeReadiness = cacheSuccessfulReadiness<BatchProductionReadiness>(() => (
  checkBatchProductionReadiness({
    db: getDb(),
    ...schemaUpgradeRuntimePaths(dataRoot()),
  })
));

export function getBatchProductionReadiness(): Promise<BatchProductionReadiness> {
  return checkRuntimeReadiness();
}
