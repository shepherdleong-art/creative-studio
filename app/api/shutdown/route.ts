import { NextResponse } from 'next/server';

export async function POST() {
  // Send response first, then exit so the client gets a clean reply
  const response = NextResponse.json({ message: '服务正在关闭...' });

  // Delay exit slightly to let the response flush
  setTimeout(() => {
    process.exit(0);
  }, 500);

  return response;
}
