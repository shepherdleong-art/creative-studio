import { NextRequest, NextResponse } from 'next/server';
import { getProjectLogs, getJobLogs } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');
    const limit = parseInt(searchParams.get('limit') || '200', 10);

    if (jobId) {
      const logs = getJobLogs(jobId);
      return NextResponse.json(logs, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const logs = getProjectLogs(id, limit);
    return NextResponse.json(logs, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
