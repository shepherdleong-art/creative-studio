import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { adoptFilmIntoMixcut } from '@/lib/final-edit/reassembled/adopt';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { PACKAGING_TEMPLATE_IDS, type PackagingTemplateId } from '@/lib/media-core/packaging-vars';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (request.headers.has('x-reassembled-token') || request.headers.get('sec-fetch-site') !== 'same-origin' || !origin || new URL(origin).host !== host) return NextResponse.json({ error: 'origin_denied' }, { status: 403 });
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    if (body.template !== undefined && (!PACKAGING_TEMPLATE_IDS.includes(body.template) || !Number.isInteger(body.expectedRevision) || !Number.isInteger(body.expectedGroupRevision))) {
      return NextResponse.json({ error: '请选择有效包装并刷新草稿版本' }, { status: 400 });
    }
    adoptFilmIntoMixcut(getDb(), path.join(dataRoot(), 'storage'), id, body.template === undefined ? undefined : {
      template: body.template as PackagingTemplateId, expectedRevision: body.expectedRevision, expectedGroupRevision: body.expectedGroupRevision,
    });
    return NextResponse.json(getFinalEditWorkspace().load(id));
  } catch (error) { return finalEditErrorResponse(error); }
}
