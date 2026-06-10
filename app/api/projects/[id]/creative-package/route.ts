import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildGenericZipStream, ZipImageEntry } from '@/lib/zip-download';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const db = getDb();

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as Record<string, unknown> | undefined;
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    // Gather shots with generated images
    const shots = db.prepare(`
      SELECT s.indexNum, s.id as shotId, src.filename as sourceFilename,
        out.path as imagePath, out.filename as imageFilename
      FROM shots s
      JOIN shot_sets ss ON ss.id = s.shotSetId
      LEFT JOIN image_assets out ON out.id = s.latestGeneratedImageId
      LEFT JOIN image_assets src ON src.id = s.sourceImageId
      WHERE ss.projectId = ?
      ORDER BY ss.createdAt, s.indexNum
    `).all(projectId) as Array<{
      indexNum: number; shotId: string; sourceFilename: string | null;
      imagePath: string | null; imageFilename: string | null;
    }>;

    // Gather video jobs
    const videos = db.prepare(`
      SELECT vj.shotId, vj.filename, vj.localVideoPath, vj.prompt,
        vp.name as providerName, vpt.name as templateName
      FROM video_jobs vj
      LEFT JOIN video_providers vp ON vp.id = vj.providerId
      LEFT JOIN video_prompt_templates vpt ON vpt.id = vj.templateId
      WHERE vj.projectId = ? AND vj.status = 'succeeded' AND vj.localVideoPath IS NOT NULL
      ORDER BY vj.createdAt
    `).all(projectId) as Array<{
      shotId: string; filename: string | null; localVideoPath: string;
      prompt: string; providerName: string | null; templateName: string | null;
    }>;

    // Latest script draft
    const scriptDraft = db.prepare(`
      SELECT outputJson FROM script_drafts
      WHERE projectId = ? ORDER BY createdAt DESC LIMIT 1
    `).get(projectId) as { outputJson: string } | undefined;

    // Build entries
    const entries: ZipImageEntry[] = [];
    const manifestShots: Array<{
      shotIndex: number;
      sourceImage: string;
      videos: Array<{
        filename: string;
        provider: string;
        template: string;
        prompt: string;
      }>;
      script?: { voiceover: string; subtitle: string };
    }> = [];

    const prefix = `${String(project.name || 'project').replace(/[/\\:*?"<>|]/g, '_')}-package/`;

    // Add shot images
    for (const shot of shots) {
      const shotEntry = shot.imagePath ? `${prefix}images/shot-${String(shot.indexNum).padStart(2, '0')}.png` : null;
      if (shot.imagePath) {
        const storageRoot = path.resolve(path.join(process.cwd(), 'storage'));
        const resolved = path.resolve(shot.imagePath);
        if (resolved.startsWith(storageRoot + path.sep) && fs.existsSync(resolved)) {
          entries.push({ filePath: resolved, filename: shotEntry! });
        }
      }

      const shotVideos = videos.filter((v) => v.shotId === shot.shotId);
      manifestShots.push({
        shotIndex: shot.indexNum,
        sourceImage: shotEntry || '',
        videos: shotVideos.map((v) => {
          const videoFilename = `${prefix}videos/shot-${String(shot.indexNum).padStart(2, '0')}-${v.providerName || 'unknown'}-${v.templateName || 'custom'}.mp4`;
          if (v.localVideoPath) {
            const resolved = path.resolve(v.localVideoPath);
            const storageRoot = path.resolve(path.join(process.cwd(), 'storage'));
            if (resolved.startsWith(storageRoot + path.sep) && fs.existsSync(resolved)) {
              entries.push({ filePath: resolved, filename: videoFilename });
            }
          }
          return {
            filename: videoFilename,
            provider: v.providerName || 'unknown',
            template: v.templateName || 'custom',
            prompt: v.prompt || '',
          };
        }),
      });
    }

    // Add script files
    let scriptObj: unknown = null;
    if (scriptDraft) {
      try { scriptObj = JSON.parse(scriptDraft.outputJson); } catch { /* ignore */ }
      if (scriptObj) {
        const scriptJson = JSON.stringify(scriptObj, null, 2);
        const scriptText = typeof (scriptObj as Record<string, unknown>).fullScript === 'string'
          ? (scriptObj as Record<string, unknown>).fullScript as string
          : scriptJson;

        // Write script files to temp so they can be added to zip
        const tmpDir = path.join(process.cwd(), 'storage', 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const txtPath = path.join(tmpDir, `script-${projectId}-latest.txt`);
        const jsonPathf = path.join(tmpDir, `script-${projectId}-latest.json`);
        fs.writeFileSync(txtPath, scriptText, 'utf-8');
        fs.writeFileSync(jsonPathf, scriptJson, 'utf-8');

        entries.push({ filePath: txtPath, filename: `${prefix}scripts/latest-script.txt` });
        entries.push({ filePath: jsonPathf, filename: `${prefix}scripts/latest-script.json` });

        // Annotate shots with script
        const shotsArr = (scriptObj as Record<string, unknown>).shots as Array<Record<string, unknown>> | undefined;
        if (shotsArr) {
          for (const s of manifestShots) {
            const match = shotsArr.find((ss) => ss.shotIndex === s.shotIndex);
            if (match) {
              s.script = {
                voiceover: String(match.voiceover || ''),
                subtitle: String(match.subtitle || ''),
              };
            }
          }
        }
      }
    }

    // Create manifest
    const manifest = {
      projectId,
      projectName: project.name || '',
      exportedAt: new Date().toISOString(),
      shots: manifestShots,
    };

    const tmpDir = path.join(process.cwd(), 'storage', 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const manifestPath = path.join(tmpDir, `manifest-${projectId}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    entries.push({ filePath: manifestPath, filename: `${prefix}manifest.json` });

    if (entries.length === 0) {
      return NextResponse.json({ error: 'No content to export' }, { status: 404 });
    }

    const stream = buildGenericZipStream(entries);
    const zipName = encodeURIComponent(`${String(project.name || 'project')}-creative-package.zip`);
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${zipName}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
