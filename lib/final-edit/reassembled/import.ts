import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { parseRenderSpec } from '../../film-render/spec.ts';
import { inputHashes, templateHashes } from '../../film-render/manifest.ts';
import { sha256, projectFile } from '../../film-render/files.ts';
import { probeMedia } from '../../film-render/media.ts';
import { verifyFilm } from '../../film-render/verify.ts';
import { isClassicSpec } from '../../film-render/types.ts';
import { FinalEditError } from '../errors.ts';
import { registerSingleArtifact } from '../project-artifacts.ts';
import { filmTimeline, projectFilmTimeline } from './timeline.ts';
import type { FilmImportManifest, FilmBinding, RegisteredCandidate } from './types.ts';
import { productionForImport } from './production.ts';
import { filmFolderName } from './folder-name.ts';

const check = (ok: unknown, message: string) => { if (!ok) throw new FinalEditError('film_import_invalid', message, 400); };
const text = (s: unknown, name: string) => { check(typeof s === 'string' && s.trim().length > 0 && s.length < 10000, `${name} 不能为空或过长`); return s as string; };
const jsonHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;

export async function importFilm(db: Database.Database, storageRoot: string, raw: unknown): Promise<FilmBinding> {
  const manifest = raw as FilmImportManifest;
  check(manifest && manifest.schemaVersion === 1, '只支持导入清单 v1');
  text(manifest.importKey, 'importKey'); text(manifest.projectId, 'projectId'); text(manifest.title, 'title');
  check(path.isAbsolute(text(manifest.root, 'root')), '工程根必须是绝对路径');
  const root = fs.realpathSync(manifest.root);
  check(db.prepare('SELECT 1 FROM projects WHERE id=?').get(manifest.projectId), '请先在工作台建立本次项目');
  check(manifest.files && Object.keys(manifest.files).length > 0 && Object.keys(manifest.files).length < 1000, '文件清单无效');
  const files = new Map<string, string>();
  for (const [name, hash] of Object.entries(manifest.files)) {
    check(!path.isAbsolute(name) && !path.win32.isAbsolute(name) && !name.includes('\\') && !name.split('/').some(s => s === '..' || s === '.' || s === '.workbench'), '文件必须使用工程内的规范相对路径');
    check(/^[a-f0-9]{64}$/.test(hash), `缺少文件哈希: ${name}`);
    const file = projectFile(root, name);
    check(sha256(file) === hash, `文件已变化: ${name}`);
    files.set(name, file);
  }
  const required = (name: string) => { check(files.has(name), `文件未列入核验清单: ${name}`); return files.get(name)!; };
  const spec = parseRenderSpec(JSON.parse(fs.readFileSync(required(manifest.specFile), 'utf8')));
  check(fs.realpathSync(spec.project.root) === root, '渲染单不属于本次工程');
  const render = JSON.parse(fs.readFileSync(required(manifest.renderManifestFile), 'utf8'));
  check(render.schemaVersion === 1 && render.ok === true && render.checks?.ok === true && render.specSha256 === sha256(required(manifest.specFile)), '已有成片缺少有效渲染记录');
  check(JSON.stringify(stable(render.template)) === JSON.stringify(stable(templateHashes(spec))), '原包装版本与当前固定渲染模板不一致');
  const input = inputHashes(spec);
  // Windows fixed-render records use native separators. Verify the original
  // record unchanged, then use canonical manifest paths in the managed copy.
  const canonical = (name: string) => name.split(path.sep).join('/');
  for (const [name, hash] of Object.entries(input)) check(manifest.files[canonical(name)] === hash && render.inputs?.[name] === hash, `渲染输入或出处已变化: ${name}`);
  for (const shot of spec.shots) shot.file = canonical(shot.file);
  for (const voice of spec.audio.voices) voice.file = canonical(voice.file);
  spec.audio.music.file = canonical(spec.audio.music.file);
  if (isClassicSpec(spec)) {
    spec.classic.projectCss = canonical(spec.classic.projectCss);
    spec.classic.designDoc = canonical(spec.classic.designDoc);
    spec.classic.cover.image = canonical(spec.classic.cover.image);
  } else spec.cover.image = canonical(spec.cover.image);
  const videoSource = projectFile(root, path.relative(root, render.outputs.video));
  const coverSource = projectFile(root, path.relative(root, render.outputs.cover));
  required(path.relative(root, videoSource).split(path.sep).join('/')); required(path.relative(root, coverSource).split(path.sep).join('/'));
  check(sha256(videoSource) === render.outputs.videoSha256 && sha256(coverSource) === render.outputs.coverSha256, '已有成片或封面哈希不符');
  check(manifest.delivery && path.isAbsolute(text(manifest.delivery.directory, '交付目录')), '交付目录必须是绝对路径');
  const deliveryDir = fs.realpathSync(manifest.delivery.directory);
  const baseName = text(manifest.delivery.baseName, '交付文件名');
  check(baseName === spec.project.baseName, '交付基础名必须与原始渲染单一致');
  const importHash = jsonHash(stable(manifest));
  const existing = db.prepare('SELECT * FROM final_edit_film_bindings WHERE importKey=?').get(manifest.importKey) as FilmBinding | undefined;
  if (existing) {
    check(existing.importHash === importHash && existing.projectId === manifest.projectId, '同一导入身份已有不同内容；请通过修订流程修改，不能覆盖人工编辑');
    return existing;
  }
  for (const [name, hash] of [[`${baseName}.mp4`, render.outputs.videoSha256], [`${baseName}-封面.jpg`, render.outputs.coverSha256]]) {
    check(sha256(projectFile(deliveryDir, name)) === hash, `原交付文件不存在或已变化: ${name}`);
  }
  required(manifest.sceneImage);
  check(manifest.sceneProvenance && typeof manifest.sceneProvenance === 'object', '缺少场景生成出处');
  check(Array.isArray(manifest.shots) && manifest.shots.length === spec.shots.length, '每条镜头须登记原图、生成图及候选视频');
  const candidateIds = new Set<string>();
  for (const shot of manifest.shots) {
    check(spec.shots.some(s => s.id === shot.id), '镜头 ID 不属于渲染单');
    check(Array.isArray(shot.candidates) && shot.candidates.length > 0 && shot.candidates.length <= 50, '候选数量无效');
    check(new Set(shot.candidates.map(c => c.file)).size === shot.candidates.length, '同一镜头的候选文件不能重复');
    for (const c of shot.candidates) {
      text(c.id, '候选 ID'); check(!candidateIds.has(c.id), '候选 ID 重复'); candidateIds.add(c.id);
      required(c.file); required(c.sourceImage); required(c.generatedImage);
      text(c.model, '视频模型'); text(c.prompt, '视频提示词');
      check(db.prepare('SELECT 1 FROM video_providers WHERE id=?').get(c.providerId), '候选须关联真实的已配置视频供应商');
      check(c.provenance && typeof c.provenance === 'object', '缺少分镜生成出处');
      text(c.provenance.imageProvider, '图片供应商'); text(c.provenance.imageModel, '图片模型'); text(c.provenance.imagePrompt, '图片提示词');
      check(c.providerTaskId == null || typeof c.providerTaskId === 'string', '远端任务 ID 只能填写真实字符串或留空');
      check(Array.isArray(c.approvedRangeSec) && c.approvedRangeSec.length === 2 && c.approvedRangeSec.every(Number.isFinite) && c.approvedRangeSec[0] >= 0 && c.approvedRangeSec[1] > c.approvedRangeSec[0], '缺少候选已审核源片区间');
    }
    const selected = shot.candidates.find(c => c.id === shot.selectedCandidateId);
    check(selected && selected.file === spec.shots.find(s => s.id === shot.id)?.file, '入选候选与渲染单不一致');
  }
  check(new Set(manifest.shots.map(s => s.id)).size === manifest.shots.length, '镜头 ID 重复');
  check(!db.prepare('SELECT 1 FROM final_edit_film_bindings WHERE deliveryDir=? AND baseName=?').get(deliveryDir, baseName), '该交付文件已归属另一条成片');
  const production = productionForImport(db, manifest);
  const id = randomUUID(), groupId = production?.item.groupId || randomUUID(), variantId = production?.item.variantId || randomUUID(), shotSetId = production?.item.shotSetId || randomUUID(), draftId = production?.item.draftId || randomUUID();
  const relative = `reassembled/${filmFolderName(baseName, id)}/project`;
  const managed = path.join(storageRoot, relative);
  fs.mkdirSync(managed, { recursive: true });
  let committed = false;
  try {
    for (const [name, file] of files) {
      const target = path.join(managed, name); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      check(sha256(target) === manifest.files[name], `复制期间文件发生变化: ${name}`);
    }
    const scratch = path.join(managed, '.workbench/import-check');
    spec.project.root = managed;
    const verified = await verifyFilm({ spec, video: videoSource, cover: coverSource, workDir: scratch });
    check(verified.ok, '已有成片未通过本地技术复核');
    const candidates: RegisteredCandidate[] = [];
    const shotIds = new Map<string, string>(production ? Object.entries(JSON.parse(production.item.shotIdsJson)) as Array<[string, string]> : manifest.shots.map(s => [s.id, randomUUID()]));
    for (const shot of manifest.shots) for (const c of shot.candidates) {
      const media = await probeMedia(path.join(managed, c.file), scratch);
      const durationSec = Number(media.format.duration);
      check(Number.isFinite(durationSec) && durationSec >= c.approvedRangeSec[1], '候选审核区间超出视频实际时长');
      candidates.push({ videoJobId: production?.registry.videos[c.id]?.id || randomUUID(), clipId: shot.id, shotId: shotIds.get(shot.id)!, file: c.file,
        fingerprint: manifest.files[c.file], durationSec, approvedRangeSec: c.approvedRangeSec });
    }
    const timeline = filmTimeline(spec, candidates);
    projectFilmTimeline(spec, timeline, candidates);
    const imageNames = new Set([manifest.sceneImage, isClassicSpec(spec) ? spec.classic.cover.image : spec.cover.image,
      ...manifest.shots.flatMap(s => s.candidates.flatMap(c => [c.sourceImage, c.generatedImage]))]);
    const images = new Map<string, { id: string; width: number; height: number; mime: string }>();
    for (const name of imageNames) {
      const meta = await sharp(required(name)).metadata();
      check(meta.width && meta.height && ['png', 'jpeg', 'webp'].includes(meta.format || ''), '素材图片无效');
      images.set(name, { id: production?.registry.images[name]?.id || randomUUID(), width: meta.width!, height: meta.height!, mime: `image/${meta.format}` });
    }
    const createdAt = new Date().toISOString(), reviewToken = randomBytes(32).toString('hex');
    const sceneId = production?.registry.sceneId || randomUUID();
    const narration = spec.subtitles.map(s => s.text).join('\n');
    if (production) check(production.snapshot.script?.narration.trim() === narration.trim(), '最终字幕口播与已同步脚本不一致，请先同步实际使用的脚本');
    const script = { version: 2, source: 'module3', sourceDraftId: draftId, sourceScriptUpdatedAt: createdAt,
      sourceScriptVersion: 2, title: manifest.title, targetDurationSec: spec.canvas.frames / 24, shotSetId,
      sourceNarrationText: narration, sourceSegments: [], editedNarrationText: narration, scriptSyncState: 'synced',
      fullScript: narration, segments: spec.subtitles.map((s, i) => ({ id: `line-${i}`, shotId: '', narration: s.text, subtitle: s.text })) };
    const coverImage = images.get(isClassicSpec(spec) ? spec.classic.cover.image : spec.cover.image)!;
    const previewRelative = path.relative(storageRoot, path.join(managed, path.relative(root, videoSource))).split(path.sep).join('/');
    db.transaction(() => {
      if (production) productionForImport(db, manifest);
      for (const [name, image] of images) if (!production?.registry.images[name]) db.prepare(`INSERT INTO image_assets (id,projectId,role,filename,path,mimeType,width,height) VALUES (?,?,?,?,?,?,?,?)`).run(image.id, manifest.projectId,
        manifest.shots.some(s => s.candidates.some(c => c.sourceImage === name)) ? 'input' : 'output', path.basename(name), path.join(managed, name), image.mime, image.width, image.height);
      if (!production) {
        db.prepare(`INSERT INTO scene_references (id,projectId,imageAssetId,name) VALUES (?,?,?,?)`).run(sceneId, manifest.projectId, images.get(manifest.sceneImage)!.id, manifest.title);
        db.prepare(`INSERT INTO shot_sets (id,projectId,name,sceneReferenceId,status) VALUES (?,?,?,?,'video_ready')`).run(shotSetId, manifest.projectId, manifest.title, sceneId);
      }
      let index = 0;
      for (const shot of manifest.shots) {
        const selected = shot.candidates.find(c => c.id === shot.selectedCandidateId)!;
        if (!production) db.prepare(`INSERT INTO shots (id,shotSetId,indexNum,sourceImageId,latestGeneratedImageId) VALUES (?,?,?,?,?)`).run(shotIds.get(shot.id), shotSetId, ++index, images.get(selected.sourceImage)!.id, images.get(selected.generatedImage)!.id);
        for (const [i, c] of shot.candidates.entries()) {
          const registered = candidates.filter(item => item.clipId === shot.id)[i];
          if (!production) db.prepare(`INSERT INTO video_jobs (id,projectId,shotSetId,shotId,sourceImageId,providerId,model,prompt,durationSec,status,providerTaskId,localVideoPath,filename,displayName,finishedAt) VALUES (?,?,?,?,?,?,?,?,?,'succeeded',?,?,?,?,?)`).run(registered.videoJobId, manifest.projectId, shotSetId, registered.shotId, images.get(c.generatedImage)!.id, c.providerId, c.model, c.prompt, registered.durationSec, c.providerTaskId || null, path.join(managed, c.file), path.basename(c.file), `${shot.id} 候选 ${i + 1}`, createdAt);
          db.prepare(`INSERT OR IGNORE INTO final_edit_asset_analysis (videoJobId,shotSetId,fileFingerprint,providerId,model,analyzerVersion,status,mediaJson,generatedJson,updatedAt) VALUES (?,?,?,'','','import-metadata/1','succeeded',?,'{}',?)`).run(registered.videoJobId, shotSetId, registered.fingerprint, JSON.stringify({ durationUs: Math.round(registered.durationSec * 1e6) }), createdAt);
        }
      }
      if (!production) db.prepare(`INSERT INTO script_drafts (id,projectId,provider,model,inputSnapshot,outputJson) VALUES (?,?,'external-import','external-import',?,?)`).run(draftId, manifest.projectId, JSON.stringify({ importKey: manifest.importKey }), JSON.stringify({ version: 2, shotSetId, title: manifest.title, segments: script.segments, fullScript: narration, targetDurationSec: script.targetDurationSec }));
      db.prepare(`INSERT INTO final_edit_groups (id,projectId,scriptDraftId,shotSetId,scriptSnapshotJson,narrationHash,narrationConfigJson,narrationDurationUs,subtitleStateJson,coverTitleJson,textStylesJson,status,phase,editedNarrationText,selectedMaterialKeysJson,createdAt,updatedAt) VALUES (?,?,?,?,?,?,'{}',?,?,'{}','{}','ready','ready',?,?,?,?)`).run(groupId, manifest.projectId, draftId, shotSetId, JSON.stringify(script), importHash,
        Math.round((spec.canvas.frames - 20) / 24 * 1e6), JSON.stringify(spec.subtitles.map((s, i) => ({ id: `line-${i}`, segmentId: `line-${i}`, text: s.text, startUs: Math.round((s.startFrame - 20) / 24 * 1e6), endUs: Math.round((s.endFrame - 20) / 24 * 1e6), textSource: 'manual', timingSource: 'manual' }))), narration, JSON.stringify(candidates.map(c => `module4:${c.videoJobId}`)), createdAt, createdAt);
      const cover = { coverKey: `image:${coverImage.id}`, kind: 'storyboard_image', sourceUrl: null, framing: { scale: 1, offsetX: 0, offsetY: 0 } };
      db.prepare(`INSERT INTO final_edit_variants (id,groupId,indexNum,outputPreset,timelineJson,bgmJson,coverJson,revision,lastRenderedRevision,previewRelativePath,createdAt,updatedAt) VALUES (?,?,1,'3x4',?,'{}',?,0,0,?,?,?)`).run(variantId, groupId, JSON.stringify(timeline), JSON.stringify(cover), previewRelative, createdAt, createdAt);
      db.prepare(`INSERT INTO final_edit_revisions (scopeKind,scopeId,revision,stateJson,commandJson,createdAt) VALUES ('variant',?,0,?,'{"type":"import_film"}',?)`).run(variantId, JSON.stringify({ timeline, bgm: {}, cover, issues: [] }), createdAt);
      db.prepare(`INSERT INTO final_edit_film_bindings (id,importKey,importHash,projectId,shotSetId,groupId,variantId,specJson,candidatesJson,manifestJson,inputHashesJson,managedRootRelative,deliveryDir,baseName,reviewToken,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, manifest.importKey, importHash, manifest.projectId, shotSetId, groupId, variantId, JSON.stringify(spec), JSON.stringify(candidates), JSON.stringify({ ...manifest, initialFiles: { video: path.relative(root, videoSource).split(path.sep).join('/'), cover: path.relative(root, coverSource).split(path.sep).join('/') } }), JSON.stringify(Object.fromEntries([...files].map(([name]) => [name, manifest.files[name]]))), relative, deliveryDir, baseName, reviewToken, createdAt);
      db.prepare(`INSERT INTO final_edit_film_deliveries (bindingId,version,jobId,variantRevision,status,videoFilename,coverFilename,videoSha256,coverSha256) VALUES (?,1,?,0,'published',?,?,?,?)`).run(id, `import:${id}`, `${baseName}.mp4`, `${baseName}-封面.jpg`, render.outputs.videoSha256, render.outputs.coverSha256);
      for (const [kind, filename, relativePath, mimeType] of [
        ['final_video', `${baseName}.mp4`, previewRelative, 'video/mp4'],
        ['final_cover', `${baseName}-封面.jpg`, path.relative(storageRoot, path.join(managed, path.relative(root, coverSource))).split(path.sep).join('/'), 'image/jpeg'],
      ]) registerSingleArtifact(db, { id: `film-import:${id}:${kind}`, projectId: manifest.projectId, kind, displayName: filename, relativePath, mimeType, sourceJobId: `import:${id}`, createdAt });
      if (production) db.prepare('UPDATE final_edit_film_production_items SET bindingId=?,revision=revision+1,updatedAt=? WHERE id=?').run(id, createdAt, production.item.id);
    })();
    committed = true;
    return db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(id) as FilmBinding;
  } catch (error) {
    const winner = db.prepare('SELECT * FROM final_edit_film_bindings WHERE importKey=?').get(manifest.importKey) as FilmBinding | undefined;
    if (!committed && winner?.importHash === importHash) return winner;
    throw error;
  } finally {
    if (!committed) fs.rmSync(path.dirname(managed), { recursive: true, force: true });
  }
}
