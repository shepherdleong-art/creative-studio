import { PACKAGING_EDIT_BRIDGE_JS } from '@/lib/media-core/packaging-edit-bridge';
// 包装 v2/v3 实时预览端点（配置前置：预览发生在导出渲染之前）
// GET ?variantId=&template=&format=json|html[&t=<秒>][&sync=1][&edit=1]
//   json → { vars, defaults, frameUrl, template, timeline:{coverSec,totalSec,pointCues,pointCuesMode},
//            layouts, pointCuesStale, pointCuesEdited }
//   html → 模板 index.html 注入变量（含 v3 时序 + §7 layouts）+ 封面帧底图 + <base> 静态资源；
//          t 提供时 seek 到该时间点（暂停），否则自动循环播放（近似效果）；
//          sync=1 → 不注入任何 autoplay/seek 脚本（时间轴由父页面经 window.__timelines['overlay'] 全权驱动，§3，优先级高于 t）；
//          edit=1 → 注入预览画面内拖拽/缩放编辑桥（§6，配合模板 data-point-id / window.__pointLayout 契约）。
// 不跑 HyperFrames、不渲染视频；A 模板吸色用封面帧近似（导出时吸成片中帧）。

import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { FinalEditError } from '@/lib/final-edit/errors';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { materializeCoverFrame } from '@/lib/final-edit/cover-frame';
import { extractAccentColors } from '@/lib/final-edit/packaging-color';
import { buildPackagingVars, DEFAULT_PACKAGING_TEMPLATE, type PackagingVars } from '@/lib/final-edit/packaging-vars';
import { computePointCuesKey, ensurePackagingPointCues, loadGroupNarrationText, type PointCue } from '@/lib/final-edit/packaging-cues';
import { buildTimelineVars, loadProjectPackagingData, resolvePackagingDir, resolvePackagingTemplateDir } from '@/lib/final-edit/packaging';
import { buildConfigFontFacesCss } from '@/lib/final-edit/packaging-font';
import { extractPackagingPalette, resolveTemplateHueMode, type PackagingPalette } from '@/lib/final-edit/packaging-palette';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { FINAL_EDIT_INTRO_DURATION_US } from '@/lib/media-core/render-contract';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: groupId } = await params;
    const query = new URL(request.url).searchParams;
    const variantId = query.get('variantId') || '';
    const template = query.get('template') || DEFAULT_PACKAGING_TEMPLATE;
    const format = query.get('format') === 'html' ? 'html' : 'json';
    const seekT = Number(query.get('t'));
    const hasSeek = query.has('t') && Number.isFinite(seekT) && seekT >= 0;
    // §3：sync=1 时间轴完全由父页面驱动（优先级高于 t）；§6：edit=1 注入编辑桥
    const syncMode = query.get('sync') === '1';
    const editMode = query.get('edit') === '1';
    const db = getDb();
    const group = getFinalEditWorkspace().load(groupId);
    const variant = group.variants.find((item) => item.id === variantId) || group.variants[0] || null;
    if (!variant) throw new FinalEditError('variant_not_found', '成片草稿不存在', 404);
    const templateDir = resolvePackagingTemplateDir(resolvePackagingDir(), template);

    const storageRoot = path.join(dataRoot(), 'storage');
    const project = loadProjectPackagingData(db, group.projectId);
    const projectRow = db.prepare(`SELECT name, productCode FROM projects WHERE id=?`).get(group.projectId) as { name: string | null; productCode: string | null } | undefined;
    const exportIdentity = { taskName: projectRow?.name || '', productCode: projectRow?.productCode || '' };

    // 底图与吸色：封面帧是导出前最接近成片的真实画面（预览近似；导出时吸成片中帧）
    const frameUrl = variant.cover.sourceUrl || '';
    let accents: string[] = [];
    // v4 四模板吸色注入（§11 同算法）：预览与成片共用 window.__palette，失败降级模板兜底色
    let palette: PackagingPalette | null = null;
    if (variant.cover.sourceKey) {
      try {
        const frame = await materializeCoverFrame({
          db,
          storageRoot,
          groupId,
          sourceKey: variant.cover.sourceKey,
          timeUs: variant.cover.frameTimeUs,
          preset: variant.outputPreset,
        });
        const frameAbs = path.join(storageRoot, frame.relativePath);
        accents = template === 'overlay-poster'
          ? await extractAccentColors(frameAbs, 0, { projectId: group.projectId })
          : [];
        palette = await extractPackagingPalette(frameAbs, resolveTemplateHueMode(templateDir));
      } catch { /* 预览降级：无底图/无吸色，模板回退默认配色 */ }
    }

    const defaults = buildPackagingVars({ coverTitle: { primary: group.coverTitle.primary.text, secondary: group.coverTitle.secondary.text }, subtitleCues: group.subtitleCues, exportIdentity, project, accents });
    const vars: PackagingVars = { ...defaults, ...group.packaging.varsOverrides };

    // v3 时序：对时卖点幂等提取（口播哈希不变则复用已存），totalSec 用组期望时长
    let pointCues: PointCue[] = group.packaging.pointCues ?? [];
    let pointCuesMode: 'timed' | 'even' | 'none' = group.packaging.pointCuesMode ?? 'none';
    let pointCuesKey: string | undefined = group.packaging.pointCuesKey;
    try {
      const ensured = await ensurePackagingPointCues(db, groupId);
      pointCues = ensured.pointCues;
      pointCuesMode = ensured.mode;
      // 用提取后的最新键做过期比对：刚重提取完的组不会误报 stale（§7 手动编辑保护组保留旧键 → stale）
      pointCuesKey = ensured.pointCuesKey;
    } catch { /* 提取失败沿用已存/空 */ }
    // §7：比对已存 pointCuesKey 与当前口播内容哈希（v2: 前缀口径，与 ensurePackagingPointCues 一致）
    const pointCuesStale = pointCuesKey !== computePointCuesKey(loadGroupNarrationText(db, groupId));
    const pointCuesEdited = group.packaging.pointCuesEdited === true;
    const layouts = group.packaging.layouts ?? {};
    const coverSec = FINAL_EDIT_INTRO_DURATION_US / 1e6;
    const totalSec = Math.max(group.totalDurationUs / 1e6, coverSec + 0.2);
    const timeline = { coverSec, totalSec, pointCues, pointCuesMode };

    if (format === 'json') return NextResponse.json({ vars, defaults, frameUrl, template, timeline, layouts, pointCuesStale, pointCuesEdited }, { headers: { 'Cache-Control': 'no-store' } });

    let html = fs.readFileSync(path.join(templateDir, 'index.html'), 'utf-8');
    // §7：layouts 随 vars 注入，模板端经 window.__vars.layouts 读取（与导出渲染同契约）
    const timelineVars = buildTimelineVars({ vars, totalSec, coverSec, pointCues, pointCuesMode, layouts });
    const varsJson = JSON.stringify(timelineVars).replace(/</g, '\\u003c');
    const baseHref = `/api/packaging/templates/${encodeURIComponent(template)}/`;
    // §10 ②：预览与成片一致——按当前配置三槽注入 @font-face（UserTitle/UserSubtitle/UserPoint；
    // 内容寻址文件名每次选择都变，配合 iframe 重载无缓存问题）
    const fontFaces = buildConfigFontFacesCss(group.packaging);
    // v4 吸色注入：与包装管线 §11 同色的 window.__palette（失败不注入，模板回退兜底色）
    const paletteScript = palette ? `<script>window.__palette=${JSON.stringify(palette)};</script>` : '';
    // 背景：独立预览（无 sync）用深色底+封面帧做底图；§3 叠加模式（sync=1）必须全透明——
    // 否则不透明 iframe 盖住底下正常播放的视频，用户看到「视频卡在第一帧、只有包装在动」
    // （2026-10-09 诊断实锤：视频全程正常，被封面背景图遮挡，性能排查三轮的幻影根源）
    const backgroundStyle = syncMode
      ? '<style>html,body{background:transparent !important;background-image:none !important}</style>'
      : `<style>html,body{background:#0b0b0d}body{background-image:url("${frameUrl}");background-size:cover;background-position:center;background-repeat:no-repeat}</style>`;
    const headEnd = [
      backgroundStyle,
      fontFaces,
      paletteScript,
      `<script>window.__hyperframes={getVariables:function(){return ${varsJson}}};</script>`,
    ].join('');
    // t 参数 → seek 到该时间点（暂停，供拖拽预览）；无 t → 自动循环播放；
    // §3：sync=1 完全不注入 autoplay/seek（时间轴由父页面经 __timelines['overlay'] 全权驱动，优先于 t）
    const autoPlay = syncMode
      ? ''
      : hasSeek
        ? `<script>setTimeout(function(){var t=window.__timelines&&window.__timelines.overlay;if(t){t.pause(0);t.seek(${seekT});}},80);</script>`
        : '<script>setTimeout(function(){var t=window.__timelines&&window.__timelines.overlay;if(t)t.play(0)},80);</script>';
    // §6：edit=1 注入预览画面内拖拽/缩放编辑桥（同源 iframe 内运行，幂等）
    const editBridge = editMode ? `<script>${PACKAGING_EDIT_BRIDGE_JS}</script>` : '';
    html = html
      .replace('<head>', `<head><base href="${baseHref}">`)
      .replace('</head>', `${headEnd}</head>`)
      .replace('</body>', `${autoPlay}${editBridge}</body>`);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (error) { return finalEditErrorResponse(error); }
}

// §6 编辑桥（edit=1 注入到 </body> 前）：同源 iframe 内运行的原生 JS，零依赖。
// 模板侧契约：可编辑元素带 data-point-id（cover:point1..3/title/subtitle / cue:<cueId>），
// 且暴露 window.__pointLayout = { apply(el, layout|null), list() }——layout = {x,y,scale,rotate}：
//   x,y = 元素可视中心占 #root 的百分比；scale = zoom 倍率；rotate = CSS rotate 角度；null = 恢复默认版式。
//   apply 自带中心锚定闭环（量中心→写内联 px 偏移→复测→按实测位移斜率精修），zoom/rotate/包含块/祖先缩放的几何全由模板端处理。
// 桥不再自己换算 style 偏移：手势只算目标 {x,y,scale,rotate}，经 rAF 节流（每帧最多一次）委托 apply 应用，提交时按最终可视状态回传。
// 父页面侧契约：设置 iframe contentWindow.__editMode = { active, only } 开关编辑；
// 注册 window.__packagingEditCommit(pointId, layout|null, {x,y,scale}) 接收结果；可选 __packagingEditExit() 接收 ESC 退出。
