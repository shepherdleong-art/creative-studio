import { getDb } from '@/lib/db';
import { checkLocalRequest, assertAgentRequest } from '@/lib/final-edit/reassembled/access';
import { reviewHtml, refreshFilmReview } from '@/lib/final-edit/reassembled/review';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { NextResponse } from 'next/server';
export function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return params.then(({ id }) => { try { checkLocalRequest(request, true); return new Response(reviewHtml(getDb(), id), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }); } catch (error) { return finalEditErrorResponse(error); } });
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { assertAgentRequest(request); return NextResponse.json({ reviewFile: refreshFilmReview(getDb(), (await params).id) }); } catch (error) { return finalEditErrorResponse(error); }
}
