import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { getBatchOutputArrangementView } from '@/lib/batch-production/output-arrangement';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { parsePackagingConfig } from '@/lib/media-core/packaging-vars';
import { packagingPreviewAssetResponse } from '@/lib/media-core/packaging-preview-resources';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { batchRouteErrorResponse } from '../../../../../response';
import { BatchDomainError } from '@/lib/batch-production/errors';

async function resource(_request: NextRequest, { params }: { params: Promise<{ id: string; planId: string; path: string[] }> }) {
  try {
    await assertBatchApiReady();
    const { id, planId, path } = await params;
    const db = getDb();
    const projectId = (db.prepare('SELECT projectId FROM batch_productions WHERE id=? AND deletedAt IS NULL').get(id) as { projectId: string } | undefined)?.projectId;
    if (!projectId) throw new BatchDomainError('invalid_input', '缺少项目 ID');
    const view = getBatchOutputArrangementView(db, projectId, id, planId);
    return packagingPreviewAssetResponse(parsePackagingConfig(view.packaging), path);
  } catch (error) { return batchRouteErrorResponse(error, 'packaging_resource_failed', '读取布局资源失败'); }
}
export const GET = withTeamRoute('/api/batch-production/batches/[id]/outputs/[planId]/packaging-layout-resources/[...path]', 'GET', resource);
