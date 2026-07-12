import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildGenericZipStream, createZipNameRegistry, reserveZipFilename } from '@/lib/zip-download';
import type { ZipImageEntry } from '@/lib/zip-download';
import path from 'path';
import fs from 'fs';
import { dataRoot } from '@/lib/data-root';

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
    const zipNames = createZipNameRegistry();
    const addEntry = (filePath: string, filename: string): string => {
      const zipFilename = reserveZipFilename(filename, zipNames);
      entries.push({ filePath, filename: zipFilename });
      return zipFilename;
    };
    const manifestShots: Array<{
      shotId: string;
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
      let shotEntry = shot.imagePath ? `${prefix}images/shot-${String(shot.indexNum).padStart(2, '0')}.png` : null;
      if (shot.imagePath) {
        const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
        const resolved = path.resolve(shot.imagePath);
        if (resolved.startsWith(storageRoot + path.sep) && fs.existsSync(resolved)) {
          shotEntry = addEntry(resolved, shotEntry!);
        }
      }

      const shotVideos = videos.filter((v) => v.shotId === shot.shotId);
      const manifestVideos: Array<{
        filename: string;
        provider: string;
        template: string;
        prompt: string;
      }> = [];
      for (const v of shotVideos) {
        let videoFilename = `${prefix}videos/shot-${String(shot.indexNum).padStart(2, '0')}-${v.providerName || 'unknown'}-${v.templateName || 'custom'}.mp4`;
        const resolved = path.resolve(v.localVideoPath);
        const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
        if (!resolved.startsWith(storageRoot + path.sep) || !fs.existsSync(resolved)) continue;
        videoFilename = addEntry(resolved, videoFilename);
        manifestVideos.push({
          filename: videoFilename,
          provider: v.providerName || 'unknown',
          template: v.templateName || 'custom',
          prompt: v.prompt || '',
        });
      }

      manifestShots.push({
        shotId: shot.shotId,
        shotIndex: shot.indexNum,
        sourceImage: shotEntry || '',
        videos: manifestVideos,
      });
    }

    // Add final packaged videos (kind='final' only; preview jobs excluded from ZIP)
    const finalRows = db.prepare(`
      SELECT id, outputPath, coverPath, manifestPath, packageJson, durationSec FROM final_video_jobs
      WHERE projectId = ? AND status = 'succeeded' AND kind = 'final' AND outputPath IS NOT NULL
      ORDER BY createdAt
    `).all(projectId) as Array<{
      id: string; outputPath: string; coverPath: string | null;
      manifestPath: string | null; packageJson: string; durationSec: number | null;
    }>;
    const manifestFinals: Array<{ filename: string; cover: string; durationSec: number | null }> = [];
    const storageRootForFinals = path.resolve(path.join(dataRoot(), 'storage'));
    for (const f of finalRows) {
      let outputName = f.id;
      try { outputName = String(JSON.parse(f.packageJson).outputName || f.id); } catch { /* keep id */ }
      const resolvedOut = path.resolve(f.outputPath);
      if (!resolvedOut.startsWith(storageRootForFinals + path.sep) || !fs.existsSync(resolvedOut)) continue;
      const videoEntry = addEntry(resolvedOut, `${prefix}finals/${outputName}.mp4`);
      let coverEntry = '';
      if (f.coverPath && fs.existsSync(f.coverPath) && path.resolve(f.coverPath).startsWith(storageRootForFinals + path.sep)) {
        coverEntry = addEntry(path.resolve(f.coverPath), `${prefix}finals/${outputName}-cover.jpg`);
      }
      if (f.manifestPath && fs.existsSync(f.manifestPath) && path.resolve(f.manifestPath).startsWith(storageRootForFinals + path.sep)) {
        addEntry(path.resolve(f.manifestPath), `${prefix}finals/${outputName}-manifest.json`);
      }
      manifestFinals.push({ filename: videoEntry, cover: coverEntry, durationSec: f.durationSec });
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
        const tmpDir = path.join(dataRoot(), 'storage', 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const txtPath = path.join(tmpDir, `script-${projectId}-latest.txt`);
        const jsonPathf = path.join(tmpDir, `script-${projectId}-latest.json`);
        fs.writeFileSync(txtPath, scriptText, 'utf-8');
        fs.writeFileSync(jsonPathf, scriptJson, 'utf-8');

        addEntry(txtPath, `${prefix}scripts/latest-script.txt`);
        addEntry(jsonPathf, `${prefix}scripts/latest-script.json`);

        // Annotate shots with script.
        // v2：segments[] 按 shotId 关联（segments 没有 shotIndex，且顺序是叙事顺序不是分镜序）。
        // 旧草稿：shots[] 仍按 shotIndex 关联，保持原行为。
        const rawScript = scriptObj as Record<string, unknown>;
        const segmentsArr = rawScript.segments as Array<Record<string, unknown>> | undefined;
        const legacyShotsArr = rawScript.shots as Array<Record<string, unknown>> | undefined;

        for (const s of manifestShots) {
          const match = segmentsArr
            ? segmentsArr.find((ss) => ss.shotId === s.shotId)
            : legacyShotsArr?.find((ss) => ss.shotIndex === s.shotIndex);
          if (!match) continue;
          s.script = {
            voiceover: String(match.narration ?? match.voiceover ?? ''),
            subtitle: String(match.subtitle || ''),
          };
        }
      }
    }

    // Create manifest
    const manifest = {
      projectId,
      projectName: project.name || '',
      exportedAt: new Date().toISOString(),
      shots: manifestShots,
      finalVideos: manifestFinals,
    };

    const tmpDir = path.join(dataRoot(), 'storage', 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const manifestPath = path.join(tmpDir, `manifest-${projectId}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    addEntry(manifestPath, `${prefix}manifest.json`);

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
