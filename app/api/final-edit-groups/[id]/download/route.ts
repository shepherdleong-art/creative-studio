import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { buildGenericZipStream, type ZipImageEntry } from '@/lib/zip-download';
import { assertNoStorageSymlink } from '@/lib/final-edit/storage-path';
import { getCurrentExportIdentity, listExportIdentities } from '@/lib/project-export-identity';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const group = db.prepare(`SELECT id, projectId FROM final_edit_groups WHERE id=?`).get(id) as { id: string; projectId: string } | undefined;
    if (!group) return NextResponse.json({ error: 'group_not_found' }, { status: 404 });
    const variants = db.prepare(`SELECT id, indexNum FROM final_edit_variants WHERE groupId=? ORDER BY indexNum`).all(id) as Array<{ id: string; indexNum: number }>;
    const entries: ZipImageEntry[] = [];
    // 成片组 ZIP 使用该组产物实际所在导出身份的基础名：切换到新身份后，
    // 旧成片组仍在旧身份目录里，不得用当前身份改名重命名（历史产物可读性）。
    let baseName = '';
    const identities = listExportIdentities(db, group.projectId);
    const storageRoot = path.join(dataRoot(), 'storage');
    for (const variant of variants) {
      const row = db.prepare(`SELECT outputJson FROM final_edit_jobs WHERE variantId=? AND kind='render' AND status='succeeded' ORDER BY finishedAt DESC LIMIT 1`).get(variant.id) as { outputJson: string } | undefined;
      if (!row) continue;
      const output = JSON.parse(row.outputJson) as { videoRelativePath: string; coverRelativePath: string; publishedVideoRelativePath?: string; publishedCoverRelativePath?: string };
      const videoRelativePath = output.publishedVideoRelativePath || output.videoRelativePath;
      if (!baseName) {
        // 按「先身份目录、后当前身份、再文件名回退」的顺序决定基础名，避免历史组漂移。
        const matched = identities
          .filter((identity) => videoRelativePath.startsWith(`projects/${identity.exportDirName}/`))
          .sort((a, b) => a.revisionNumber - b.revisionNumber)[0];
        baseName = matched?.baseName
          ?? getCurrentExportIdentity(db, group.projectId)?.baseName
          ?? path.basename(videoRelativePath).replace(/\.mp4$/i, '');
      }
      const prefix = `${baseName}-${String(variant.indexNum).padStart(2, '0')}`;
      entries.push({ filePath: assertNoStorageSymlink(storageRoot, videoRelativePath), filename: `${prefix}/${prefix}.mp4` });
      entries.push({ filePath: assertNoStorageSymlink(storageRoot, output.publishedCoverRelativePath || output.coverRelativePath), filename: `${prefix}/${prefix}-封面.jpg` });
    }
    if (!entries.length) return NextResponse.json({ error: 'no_rendered_variants', message: '当前成片组没有成功导出的产物' }, { status: 404 });
    return new NextResponse(buildGenericZipStream(entries), { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName || '成片组'}-成片组.zip`)}`, 'Cache-Control': 'no-store' } });
  } catch (error) { return NextResponse.json({ error: 'zip_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
