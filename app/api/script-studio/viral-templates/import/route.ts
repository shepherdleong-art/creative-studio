import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse, readCatalogImportUpload } from '@/lib/script-studio/http';
import { importViralTemplateLibrary, previewViralTemplateImport } from '@/lib/script-studio/viral-templates';

export const runtime = 'nodejs';

/** 爆文模板库导入：?mode=preview 只解析预览（不落库）；默认确认发布（指纹幂等）。 */
export async function POST(request: NextRequest) {
  try {
    await assertScriptStudioApiReady();
    const upload = await readCatalogImportUpload(request);
    if ('error' in upload) return upload.error;
    const buffer = Buffer.from(await upload.file.arrayBuffer());
    const mode = request.nextUrl.searchParams.get('mode');
    if (mode === 'preview') {
      const preview = await previewViralTemplateImport(buffer);
      const report = { ...preview } as Partial<typeof preview>;
      delete report.entries;
      return NextResponse.json({ preview: true, report }, { status: 200 });
    }
    const outcome = await importViralTemplateLibrary(getDb(), buffer, upload.file.name);
    return NextResponse.json(outcome, { status: outcome.created ? 201 : 200 });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
