import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { resolveGptImage2Size, isValidGptImage2Size } from '@/lib/gpt-image-2-size-presets';

export async function GET() {
  try {
    const db = getDb();
    const projects = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id) as totalJobs,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id AND status = 'succeeded') as completedJobs,
        (SELECT COUNT(*) FROM jobs WHERE projectId = p.id AND status = 'failed') as failedJobs,
        (SELECT COALESCE(SUM(estimatedCost), 0) FROM jobs WHERE projectId = p.id) as totalCost
      FROM projects p
      ORDER BY p.createdAt DESC
    `).all();

    return NextResponse.json(projects);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();

    const {
      name,
      providerId,
      model,
      prompt,
      negativePrompt,
      aspectRatio,
      resolution,
      size: rawSize,
      quality,
      concurrency,
      maxAttempts,
      referenceImageIds,
      inputImageIds,
    } = body;

    // Resolve size: prefer aspectRatio+resolution, fall back to raw size with validation.
    // Never silently default to 1024x1024.
    let resolvedSize: string;
    if (aspectRatio) {
      try {
        resolvedSize = resolveGptImage2Size(aspectRatio, resolution || '1k');
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400 }
        );
      }
    } else if (rawSize && isValidGptImage2Size(rawSize)) {
      resolvedSize = rawSize;
    } else {
      return NextResponse.json(
        { error: `Invalid GPT-Image-2 size: "${rawSize || '(missing)'}". Must be a valid size or aspectRatio+resolution.` },
        { status: 400 }
      );
    }

    const projectId = uuidv4();

    // Create project
    db.prepare(`
      INSERT INTO projects (id, name, providerId, model, prompt, negativePrompt, size, quality, concurrency, maxAttempts, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `).run(
      projectId,
      name,
      providerId,
      model || 'gpt-image-2',
      prompt,
      negativePrompt || '',
      resolvedSize,
      quality || 'medium',
      concurrency || 3,
      maxAttempts || 2
    );

    // Associate reference images (and any unassigned assets)
    if (referenceImageIds && referenceImageIds.length > 0) {
      db.prepare(
        `UPDATE image_assets SET projectId = ?, role = 'reference' WHERE id IN (${referenceImageIds.map(() => '?').join(',')})`
      ).run(projectId, ...referenceImageIds);
    }

    // Associate input images and create jobs
    if (inputImageIds && inputImageIds.length > 0) {
      const refIdsJson = JSON.stringify(referenceImageIds || []);

      const updateAsset = db.prepare(
        `UPDATE image_assets SET projectId = ?, role = 'input' WHERE id = ?`
      );
      const insertJob = db.prepare(`
        INSERT INTO jobs (id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality, status, attempt, maxAttempts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
      `);

      for (const imageId of inputImageIds) {
        updateAsset.run(projectId, imageId);
        insertJob.run(
          uuidv4(),
          projectId,
          imageId,
          refIdsJson,
          providerId,
          model || 'gpt-image-2',
          prompt,
          resolvedSize,
          quality || 'medium',
          maxAttempts || 2
        );
      }
    }

    return NextResponse.json({ id: projectId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
