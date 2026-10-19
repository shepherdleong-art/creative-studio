import { NextResponse } from 'next/server';
import { listSystemFonts } from '@/lib/final-edit/system-fonts';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === '1';
  return NextResponse.json({ fonts: listSystemFonts({ forceRefresh }) });
}
