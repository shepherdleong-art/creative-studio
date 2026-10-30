import { dataRoot } from '../data-root.ts';
import { getDb } from '../db.ts';
import { ensureBundledViralPresets } from './bundled-viral-presets.ts';
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

export async function getScriptStudioReadiness(): Promise<ScriptStudioReadiness> {
  const readiness = await checkRuntimeReadiness();
  if (!scriptStudioReadinessUnavailable(readiness)) await ensureBundledViralPresets(getDb());
  return readiness;
}

export { scriptStudioReadinessUnavailable };
