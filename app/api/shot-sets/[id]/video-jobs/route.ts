import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { runVideoQueue, getVideoQueueStatus, DEFAULT_VIDEO_CONCURRENCY } from '@/lib/video-queue';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: shotSetId } = await params;
    const db = getDb();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const shotId = body.shotId as string;
    const providerId = body.providerId as string;
    const templateId = (body.templateId as string) || null;
    const prompt = (body.prompt as string)?.trim();
    const durationSec = Number(body.durationSec) || 5;

    if (!shotId) return NextResponse.json({ error: 'shotId is required' }, { status: 400 });
    if (!providerId) return NextResponse.json({ error: 'providerId is required' }, { status: 400 });
    if (!prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    if (durationSec < 2 || durationSec > 15) return NextResponse.json({ error: 'duration must be 2-15 seconds' }, { status: 400 });

    // Validate shot belongs to this shot set
    const shot = db.prepare(`SELECT * FROM shots WHERE id = ? AND shotSetId = ?`).get(shotId, shotSetId) as {
      id: string; latestGeneratedImageId: string | null; sourceImageId: string;
    } | undefined;
    if (!shot) return NextResponse.json({ error: 'Shot not found in this shot set' }, { status: 404 });

    // Validate provider
    const provider = db.prepare(`SELECT * FROM video_providers WHERE id = ? AND enabled = 1`).get(providerId) as {
      id: string; name: string; defaultModel: string;
    } | undefined;
    if (!provider) return NextResponse.json({ error: 'Video provider not found or disabled' }, { status: 400 });

    // Use latest generated image, fallback to source image
    const sourceImageId = shot.latestGeneratedImageId || shot.sourceImageId;

    // Get project ID from shot set
    const shotSet = db.prepare(`SELECT projectId FROM shot_sets WHERE id = ?`).get(shotSetId) as {
      projectId: string;
    } | undefined;
    if (!shotSet) return NextResponse.json({ error: 'Shot set not found' }, { status: 404 });

    const videoJobId = uuidv4();
    db.prepare(`
      INSERT INTO video_jobs (id, projectId, shotSetId, shotId, sourceImageId, providerId, model, templateId, prompt, durationSec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(videoJobId, shotSet.projectId, shotSetId, shotId, sourceImageId, providerId, provider.defaultModel, templateId, prompt, durationSec);

    // Auto-start video queue if idle
    const qStatus = getVideoQueueStatus(shotSet.projectId);
    if (qStatus === 'idle') {
      runVideoQueue({
        projectId: shotSet.projectId,
        concurrency: DEFAULT_VIDEO_CONCURRENCY,
        timeoutMs: 600000,
      }).catch((err) => {
        console.error(`[VideoQueue] Auto-start failed:`, err);
      });
    }

    return NextResponse.json({ success: true, videoJobId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: shotSetId } = await params;
    const db = getDb();
    const jobs = db.prepare(`
      SELECT vj.*, vp.name as providerName, vpt.name as templateName
      FROM video_jobs vj
      LEFT JOIN video_providers vp ON vp.id = vj.providerId
      LEFT JOIN video_prompt_templates vpt ON vpt.id = vj.templateId
      WHERE vj.shotSetId = ?
      ORDER BY vj.createdAt DESC
    `).all(shotSetId);
    return NextResponse.json({ jobs });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
