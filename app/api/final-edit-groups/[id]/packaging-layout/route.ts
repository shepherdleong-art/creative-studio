import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { FinalEditError } from '@/lib/final-edit/errors';
import { OUTPUT_PRESETS } from '@/lib/final-edit/types';
import { buildPackagingVars, loadProjectPackagingData, parsePackagingConfig } from '@/lib/final-edit/packaging-vars';
import { planPackagingStickerAutoLayout, replaceAutomaticPackagingStickers, type PackagingStickerPlanningAsset } from '@/lib/media-core/packaging-sticker-planner';
import { validatePackagingStickers, type PackagingStickerInstance } from '@/lib/media-core/packaging-stickers';
import { packagingAutoLayoutInputHash, resolvePackagingAutoLayout } from '@/lib/media-core/packaging-auto-layout-service';
import { assertPackagingLayoutExportReady } from '@/lib/media-core/packaging-layout-manifest';
import { resolvePackagingDir } from '@/lib/media-core/packaging-runtime';
import { ensurePackagingPointCues } from '@/lib/final-edit/packaging-cues';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

type CandidatePayload = { autoGroupId: string; stickers: PackagingStickerInstance[] };
type LayoutRequest = {
  operation?: 'auto-stickers' | 'revalidate' | 'reextract-points';
  expectedRevision?: number;
  expectedPackagingJson?: string;
  expectedPackaging?: unknown;
  variantId?: string;
  candidatePayload?: CandidatePayload;
};

