import { dataRoot } from './data-root';
import { getDb } from './db';
import {
  cacheSuccessfulReadiness,
  schemaUpgradeRuntimePaths,
} from './schema-upgrade/runtime';
import {
  checkVideoProviderGatewayReadiness,
  type VideoProviderGatewayReadiness,
} from './video-provider-schema-readiness';

const checkRuntimeReadiness = cacheSuccessfulReadiness<VideoProviderGatewayReadiness>(() => (
  checkVideoProviderGatewayReadiness({
    db: getDb(),
    ...schemaUpgradeRuntimePaths(dataRoot()),
  })
));

export function getVideoProviderGatewayReadiness(): Promise<VideoProviderGatewayReadiness> {
  return checkRuntimeReadiness();
}
