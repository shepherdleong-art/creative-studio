import { dataRoot } from '../data-root.ts';
import { getDb } from '../db.ts';
import {
  cacheSuccessfulReadiness,
  schemaUpgradeRuntimePaths,
} from '../schema-upgrade/runtime.ts';
import {
  checkScriptStudioReadiness,
  scriptStudioReadinessUnavailable,
  type ScriptStudioReadiness,
} from './readiness.ts';

const checkRuntimeReadiness = cacheSuccessfulReadiness<ScriptStudioReadiness>(() => (
  checkScriptStudioReadiness({
    db: getDb(),
    ...schemaUpgradeRuntimePaths(dataRoot()),
  })
));

export function getScriptStudioReadiness(): Promise<ScriptStudioReadiness> {
  return checkRuntimeReadiness();
}

export { scriptStudioReadinessUnavailable };
