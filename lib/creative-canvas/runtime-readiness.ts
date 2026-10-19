import { dataRoot } from '../data-root.ts';
import { getDb } from '../db.ts';
import {
  cacheSuccessfulReadiness,
  schemaUpgradeRuntimePaths,
} from '../schema-upgrade/runtime.ts';
import {
  checkCanvasReadiness,
  canvasReadinessUnavailable,
  type CanvasReadiness,
} from './readiness.ts';

const checkRuntimeReadiness = cacheSuccessfulReadiness<CanvasReadiness>(() => (
  checkCanvasReadiness({
    db: getDb(),
    ...schemaUpgradeRuntimePaths(dataRoot()),
  })
));

export function getCanvasReadiness(): Promise<CanvasReadiness> {
  return checkRuntimeReadiness();
}

export { canvasReadinessUnavailable };
