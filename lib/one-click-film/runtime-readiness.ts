import { dataRoot } from '../data-root.ts';
import { getDb } from '../db.ts';
import { cacheSuccessfulReadiness, schemaUpgradeRuntimePaths } from '../schema-upgrade/runtime.ts';
import {
  checkOneClickFilmReadiness,
  oneClickFilmReadinessUnavailable,
  type OneClickFilmReadiness,
} from './readiness.ts';

const checkRuntimeReadiness = cacheSuccessfulReadiness<OneClickFilmReadiness>(() => (
  checkOneClickFilmReadiness({
    db: getDb(),
    ...schemaUpgradeRuntimePaths(dataRoot()),
  })
));

export function getOneClickFilmReadiness(): Promise<OneClickFilmReadiness> {
  return checkRuntimeReadiness();
}

export { oneClickFilmReadinessUnavailable };
