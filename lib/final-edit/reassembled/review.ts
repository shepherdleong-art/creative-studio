import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { desktopFilmIdentity } from './access.ts';
import { verifyDeliveryDirectory } from './delivery.ts';
import type { FilmBinding } from './types.ts';
import { FinalEditError } from '../errors.ts';
import { reviewLaunchUrl } from './launch-link.ts';
import { dataRoot } from '../../data-root.ts';
import { assertNoStorageSymlink } from '../../media-core/storage-path.ts';
import { sha256 } from '../../film-render/files.ts';
import { createHash } from 'node:crypto';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function latestMixcutMedia(db: Database.Database, binding: FilmBinding) {
  const jobs = db.prepare(`SELECT id,kind,inputSnapshotJson,outputJson FROM final_edit_jobs WHERE groupId=? AND status='succeeded' AND kind IN ('render','packaging') ORDER BY createdAt DESC,id DESC`).all(binding.groupId) as Array<{ id: string; kind: string; inputSnapshotJson: string; outputJson: string }>;
  for (const job of jobs) {
    const output = JSON.parse(job.outputJson || '{}');
    if (output.packagingDeferred || !output.publishedVideoRelativePath) continue;
    const parent = job.kind === 'packaging' ? jobs.find(row => row.id === output.sourceRenderJobId) : job;
    if (!parent) continue;
    const snapshot = JSON.parse(parent.inputSnapshotJson);
    if (snapshot.variant?.timeline?.importedFilmEditor !== 'mixcut') continue;
    const rendered = JSON.parse(parent.outputJson || '{}');
    if (!rendered.publishedCoverRelativePath) continue;
    return { video: String(output.publishedVideoRelativePath), cover: String(rendered.publishedCoverRelativePath), revision: Number(snapshot.variantRevision) };
  }
  return null;
}

function copyReviewMedia(binding: FilmBinding, relativePath: string): string {
  const source = assertNoStorageSymlink(path.join(dataRoot(), 'storage'), relativePath);
  const name = path.basename(source);
  const target = path.join(binding.deliveryDir, name);
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink() || sha256(target) !== sha256(source)) throw new FinalEditError('film_delivery_conflict', `审片文件已存在且内容不同：${name}`, 409);
  } else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  return name;
}

