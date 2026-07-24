import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { buildGenericZipStream, type ZipImageEntry } from '@/lib/zip-download';
import { assertNoStorageSymlink } from '@/lib/final-edit/storage-path';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const group = getDb().prepare(`SELECT id FROM final_edit_groups WHERE id=?`).get(id);
    if (!group) return NextResponse.json({ error: 'group_not_found' }, { status: 404 });
    const variants = getDb().prepare(`SELECT id, indexNum FROM final_edit_variants WHERE groupId=? ORDER BY indexNum`).all(id) as Array<{ id: string; indexNum: number }>;
    const entries: ZipImageEntry[] = [];
    for (const variant of variants) {
      const row = getDb().prepare(`SELECT outputJson FROM final_edit_jobs WHERE variantId=? AND kind='render' AND status='succeeded' ORDER BY finishedAt DESC LIMIT 1`).get(variant.id) as { outputJson: string } | undefined;
      if (!row) continue;
      const output = JSON.parse(row.outputJson) as { videoRelativePath: string; coverRelativePath: string; publishedVideoRelativePath?: string; publishedCoverRelativePath?: string };
      const prefix = `成片-${String(variant.indexNum).padStart(2, '0')}`;
      const storageRoot = path.join(dataRoot(), 'storage');
      entries.push({ filePath: assertNoStorageSymlink(storageRoot, output.publishedVideoRelativePath || output.videoRelativePath), filename: `${prefix}/${prefix}.mp4` });
      entries.push({ filePath: assertNoStorageSymlink(storageRoot, output.publishedCoverRelativePath || output.coverRelativePath), filename: `${prefix}/${prefix}-封面.jpg` });
    }
    if (!entries.length) return NextResponse.json({ error: 'no_rendered_variants', message: '当前成片组没有成功导出的产物' }, { status: 404 });
    return new NextResponse(buildGenericZipStream(entries), { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`成片组-${id}.zip`)}`, 'Cache-Control': 'no-store' } });
  } catch (error) { return NextResponse.json({ error: 'zip_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
