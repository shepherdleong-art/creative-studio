import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { prepareBatchProductionInputs } from '@/lib/batch-production/prepare';
import { getBatchProductionReadiness } from '@/lib/batch-production/runtime-readiness';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

/**
 * 批量准备区数据入口:同步第 3 步有效脚本、自动登记第 4 步成功视频、
 * 核验素材来源健康状态,返回选择前的展示数据。
 * 只做输入准备与展示,不建立批次快照、不开始生产。
 */
export async function GET(request: NextRequest) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: NO_STORE_HEADERS });
  }
  try {
    let readiness;
    try {
      readiness = await getBatchProductionReadiness();
    } catch {
      return NextResponse.json({
        error: 'readiness_check_failed',
        message: '无法完成批量功能自检，旧功能仍可继续使用。',
      }, { status: 503, headers: NO_STORE_HEADERS });
    }
    if (!readiness.available) {
      return NextResponse.json({
        error: readiness.code,
        message: readiness.message,
        readiness,
      }, { status: 503, headers: NO_STORE_HEADERS });
    }
    const db = getDb();
    const preparation = await prepareBatchProductionInputs(db, projectId);
    return NextResponse.json(preparation, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof Error && error.message === '项目不存在') {
      return NextResponse.json({
        error: 'prepare_failed',
        message: '项目不存在',
      }, { status: 404, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({
      error: 'prepare_failed',
      message: '批量准备区数据读取失败',
    }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