function reviewCard(db: Database.Database, id: string, localFile = false): string {
  const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(id) as FilmBinding | undefined;
  if (!binding) throw new FinalEditError('film_not_found', '成片不存在', 404);
  const identity = (() => {
    try { return desktopFilmIdentity(); }
    catch { return { origin: '', instanceId: '', dataIdentity: createHash('sha256').update(fs.realpathSync(dataRoot())).digest('hex') }; }
  })();
  const delivery = db.prepare(`SELECT videoFilename,coverFilename,archiveWarning FROM final_edit_film_deliveries WHERE bindingId=? AND version=? AND status='published'`).get(id, binding.deliveryVersion) as { videoFilename: string; coverFilename: string; archiveWarning: string | null };
  const link = identity.origin
    ? `${identity.origin}/api/reassembled-films/${id}/open?${new URLSearchParams({ instance: identity.instanceId, data: identity.dataIdentity, version: String(binding.deliveryVersion), token: binding.reviewToken })}`
    : `/projects/${binding.projectId}?tab=final-edit&filmGroup=${binding.groupId}&filmShotSet=${binding.shotSetId}`;
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
  const native = latestMixcutMedia(db, binding);
  if (native) {
    video = localFile ? encodeURIComponent(path.basename(native.video)) : `/api/videos/${native.video.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
    cover = localFile ? encodeURIComponent(path.basename(native.cover)) : `/api/final-edit-groups/${binding.groupId}/review-cover`;
  }
  const navigation = launch
    ? `<a href="${escape(launch)}">在工作台编辑</a>`
    : localFile && !identity.origin ? '<span>打开工作台，在对应分组中编辑</span>'
    : `<a href="${escape(link)}" target="_blank" rel="noopener">在工作台编辑</a>`;
  return `<article id="film-${escape(binding.id)}"><h2>${escape(binding.baseName)}</h2><p data-delivery-version="${binding.deliveryVersion}">${native ? `精剪版本 ${native.revision}` : `交付 v${binding.deliveryVersion}`}${variant.revision !== (native?.revision ?? binding.deliveredRevision) ? ' · 工作台有未导出的修改' : ''}</p><video controls playsinline preload="none" src="${escape(video)}" poster="${escape(cover)}"></video><nav>${navigation}</nav><p>${escape(delivery.archiveWarning || '')}</p></article>`;

}
function reviewBindings(db: Database.Database, id: string): FilmBinding[] {
  const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(id) as FilmBinding | undefined;
  if (!binding) throw new FinalEditError('film_not_found', '成片不存在', 404);
  return db.prepare('SELECT * FROM final_edit_film_bindings WHERE projectId=? AND deliveryDir=? ORDER BY createdAt,baseName,id').all(binding.projectId, binding.deliveryDir) as FilmBinding[];
}

export function reviewHtml(db: Database.Database, id: string, localFile = false): string {
  const bindings = reviewBindings(db, id);
  const project = db.prepare('SELECT name FROM projects WHERE id=?').get(bindings[0].projectId) as { name: string };
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="creative-studio-review" content="${escape(bindings[0].projectId)}"><title>${escape(project.name)} · 审片</title><style>
body{font:16px system-ui;margin:40px auto;padding:0 24px;max-width:1120px;background:#f5f5f7;color:#1d1d1f}h1{font-size:28px}h2{font-size:18px;overflow-wrap:anywhere}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:28px}article{min-width:0}video{display:block;width:100%;aspect-ratio:3/4;max-height:72vh;background:#111;object-fit:contain;border-radius:12px}nav{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}a{color:#0071e3;text-decoration:none}p{line-height:1.6;color:#6e6e73}
</style></head><body><h1>${escape(project.name)}</h1><p>成片审片 · ${bindings.length} 条 · 在工作台对应分组中继续精剪</p><main>${bindings.map(binding => reviewCard(db, binding.id, localFile)).join('')}</main><script>document.addEventListener('play',function(event){if(event.target.tagName==='VIDEO')document.querySelectorAll('video').forEach(function(video){if(video!==event.target)video.pause()})},true)</script></body></html>`;
}

export function refreshFilmReview(db: Database.Database, id: string, initialize = false): string {
  const bindings = reviewBindings(db, id);
  for (const binding of bindings) verifyDeliveryDirectory(binding, initialize);
  const binding = bindings[0];
  for (const item of bindings) {
    const native = latestMixcutMedia(db, item);
    if (native) { copyReviewMedia(item, native.video); copyReviewMedia(item, native.cover); }
  }
  const filename = `成片审片-${binding.projectId.slice(0, 8)}.html`;
  const destination = path.join(binding.deliveryDir, filename);
  const marker = `<meta name="creative-studio-review" content="${escape(binding.projectId)}">`;
  if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || !fs.readFileSync(destination, 'utf8').includes(marker))) {
    throw new FinalEditError('film_review_conflict', '同名审片页不属于当前项目，已保留原文件', 409);
  }
  const temporary = path.join(binding.deliveryDir, '.creative-studio', binding.id, 'review.tmp');
  fs.writeFileSync(temporary, reviewHtml(db, id, true));
  fs.renameSync(temporary, destination);
  // Retire only exact legacy pages owned by these bindings; user HTML stays untouched.
  for (const item of bindings) {
    const legacy = path.join(item.deliveryDir, `${item.baseName}-工作台审片-${item.id.slice(0, 8)}.html`);
    const archive = path.join(item.deliveryDir, '.creative-studio', item.id, 'legacy-review.html');
    if (fs.existsSync(legacy) && !fs.lstatSync(legacy).isSymbolicLink() && !fs.existsSync(archive)) fs.renameSync(legacy, archive);
  }
  return destination;
}

export function refreshMixcutReview(db: Database.Database, groupId: string | null): void {
  if (!groupId) return;
  const binding = db.prepare('SELECT id FROM final_edit_film_bindings WHERE groupId=?').get(groupId) as { id: string } | undefined;
  if (!binding) return;
  try { refreshFilmReview(db, binding.id); }
  catch {
    // A disconnected delivery drive must not discard a successful standard export.
    db.prepare(`UPDATE final_edit_jobs SET outputJson=json_set(outputJson,'$.reviewWarning',?) WHERE id=(SELECT id FROM final_edit_jobs WHERE groupId=? AND status='succeeded' ORDER BY createdAt DESC LIMIT 1)`)
      .run('成片已导出，汇总审片页未更新；请恢复交付目录后重新生成审片页。', groupId);
  }
}

export function latestMixcutReviewCover(db: Database.Database, groupId: string): string | null {
  const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE groupId=?').get(groupId) as FilmBinding | undefined;
  return binding ? latestMixcutMedia(db, binding)?.cover ?? null : null;
}
