import { NextResponse } from 'next/server';
import { listSystemFonts } from '@/lib/final-edit/system-fonts';

export async function GET() {
  return NextResponse.json({ fonts: listSystemFonts() });
}
