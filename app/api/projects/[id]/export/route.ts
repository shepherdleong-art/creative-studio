import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { generateCSV } from '@/lib/cost';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    // Get project runId
    const project = db.prepare(`SELECT runId FROM projects WHERE id = ?`).get(id) as { runId?: string } | undefined;
    const runId = project?.runId || '';

    const jobs = db.prepare(`
      SELECT j.*, ia.filename as inputFilename, oa.filename as outputFilename,
             p.name as providerName
      FROM jobs j
      LEFT JOIN image_assets ia ON j.inputImageId = ia.id
      LEFT JOIN image_assets oa ON j.outputImageId = oa.id
      LEFT JOIN providers p ON j.providerId = p.id
      WHERE j.projectId = ?
      ORDER BY j.id
    `).all(id) as Array<{
      id: string;
      providerName: string;
      model: string;
      inputFilename: string;
      status: string;
      attempt: number;
      latencyMs: number | null;
      estimatedCost: number | null;
      errorMessage: string | null;
      outputFilename: string;
      providerTaskId: string | null;
      providerStatus: string | null;
    }>;

    const records = jobs.map((j) => ({
      runId,
      jobId: j.id,
      provider: j.providerName || '',
      model: j.model,
      inputFilename: j.inputFilename || '',
      status: j.status,
      attempts: j.attempt,
      latencySeconds: j.latencyMs ? j.latencyMs / 1000 : 0,
      estimatedCost: j.estimatedCost || 0,
      errorMessage: j.errorMessage || '',
      outputFilename: j.outputFilename || '',
      providerTaskId: j.providerTaskId || '',
      providerStatus: j.providerStatus || '',
    }));

    const csv = generateCSV(records, id);

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="project_${id}_report.csv"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
