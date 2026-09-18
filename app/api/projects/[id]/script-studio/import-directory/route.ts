import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse, jsonOrNull } from '@/lib/script-studio/http';
import { importImageDirectory } from '@/lib/script-studio/import-directory';
import { ScriptStudioError } from '@/lib/script-studio/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // 本地路径导入只接受工作台同源 JSON 请求，避免其他网页读取本机文件。
    const origin = request.headers.get('origin');
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
      return NextResponse.json({ error: '仅支持从本机工作台导入文件夹' }, { status: 403 });
    }
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ScriptStudioError('invalid_input', '请使用 JSON 提交文件夹路径');
    await assertScriptStudioApiReady();
    const { id } = await params;
    const body = await jsonOrNull(request);
    if (typeof body?.directoryPath !== 'string') throw new ScriptStudioError('invalid_input', '请填写图片文件夹路径');
    return NextResponse.json(await importImageDirectory(getDb(), id, body.directoryPath, request.signal));
  } catch (error) {
    const response = errorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
