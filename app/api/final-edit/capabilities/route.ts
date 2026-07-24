import { NextResponse } from 'next/server';
import { desktopRevealAvailable } from '@/lib/final-edit/desktop-reveal';

export async function GET() {
  return NextResponse.json({ revealInFolder: desktopRevealAvailable() });
}
