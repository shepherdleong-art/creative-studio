import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { checkLocalRequest } from '@/lib/final-edit/reassembled/access';
import { readProduction } from '@/lib/final-edit/reassembled/production';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { checkLocalRequest(request); return NextResponse.json(readProduction(getDb(), (await params).id), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return finalEditErrorResponse(error); }
}
