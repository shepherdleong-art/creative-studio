import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildGenericZipStream, createZipNameRegistry, reserveZipFilename } from '@/lib/zip-download';
import type { ZipImageEntry } from '@/lib/zip-download';
import path from 'path';
import fs from 'fs';
import { dataRoot } from '@/lib/data-root';
import { resolveProjectExportDirName } from '@/lib/project-export-dir';
import { getCurrentExportDirName, getCurrentExportIdentity, listExportIdentities } from '@/lib/project-export-identity';
import { assertNoStorageSymlink } from '@/lib/final-edit/storage-path';
import { listReadableProjectScripts } from '@/lib/media-core/project-script-reader';

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
      SELECT vj.shotId, vj.filename, vj.localVideoPath, vj.prompt, vj.rejectedAt, vj.rejectReason,
        vp.name as providerName, vpt.name as templateName
      FROM video_jobs vj
      LEFT JOIN video_providers vp ON vp.id = vj.providerId
      LEFT JOIN video_prompt_templates vpt ON vpt.id = vj.templateId
      WHERE vj.projectId = ? AND vj.status = 'succeeded' AND vj.localVideoPath IS NOT NULL
      ORDER BY vj.createdAt, vj.rowid
    `).all(projectId) as Array<{
      shotId: string; filename: string | null; localVideoPath: string;
      prompt: string; rejectedAt: string | null; rejectReason: string | null;
      providerName: string | null; templateName: string | null;
    }>;

    const projectArtifacts = db.prepare(`
      SELECT kind, displayName, relativePath, mimeType, sourceJobId
      FROM project_artifacts
      WHERE projectId=? AND kind IN ('final_video', 'final_cover')
      ORDER BY createdAt, id
    `).all(projectId) as Array<{
      kind: string; displayName: string; relativePath: string; mimeType: string; sourceJobId: string | null;
    }>;

    // 新核心层优先：取当前项目脚本的当前版本；没有时回退历史最新草稿。
    const readableScripts = listReadableProjectScripts(db, projectId);
    const scriptDraft = readableScripts.find((row) => row.kind === 'project' && row.currentRevisionId)
      ?? readableScripts.find((row) => row.kind === 'project')
      ?? readableScripts[0];

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
    // 打包导出必须收齐该项目所有导出身份目录（当前 + 历史切换过的旧目录）与历史 UUID 目录，
    // 不能只认当前身份——切换新身份后旧成片仍在旧身份目录里，漏掉会破坏历史产物可读性。
    const exportDirNames = [
      ...listExportIdentities(db, projectId).map((identity) => identity.exportDirName),
      ...(getCurrentExportDirName(db, projectId) ? [getCurrentExportDirName(db, projectId)!] : []),
      resolveProjectExportDirName(db, projectId),
      projectId, // 历史 UUID 目录
    ];
    const identityArtifactRoots = [...new Set(exportDirNames)].map((dir) => path.join('projects', dir, '成片'));
    const legacyProjectArtifactRoot = path.join('projects', projectId, '成片');
    for (const artifact of projectArtifacts) {
      let filePath: string;
      try {
        const underIdentityRoot = identityArtifactRoots.some((root) => (
          artifact.relativePath.startsWith(`${root}${path.sep}`) || artifact.relativePath.startsWith(`${root}/`)
        ));
        const underLegacyRoot = artifact.relativePath.startsWith(`${legacyProjectArtifactRoot}${path.sep}`) || artifact.relativePath.startsWith(`${legacyProjectArtifactRoot}/`);
        if (!underIdentityRoot && !underLegacyRoot) continue;
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
        rejected: boolean;
        rejectReason?: string;
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
          rejected: Boolean(v.rejectedAt),
          ...(v.rejectReason ? { rejectReason: v.rejectReason } : {}),
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
    let manifestScript: Record<string, unknown> | null = null;
    if (scriptDraft) {
      try { scriptObj = JSON.parse(scriptDraft.outputJson); } catch { /* ignore */ }
      if (scriptObj) {
        const scriptJson = JSON.stringify(scriptObj, null, 2);
        const rawScript = scriptObj as Record<string, unknown>;
        const isV3 = rawScript.version === 3;
        const isV4 = rawScript.version === 4;
        const coverTitleParts = rawScript.coverTitleParts && typeof rawScript.coverTitleParts === 'object'
          ? rawScript.coverTitleParts as Record<string, unknown>
          : {};
        const knowledgeContext = rawScript.knowledgeContext && typeof rawScript.knowledgeContext === 'object'
          ? rawScript.knowledgeContext as Record<string, unknown>
          : null;
        const recommendation = rawScript.recommendation && typeof rawScript.recommendation === 'object'
          ? rawScript.recommendation as Record<string, unknown>
          : null;
        const recommendationLines: string[] = [];
        if (recommendation) {
          const framework = recommendation.framework && typeof recommendation.framework === 'object'
            ? recommendation.framework as Record<string, unknown>
            : null;
          const copyHook = recommendation.copyHook && typeof recommendation.copyHook === 'object'
            ? recommendation.copyHook as Record<string, unknown>
            : null;
          const visualHook = recommendation.visualHook && typeof recommendation.visualHook === 'object'
            ? recommendation.visualHook as Record<string, unknown>
            : null;
          if (framework) {
            const structure = Array.isArray(framework.structure) ? (framework.structure as unknown[]).map(String).join(' → ') : '';
            recommendationLines.push(`核心框架：${String(framework.name || '')}${structure ? `（节奏：${structure}）` : ''}`);
          }
          if (copyHook) {
            recommendationLines.push(`文案钩子：${String(copyHook.type || '')} / ${String(copyHook.subtype || '')}${copyHook.formula ? ` · 公式：${String(copyHook.formula)}` : ''}`);
          }
          if (visualHook) {
            recommendationLines.push(`画面钩子：${String(visualHook.name || '')}${visualHook.formula ? ` · 画面公式：${String(visualHook.formula)}` : ''}${visualHook.guidance ? ` · 制作建议：${String(visualHook.guidance)}` : ''}`);
          }
        }
        const matchedKnowledge = knowledgeContext && knowledgeContext.matchStatus === 'matched'
          ? knowledgeContext
          : null;
        const searchTermsUsed = Array.isArray(matchedKnowledge?.searchTermsUsed)
          ? (matchedKnowledge.searchTermsUsed as unknown[]).map(String).filter(Boolean)
          : [];
        const scriptText = (isV3 || isV4)
          ? [
              `# ${String(rawScript.title || '脚本')}`,
              `封面主标题：${String(coverTitleParts.primary || '')}`,
              `封面副标题：${String(coverTitleParts.secondary || '')}`,
              `目标总时长：${String(rawScript.targetDurationSec || '')} 秒`,
              ...(matchedKnowledge ? [`统一名称：${String(matchedKnowledge.canonicalName || '')}${searchTermsUsed.length > 0 ? ` · 埋词：${searchTermsUsed.join('、')}` : ''}`] : []),
              ...(recommendationLines.length > 0 ? ['', '## 推荐说明（仅文本，不含参考图片）', ...recommendationLines] : []),
              '',
              '## 配音稿（保留自然标点）',
              String(rawScript.fullScript || ''),
              '',
              '## 字幕稿（无语言标点）',
              String(rawScript.fullSubtitle || ''),
            ].join('\n')
          : typeof rawScript.fullScript === 'string' ? rawScript.fullScript : scriptJson;

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
        const segmentsArr = rawScript.segments as Array<Record<string, unknown>> | undefined;
        const legacyShotsArr = rawScript.shots as Array<Record<string, unknown>> | undefined;

        if (isV3) {
          manifestScript = {
            version: 3,
            title: String(rawScript.title || ''),
            coverTitleParts: {
              primary: String(coverTitleParts.primary || ''),
              secondary: String(coverTitleParts.secondary || ''),
            },
            targetDurationSec: Number(rawScript.targetDurationSec || 0),
            fullScript: String(rawScript.fullScript || ''),
            fullSubtitle: String(rawScript.fullSubtitle || ''),
          };
        } else {
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
    }

    // Create manifest
    const manifest = {
      projectId,
      projectName: project.name || '',
      exportedAt: new Date().toISOString(),
      ...(manifestScript ? { script: manifestScript } : {}),
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
    const baseName = getCurrentExportIdentity(db, projectId)?.baseName || String(project.name || 'project');
    const zipName = encodeURIComponent(`${baseName}-创作包.zip`);
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
