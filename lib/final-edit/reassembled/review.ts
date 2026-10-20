import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { desktopFilmIdentity } from './access.ts';
import { verifyDeliveryDirectory } from './delivery.ts';
import type { FilmBinding } from './types.ts';
import { FinalEditError } from '../errors.ts';
import { reviewLaunchUrl } from './launch-link.ts';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function reviewHtml(db: Database.Database, id: string, localFile = false): string {
  const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(id) as FilmBinding | undefined;
  if (!binding) throw new FinalEditError('film_not_found', '成片不存在', 404);
  const identity = desktopFilmIdentity();
  const delivery = db.prepare(`SELECT videoFilename,coverFilename,archiveWarning FROM final_edit_film_deliveries WHERE bindingId=? AND version=? AND status='published'`).get(id, binding.deliveryVersion) as { videoFilename: string; coverFilename: string; archiveWarning: string | null };
  const link = `${identity.origin}/api/reassembled-films/${id}/open?${new URLSearchParams({ instance: identity.instanceId, data: identity.dataIdentity, version: String(binding.deliveryVersion), token: binding.reviewToken })}`;
  const launch = reviewLaunchUrl(binding, identity.dataIdentity);
  // In the served review, use an immutable internal render path; the local HTML
  // uses its adjacent delivery files. Both carry an explicit delivered revision.
  let video = encodeURIComponent(delivery.videoFilename), cover = encodeURIComponent(delivery.coverFilename);
  if (!localFile) {
    const job = db.prepare('SELECT outputJson FROM final_edit_jobs WHERE id=(SELECT jobId FROM final_edit_film_deliveries WHERE bindingId=? AND version=?)').get(id, binding.deliveryVersion) as { outputJson: string | null } | undefined;
    const outputs = job?.outputJson ? JSON.parse(job.outputJson) : null;
    if (outputs) {
      video = `/api/videos/${outputs.videoRelativePath.split('/').map(encodeURIComponent).join('/')}`;
    } else {
      const manifest = JSON.parse(binding.manifestJson);
      const source = (file: string) => `/api/videos/${[binding.managedRootRelative, file].join('/').split('/').map(encodeURIComponent).join('/')}`;
      video = source(manifest.initialFiles.video);
    }
    cover = `/api/reassembled-films/${id}/cover?version=${binding.deliveryVersion}`;
  }
  const variant = db.prepare('SELECT revision FROM final_edit_variants WHERE id=?').get(binding.variantId) as { revision: number };
  const navigation = launch
    ? `<a href="${escape(launch)}">在工作台编辑这条成片</a> <a href="${escape(link)}" target="_blank" rel="noopener">打开当前运行的桌面</a>`
    : `<a href="${escape(link)}" target="_blank" rel="noopener">在工作台编辑这条成片</a>`;
  const help = launch ? '编辑入口可启动本机桌面并定位这条成片；浏览器可能要求确认打开应用。移动应用或数据目录后，请重新连接并更新本页。' : '本页尚未配置桌面启动。请先打开工作台并更新审片页连接；桌面重启后，旧连接需要刷新。';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(binding.baseName)} · 审片</title><style>body{font:16px system-ui;max-width:850px;margin:40px auto;padding:0 24px;background:#f5f5f7;color:#1d1d1f}video{display:block;max-height:65vh;max-width:100%;margin:20px auto}a{display:inline-block;padding:12px 20px;border-radius:10px;background:#0071e3;color:white;text-decoration:none}p{line-height:1.6}</style><h1>${escape(binding.baseName)}</h1><p data-delivery-version="${binding.deliveryVersion}">交付版本 v${binding.deliveryVersion} · 对应编辑版本 ${binding.deliveredRevision}</p><p>${localFile ? '下方为已交付版本；最新编辑状态以工作台为准。' : variant.revision !== binding.deliveredRevision ? `工作台还有未交付修改（编辑版本 ${variant.revision}），下方播放的是已交付版本。` : '当前编辑与交付版本一致。'}</p><video controls preload="metadata" src="${escape(video)}" poster="${escape(cover)}"></video>${navigation}<p>${escape(delivery.archiveWarning || '')}</p><p>${help}</p></html>`;
}
export function refreshFilmReview(db: Database.Database, id: string, initialize = false): string {
  const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(id) as FilmBinding;
  verifyDeliveryDirectory(binding, initialize);
  const filename = `${binding.baseName}-工作台审片-${binding.id.slice(0, 8)}.html`;
  const destination = path.join(binding.deliveryDir, filename);
  const temporary = path.join(path.dirname(path.join(binding.deliveryDir, '.creative-studio', binding.id, 'identity.json')), 'review.tmp');
  fs.writeFileSync(temporary, reviewHtml(db, id, true));
  // This exact review filename is owned by the binding, never a user-supplied path.
  fs.renameSync(temporary, destination);
  return destination;
}
