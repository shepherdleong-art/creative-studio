import type Database from 'better-sqlite3';
import path from 'node:path';
import { dataRoot } from '../../data-root.ts';
import { buildVerifiedZipStream, verifyZipFile, type VerifiedZipFile } from '../../media-core/verified-zip.ts';
import { fingerprintHex, fingerprintsEqual } from '../fingerprint.ts';
import { FormulaPackageError, getFormulaExportPackage, type FormulaExportManifest } from './export-package.ts';

function csvCell(value: unknown): string {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

/** CSV and JSON are two views of the very same frozen manifest. */
function csvManifest(manifest: FormulaExportManifest): string {
  const rows: unknown[][] = [['原脚本号', '份次', '原始公式', '应用公式', '脚本文案', '实际用片及源区间', '人工偏离',
    '声音', '音乐', '包装', '封面设置', '字幕', '输出版本', '编辑修订', '渲染身份', '视频文件', '视频校验值', '封面文件', '封面校验值']];
  for (const item of manifest.items) rows.push([item.scriptNumber, item.copyIndex, item.originalFormula, item.appliedFormula,
    item.bodyText, item.clips, item.deviations, item.audio, item.music, item.packaging, item.cover, item.subtitles,
    item.outputVersionId, item.editRevision, item.fullRenderContractHash, item.video.filename, item.video.checksum,
    item.coverFile.filename, item.coverFile.checksum]);
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Resolve immutable artifact references, never current drafts or current-artifact pointers. */
export async function downloadFormulaExportPackage(db: Database.Database, projectId: string, batchId: string, packageId: string,
  signal?: AbortSignal) {
  const saved = getFormulaExportPackage(db, projectId, batchId, packageId);
  const files: VerifiedZipFile[] = [];
  const errors: FormulaPackageError['items'] = [];
  const storageRoot = path.join(dataRoot(), 'storage');
  for (const item of saved.manifest.items) {
    const reference = db.prepare('SELECT videoArtifactId,coverArtifactId FROM batch_formula_export_package_items WHERE packageId=? AND planId=?')
      .get(packageId, item.planId) as { videoArtifactId: string; coverArtifactId: string } | undefined;
    for (const [kind, file] of [['video', item.video], ['cover', item.coverFile]] as const) {
      signal?.throwIfAborted();
      try {
        const artifact = db.prepare(`SELECT relativePath,checksum FROM batch_artifacts
          WHERE id=? AND projectId=? AND batchId=? AND outputPlanId=? AND outputVersionId=? AND kind=?`)
          .get(file.artifactId, projectId, batchId, item.planId, item.outputVersionId, kind) as { relativePath: string; checksum: string } | undefined;
        if (!reference || file.artifactId !== (kind === 'video' ? reference.videoArtifactId : reference.coverArtifactId)
          || !artifact || !fingerprintsEqual(artifact.checksum, file.checksum)) throw new Error('identity');
        const entry = { filename: file.filename, relativePath: artifact.relativePath, sha256: fingerprintHex(file.checksum) };
        await verifyZipFile(storageRoot, entry, signal);
        files.push(entry);
      } catch {
        signal?.throwIfAborted();
        errors.push({ planId: item.planId, message: `脚本 ${item.scriptNumber} 第 ${item.copyIndex} 份的${kind === 'video' ? '视频' : '封面'}缺失或已变化，不能下载此包` });
      }
    }
  }
  if (errors.length) throw new FormulaPackageError(errors);
  return {
    filename: `实拍成片-${saved.createdAt.slice(0, 10)}-${saved.id}.zip`,
    stream: buildVerifiedZipStream(storageRoot, files, [
      { filename: '清单.json', text: JSON.stringify(saved.manifest, null, 2) + '\n' },
      { filename: '清单.csv', text: csvManifest(saved.manifest) },
    ], { date: new Date(saved.createdAt), signal }),
  };
}
