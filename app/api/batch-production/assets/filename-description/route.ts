import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { extractAssetFilenameDescriptions } from '@/lib/batch-production/filename-analysis';
import { createFilenameAnalysisStream } from '@/lib/batch-production/filename-analysis-stream';
import { batchErrorResponse } from '@/lib/batch-production/http-errors';
import { writeLog } from '@/lib/logger';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { BATCH_NO_STORE_HEADERS, batchProjectIdFromRequest, batchRouteErrorResponse } from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const projectId = batchProjectIdFromRequest(request);
  const body = await request.json().catch(() => null) as { assetIds?: unknown } | null;
  if (!projectId || !Array.isArray(body?.assetIds) || body.assetIds.some((id) => typeof id !== 'string')) {
    return NextResponse.json({ code: 'invalid_input', message: '缺少项目或素材列表' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const run = async (report: Parameters<typeof extractAssetFilenameDescriptions>[4], signal: AbortSignal) => {
      writeLog({ projectId, level: 'info', message: `[批量素材] 开始提取文件名描述，共 ${new Set(body.assetIds as string[]).size} 条；本地处理，不调用 AI 画面分析。` });
      try {
        const result = await extractAssetFilenameDescriptions(getDb(), projectId, body.assetIds as string[], signal, (progress) => {
          writeLog({ projectId, jobId: progress.assetId, level: progress.status === 'failed' ? 'warn' : 'info',
            message: `[文件名提取 ${progress.completed}/${progress.total}] ${progress.displayName}：${progress.status === 'processing'
              ? '正在核验原片并提取描述' : progress.status === 'failed' ? progress.message : progress.item?.reused ? '已复用文件名描述' : '描述已保存，可用于匹配'}` });
          report?.(progress);
        });
        writeLog({ projectId, level: result.errors.length ? 'warn' : 'info', message: `[批量素材] 文件名提取结束：成功 ${result.items.length} 条，失败 ${result.errors.length} 条。` });
        return result;
      } catch (error) {
        writeLog({ projectId, level: 'warn', message: signal.aborted
          ? '[批量素材] 文件名提取已中断，已完成的描述已保留。'
          : '[批量素材] 文件名提取未完成，请检查素材并重试。' });
        throw error;
      }
    };
    if (request.headers.get('accept')?.includes('application/x-ndjson')) {
      return createFilenameAnalysisStream((report, signal) => run(report, AbortSignal.any([signal, request.signal])),
        (error) => batchErrorResponse(error, { error: 'filename_analysis_failed', message: '文件名描述提取失败' }).body.message);
    }
    const result = await run(undefined, request.signal);
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'filename_analysis_failed', '文件名描述提取失败');
  }
}
