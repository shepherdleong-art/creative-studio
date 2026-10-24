import type Database from 'better-sqlite3';
import { formulaExportSuffix, type FormulaExportIdentity } from '../../media-core/export-identity.ts';
import { packagingCode } from '../../media-core/production-codes.ts';
import { BatchDomainError } from '../errors.ts';

/** 只读冻结的输出身份；不能按计划序号、文件名或任务完成顺序推断原号/份次。 */
export function readFormulaExportIdentity(db: Database.Database, input: {
  projectId: string; batchId: string; planId: string; outputVersionId: string;
  packaging: { enabled?: boolean; template?: string };
}): FormulaExportIdentity {
  const row = db.prepare(`SELECT f.scriptNumber,f.copyIndex FROM live_mixcut_formula_generation_outputs f
    JOIN live_mixcut_formula_generation_requests r ON r.id=f.requestId
    JOIN live_mixcut_output_plans p ON p.id=f.planId AND p.batchVersionId=r.batchVersionId
    JOIN live_mixcut_output_versions o ON o.planId=p.id
    JOIN live_mixcut_production_versions v ON v.id=p.batchVersionId AND v.batchId=r.batchId
    JOIN live_mixcut_productions b ON b.id=v.batchId AND b.projectId=r.projectId
    WHERE r.projectId=? AND r.batchId=? AND p.id=? AND o.id=? AND b.deletedAt IS NULL`)
    .get(input.projectId, input.batchId, input.planId, input.outputVersionId) as
      { scriptNumber: string; copyIndex: number } | undefined;
  if (!row) throw new BatchDomainError('conflict', '成片缺少对应的公式原脚本号和份次记录');
  const code = packagingCode(input.packaging);
  if (input.packaging.enabled && !code) throw new BatchDomainError('conflict', '公式成片的包装编号无法确认');
  const identity: FormulaExportIdentity = { version: 1, ...row, packagingCode: (code || 'none') as FormulaExportIdentity['packagingCode'] };
  formulaExportSuffix(identity);
  return identity;
}
