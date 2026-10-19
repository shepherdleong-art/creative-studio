import fs from 'node:fs';
import path from 'node:path';
import { buildTimelineVars, resolvePackagingDir, resolvePackagingTemplateDir } from './packaging-runtime.ts';
import { buildConfigFontFacesCss } from './packaging-font.ts';
import type { FinalEditPackagingConfig, PackagingVars } from './packaging-vars.ts';
import { PACKAGING_EDIT_BRIDGE_JS } from './packaging-edit-bridge.ts';
import type { PackagingPalette } from './packaging-palette.ts';

/** Shared transparent preview. The parent owns time; editor messages are checked against the iframe source. */
export function packagingPreviewHtml(input: {
  config: FinalEditPackagingConfig; vars: PackagingVars; totalSec: number; coverSec: number;
  palette?: PackagingPalette | null; edit?: boolean;
}): string {
  const dir = resolvePackagingTemplateDir(resolvePackagingDir(), input.config.template);
  const vars = buildTimelineVars({ vars: input.vars, totalSec: input.totalSec, coverSec: input.coverSec,
    pointCues: input.config.pointCues ?? [], pointCuesMode: input.config.pointCuesMode ?? 'none', layouts: input.config.layouts });
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
  let bridge = PACKAGING_EDIT_BRIDGE_JS
    // srcDoc 的 location.origin 为 "null"，但继承父页源；明确以同源父页为消息目标。
    .replace("p.__packagingEditCommit(pointId, payload, payload);", "p.postMessage({type:'packaging:layout',id:pointId,layout:payload},p.location.origin);")
    .replace("p && typeof p.__packagingEditCommit === 'function'", 'p')
    .replace("p.__packagingEditText(pid, { left: r.left, top: r.top, width: r.width, height: r.height });", "p.postMessage({type:'packaging:text',id:pid,rect:{left:r.left,top:r.top,width:r.width,height:r.height}},p.location.origin);")
    .replace("p && typeof p.__packagingEditText === 'function'", 'p');
  if (!input.edit) bridge = '';
  const head = `<base href="/api/packaging/templates/${input.config.template}/"><style>html,body{background:transparent!important;background-image:none!important}</style>${buildConfigFontFacesCss(input.config)}<script>window.__hyperframes={getVariables:()=>(${json(vars)})};${input.palette ? `window.__palette=${json(input.palette)};` : ''}</script>`;
  return fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace('<head>', `<head>${head}`).replace('</body>', `<script>${bridge}</script></body>`);
}
