import path from 'node:path';
import { NextResponse } from 'next/server';
import { dataRoot } from '@/lib/data-root';
import { listSchemaUpgradeRecoveryCandidates } from '@/lib/schema-upgrade/recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const candidates = await listSchemaUpgradeRecoveryCandidates({
      backupRoot: path.join(dataRoot(), 'data', 'backups', 'schema-upgrades'),
      scope: 'batch-production',
    });
    return NextResponse.json({
      candidates,
      requiresApplicationShutdown: true,
      automaticRestoreAvailable: false,
      message: '恢复前必须完全退出工作台并再次验证备份；当前阶段不会在运行中覆盖数据库。',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({
      error: 'recovery_candidates_unavailable',
      message: '无法读取数据库恢复候选。',
    }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
