import { NextResponse } from 'next/server';

export function GET(): NextResponse {
  const instanceId = process.env.CREATIVE_STUDIO_INSTANCE_ID;
  if (!instanceId) {
    return NextResponse.json(
      { error: 'desktop_instance_id_missing' },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }

  return NextResponse.json(
    { instanceId },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