function overridesRecord(value: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

async function layoutCommand(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const groupId = (await params).id;
    const body = await request.json() as LayoutRequest;
    if (!Number.isSafeInteger(body.expectedRevision) || !body.variantId
      || (typeof body.expectedPackagingJson !== 'string' && body.expectedPackaging === undefined)) {
      throw new FinalEditError('layout_command_invalid', '自动布局命令缺少修订或成片信息', 400);
    }
    const db = getDb();
    const workspace = getFinalEditWorkspace();
    const row = db.prepare('SELECT revision, packagingJson FROM final_edit_groups WHERE id=?').get(groupId) as { revision: number; packagingJson: string | null } | undefined;
    const expectedPackaging = body.expectedPackaging !== undefined
      ? parsePackagingConfig(body.expectedPackaging)
      : parsePackagingConfig(body.expectedPackagingJson ?? '');
    const currentPackaging = parsePackagingConfig(row?.packagingJson);
    // Resolution 是同修订内可重算的派生缓存；用户内容仍逐项严格比较，避免后台重解析阻塞显式布局命令。
    if (!row || row.revision !== body.expectedRevision || !isDeepStrictEqual(
      { ...currentPackaging, layoutResolution: undefined },
      { ...expectedPackaging, layoutResolution: undefined },
    )) {
      throw new FinalEditError('revision_conflict', '包装配置已更新，请刷新后重试', 409);
    }
    const group = workspace.load(groupId);
    const variant = group.variants.find((item) => item.id === body.variantId);
    if (!variant) throw new FinalEditError('variant_not_found', '贴纸所属成片草稿不存在', 404);
    const operation = body.operation ?? 'auto-stickers';
    if (!['auto-stickers', 'revalidate', 'reextract-points'].includes(operation)) {
      throw new FinalEditError('layout_command_invalid', '自动布局操作无效', 400);
    }
    let candidatePayload = body.candidatePayload;
    let stickers = group.packaging.stickers ?? [];
    let candidateBase = group.packaging;
    if (operation === 'auto-stickers') {
      if (!candidatePayload) {
        const { assets } = JSON.parse(fs.readFileSync(path.join(resolvePackagingDir(), 'stickers', 'catalog.json'), 'utf8')) as { assets: PackagingStickerPlanningAsset[] };
        const autoGroupId = `auto_${randomUUID()}`;
        const generated = planPackagingStickerAutoLayout({
          bodyFrames: variant.timeline.bodyFrames,
          template: group.packaging.template,
          assets,
          animation: group.packaging.stickerDefaults?.animation ?? 'follow-template',
          autoGroupId,
          random: Math.random,
          createId: () => `s_${randomUUID()}`,
          outputWidth: OUTPUT_PRESETS[variant.outputPreset].width,
          outputHeight: OUTPUT_PRESETS[variant.outputPreset].height,
        });
        if (!generated) throw new FinalEditError('sticker_auto_pool_invalid', '当前正文或画幅无法生成基础贴纸', 409);
        candidatePayload = { autoGroupId, stickers: generated };
      }
      const generated = validatePackagingStickers(candidatePayload.stickers, variant.timeline.bodyFrames);
      if (!generated.every((sticker) => sticker.origin.kind === 'auto' && sticker.origin.layoutVersion === 2)) {
        throw new FinalEditError('layout_candidate_invalid', '自动布局候选版本无效', 400);
      }
      stickers = replaceAutomaticPackagingStickers(stickers, generated);
    } else if (operation === 'reextract-points') {
      if (!group.packaging.enabled) throw new FinalEditError('packaging_disabled', '开启视频包装后才能重新提取卖点', 409);
      const extracted = await ensurePackagingPointCues(db, groupId, { force: true, persist: false });
      const layouts = structuredClone(group.packaging.layouts ?? {});
      const currentTemplate = layouts[group.packaging.template];
      if (currentTemplate) {
        if (currentTemplate.cover) layouts[group.packaging.template] = { cover: currentTemplate.cover };
        else delete layouts[group.packaging.template];
      }
      candidateBase = {
        ...group.packaging,
        pointCues: extracted.pointCues,
        pointCuesKey: extracted.pointCuesKey,
        pointCuesMode: extracted.mode,
        pointCuesEdited: false,
        pointCuesLayoutVersion: 2,
        layoutRuntimeBundleVersion: 2,
        layouts,
      };
    } else if (group.packaging.layoutRuntimeBundleVersion !== 2) {
      return NextResponse.json({ status: 'resolved', view: group, candidatePayload: null });
    }

    const candidateConfig = { ...candidateBase };
    delete candidateConfig.layoutResolution;
    const config = { ...candidateConfig, stickers, layoutRuntimeBundleVersion: 2 as const };
    const output = OUTPUT_PRESETS[variant.outputPreset];
    const layoutInput = {
      config,
      vars: buildPackagingVars({
        coverTitle: { primary: group.coverTitle.primary.text, secondary: group.coverTitle.secondary.text },
        subtitleCues: group.subtitleCues,
        project: loadProjectPackagingData(db, group.projectId),
        overrides: group.packaging.varsOverrides,
      }),
      totalSec: 20 / 24 + variant.timeline.bodyFrames / 24,
      coverSec: 20 / 24,
      outputWidth: output.width,
      outputHeight: output.height,
      signal: request.signal,
    };
    const previous = group.packaging.layoutResolution;
    if (operation === 'revalidate' && previous?.status === 'resolved' && previous.inputHash === packagingAutoLayoutInputHash(layoutInput)) {
      assertPackagingLayoutExportReady(group.packaging, output.width, output.height);
      return NextResponse.json({ status: 'resolved', view: group, candidatePayload: null });
    }
    const resolution = await resolvePackagingAutoLayout(layoutInput);
    if (resolution.status !== 'resolved') {
      return NextResponse.json({
        status: resolution.status,
        message: resolution.status === 'budget_exceeded' ? '自动布局计算未完成，请重试' : '上 40% 空间不足，请移开手动元素后重试',
        conflicts: 'conflicts' in resolution ? resolution.conflicts ?? [] : [],
        candidatePayload: operation === 'auto-stickers' ? candidatePayload : null,
      });
    }
    const applied = workspace.apply({
      scope: 'group',
      groupId,
      expectedRevision: body.expectedRevision!,
      type: 'set_packaging_config',
      variantId: variant.id,
      config: {
        enabled: config.enabled,
        template: config.template,
        varsOverrides: overridesRecord(config.varsOverrides),
        layoutRuntimeBundleVersion: 2,
        layoutResolution: resolution,
        ...(operation === 'revalidate' ? { layoutResolutionOnly: true } : {}),
        expectedPackagingJson: String(row.packagingJson ?? ''),
        ...(operation === 'auto-stickers' ? { stickers } : {}),
        ...(operation === 'reextract-points' ? {
          pointCues: config.pointCues ?? [],
          pointCuesKey: config.pointCuesKey,
          pointCuesMode: config.pointCuesMode,
          pointCuesEdited: false,
          pointCuesLayoutVersion: 2,
          layouts: config.layouts ?? {},
          forceReextract: true,
        } : {}),
      },
    });
    return NextResponse.json({ status: 'resolved', view: applied.view, candidatePayload: operation === 'auto-stickers' ? candidatePayload : null });
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
export const POST = withTeamRoute('/api/final-edit-groups/[id]/packaging-layout', 'POST', layoutCommand);
