import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  IMAGE_REFERENCE_COUNTS_SQL,
  getImageDeleteBlockMessage,
  type ImageReferenceCounts,
} from '@/lib/image-delete-policy';
import fs from 'fs';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const asset = db.prepare(`SELECT * FROM image_assets WHERE id = ?`).get(id) as {
      id: string;
      role: string;
      path: string;
      originalPath: string | null;
      processedPath: string | null;
    } | undefined;

    if (!asset) {
      return NextResponse.json({ error: '图片不存在' }, { status: 404 });
    }

    // Wrap check + delete in a transaction so TOCTOU races between the
    // reference check and the actual DELETE are protected by SQLite's FK
    // enforcement (PRAGMA foreign_keys = ON), and the atomicity ensures the
    // DB row is removed before we touch any files on disk.
    //
    // Note: jobs.referenceImageIds is a JSON array (e.g. ["id-1","id-2"])
    // not a FK column, so we CHECK it explicitly with LIKE to avoid
    // deleting images that are still used as references.
    const deleteResult = db.transaction(() => {
      const refs = db.prepare(IMAGE_REFERENCE_COUNTS_SQL).get({ id }) as ImageReferenceCounts;

      const blockMessage = getImageDeleteBlockMessage(refs);
      if (blockMessage) {
        return { blocked: true, message: blockMessage };
      }

      db.prepare(`DELETE FROM image_assets WHERE id = ?`).run(id);
      return { blocked: false, message: null };
    })();

    if (deleteResult.blocked) {
      return NextResponse.json(
        { error: deleteResult.message },
        { status: 409 }
      );
    }

    // Only delete physical files after the DB row is confirmed gone.
    // If a file deletion fails with anything other than ENOENT we log it,
    // but we still return success — the DB row is already removed and the
    // orphaned file on disk is harmless (it won't be served).
    const pathsToDelete = [asset.path, asset.originalPath, asset.processedPath].filter(
      (p): p is string => typeof p === 'string' && p.length > 0
    );
    for (const filePath of pathsToDelete) {
      try {
        fs.unlinkSync(filePath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          console.error(`[DELETE /api/images] Failed to unlink ${filePath}:`, err);
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/images/[id] failed:', err);
    return NextResponse.json({ error: '删除失败，请稍后重试' }, { status: 500 });
  }
}
