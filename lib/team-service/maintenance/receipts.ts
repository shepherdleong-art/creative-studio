import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeMaintenanceId } from './paths.ts';

export type MaintenanceReceiptKind = 'backup' | 'release' | 'restore';

export function maintenanceReceiptPath(backupRoot: string, deploymentId: string): string {
  return path.join(backupRoot, 'maintenance-receipts', `${safeMaintenanceId(deploymentId, 'deploymentId')}.jsonl`);
}

export function appendMaintenanceReceipt(options: {
  backupRoot: string;
  deploymentId: string;
  kind: MaintenanceReceiptKind;
  operationId: string;
  phase: 'started' | 'finished' | 'failed' | 'stage';
  at?: string;
  details?: Record<string, unknown>;
}): void {
  const filePath = maintenanceReceiptPath(options.backupRoot, options.deploymentId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: 1,
    receiptId: randomUUID(),
    kind: options.kind,
    operationId: options.operationId,
    phase: options.phase,
    at: options.at ?? new Date().toISOString(),
    ...(options.details ?? {}),
  };
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
