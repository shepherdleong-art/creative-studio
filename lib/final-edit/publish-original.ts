import {
  completeExportReservation, publishReservedExportTarget, publishReservedSingleFile,
  releaseReservedExportTarget, reserveProjectExportTarget, type ReservedProjectExportTarget,
} from './export-naming.ts';
import type { ExportIdentity } from './types.ts';
import { FinalEditError } from './errors.ts';

/** 跳过包装时按原片重新命名，不能沿用表示包装已完成的 A/B/C/D。 */
export async function publishUnpackagedRender(input: {
  storageRoot: string;
  target: ReservedProjectExportTarget;
  identity?: ExportIdentity;
  videoRelativePath: string;
  coverRelativePath?: string;
  blockedRelativePaths?: ReadonlySet<string>;
}): Promise<ReservedProjectExportTarget> {
  if (!input.identity?.productionCodes?.packagingCode) {
    await publishReservedSingleFile({
      storageRoot: input.storageRoot, sourceRelativePath: input.videoRelativePath,
      targetRelativePath: input.target.videoRelativePath, reservationRelativePath: input.target.reservationRelativePath,
      invalidCode: 'render_artifact_invalid',
    });
    completeExportReservation(input.storageRoot, input.target.reservationRelativePath);
    return input.target;
  }
  if (!input.coverRelativePath) throw new FinalEditError('render_artifact_invalid', '原片封面缺失，请重新导出', 409);
  const target = reserveProjectExportTarget(input.storageRoot, {
    ...input.identity,
    productionCodes: { ...input.identity.productionCodes, packagingCode: '' },
  }, { blockedRelativePaths: input.blockedRelativePaths });
  try {
    await publishReservedExportTarget({
      storageRoot: input.storageRoot, target, internalVideoRelativePath: input.videoRelativePath,
      internalCoverRelativePath: input.coverRelativePath,
    });
  } catch (error) {
    releaseReservedExportTarget(input.storageRoot, target);
    throw error;
  }
  completeExportReservation(input.storageRoot, input.target.reservationRelativePath);
  return target;
}
