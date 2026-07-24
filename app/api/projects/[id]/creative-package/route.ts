import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildGenericZipStream, createZipNameRegistry, reserveZipFilename } from '@/lib/zip-download';
import type { ZipImageEntry } from '@/lib/zip-download';
import path from 'path';
import fs from 'fs';
import { dataRoot } from '@/lib/data-root';
import { assertNoStorageSymlink } from '@/lib/final-edit/storage-path';

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

    const projectArtifacts = db.prepare(`
      SELECT kind, displayName, relativePath, mimeType, sourceJobId
      FROM project_artifacts
      WHERE projectId=? AND kind IN ('final_video', 'final_cover')
      ORDER BY createdAt, id
    `).all(projectId) as Array<{
      kind: string; displayName: string; relativePath: string; mimeType: string; sourceJobId: string | null;
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

    const manifestArtifacts: Array<{ kind: string; filename: string; sourceJobId: string | null }> = [];
    const storageRoot = path.join(dataRoot(), 'storage');
    const projectArtifactRoot = path.join('projects', projectId, '成片');
    for (const artifact of projectArtifacts) {
      let filePath: string;
      try {
        if (!artifact.relativePath.startsWith(`${projectArtifactRoot}${path.sep}`) && !artifact.relativePath.startsWith(`${projectArtifactRoot}/`)) continue;
        filePath = assertNoStorageSymlink(storageRoot, artifact.relativePath);
      }
      catch { continue; }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const filename = addEntry(filePath, `${prefix}成片/${artifact.displayName}`);
      manifestArtifacts.push({ kind: artifact.kind, filename, sourceJobId: artifact.sourceJobId });
    }

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
      artifacts: manifestArtifacts,
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
