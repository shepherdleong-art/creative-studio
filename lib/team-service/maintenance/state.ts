import path from 'node:path';
import { safeMaintenanceId } from './paths.ts';

/** Durable release/rollback state lives outside both the release payload and business DB. */
export function teamMaintenanceStateDirectory(backupRoot: string, deploymentId: string): string {
  return path.join(backupRoot, 'maintenance-control', 'release-state', safeMaintenanceId(deploymentId, 'deploymentId'));
}

export function teamMaintenanceStatePath(backupRoot: string, deploymentId: string, operationId: string): string {
  return path.join(teamMaintenanceStateDirectory(backupRoot, deploymentId), `${safeMaintenanceId(operationId, 'operationId')}.json`);
}
