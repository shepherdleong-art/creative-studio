import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getAvailableProviders } from '@/lib/script-providers';
import { OUTPUT_PRESETS } from '@/lib/final-edit/types';
import { getFinalEditTtsAdapter } from '@/lib/final-edit/adapters/tts-registry';
import { isFinalEditAlignmentConfigured, recoverFinalEditPrepareJobs } from '@/lib/final-edit/runtime';
import { wakeFinalEditWorker } from '@/lib/final-edit/worker';
import { finalEditErrorResponse } from '@/lib/final-edit/http';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    recoverFinalEditPrepareJobs();
    wakeFinalEditWorker();
    const db = getDb();
    const project = db.prepare(`SELECT id, name FROM projects WHERE id=?`).get(projectId);
    if (!project) return NextResponse.json({ error: 'project_not_found', message: '项目不存在' }, { status: 404 });
    const drafts = (db.prepare(`SELECT id, outputJson, provider, model, createdAt FROM script_drafts WHERE projectId=? ORDER BY createdAt DESC`).all(projectId) as Array<{ id: string; outputJson: string; provider: string; model: string; createdAt: string }>).flatMap((row) => {
      try {
        const script = JSON.parse(row.outputJson) as { version?: number; title?: string; shotSetId?: string; targetDurationSec?: number; segments?: unknown[] };
        if (![2, 3].includes(Number(script.version)) || !script.shotSetId || !script.segments?.length) return [];
        return [{ id: row.id, version: script.version, title: script.title || '未命名脚本', shotSetId: script.shotSetId, targetDurationSec: script.targetDurationSec || 0, segmentCount: script.segments.length, provider: row.provider, model: row.model, createdAt: row.createdAt }];
      } catch { return []; }
    });
    const groups = db.prepare(`SELECT g.id, g.scriptDraftId, g.status, g.phase, g.narrationDurationUs, g.revision, g.createdAt, g.updatedAt, (SELECT COUNT(*) FROM final_edit_variants v WHERE v.groupId=g.id) AS variantCount FROM final_edit_groups g WHERE g.projectId=? ORDER BY g.createdAt DESC`).all(projectId);
    const tts = db.prepare(`SELECT id, name, baseUrl, model, enabled, apiKey, keyEnv FROM final_edit_tts_providers WHERE enabled=1 ORDER BY isBuiltin DESC, name LIMIT 1`).get() as { id: string; name: string; baseUrl: string; model: string; enabled: number; apiKey: string; keyEnv: string } | undefined;
    if (!tts) return NextResponse.json({ error: 'tts_provider_unavailable', message: '没有已启用的口播配音供应商' }, { status: 409 });
    const ttsAdapter = getFinalEditTtsAdapter(tts.id);
    const visionProviders = getAvailableProviders().filter((provider) => provider.supportsVision).map((provider) => ({ id: provider.id, name: provider.name, model: provider.model, configured: provider.configured }));
    return NextResponse.json({
      project, drafts, groups, visionProviders,
      ttsProvider: { id: tts.id, name: tts.name, baseUrl: tts.baseUrl, model: tts.model, enabled: Boolean(tts.enabled), hasApiKey: Boolean(tts.apiKey.trim() || (tts.keyEnv && process.env[tts.keyEnv])) },
      voices: ttsAdapter.voices, previewText: ttsAdapter.previewText,
      presets: OUTPUT_PRESETS,
      defaults: { count: 2, outputPreset: '3x4', voice: ttsAdapter.defaultVoice, speed: 1 },
      alignmentConfigured: isFinalEditAlignmentConfigured(),
    });
  } catch (error) { return finalEditErrorResponse(error); }
}
