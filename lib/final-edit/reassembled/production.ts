import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { parseProductionIdentityInput, buildProjectBaseName, formatShanghaiIdentityDate, resolveUniqueProjectBaseName } from '../../project-production-identity.ts';
import { projectFile, sha256 } from '../../film-render/files.ts';
import { probeMedia } from '../../film-render/media.ts';
import { FinalEditError } from '../errors.ts';
import { dataRoot } from '../../data-root.ts';
import type { FilmImportManifest } from './types.ts';
import type { ProductionBegin, ProductionItem, ProductionRegistry, ProductionSnapshot, ProductionSync, ProductionTask, ProductionView } from './production-types.ts';

const check = (value: unknown, message: string, status = 400) => { if (!value) throw new FinalEditError(status === 409 ? 'production_conflict' : 'production_invalid', message, status); };
const key = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const requestKey = (value: unknown) => key(value) && (value as string).length >= 8;
const text = (value: unknown, max = 20000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const same = (a: unknown, b: unknown, message: string) => check(isDeepStrictEqual(a, b), message, 409);
const parse = <T>(json: string): T => JSON.parse(json) as T;
const emptySnapshot = (): ProductionSnapshot => ({ files: {}, tasks: [], shots: [] });
const emptyRegistry = (): ProductionRegistry => ({ files: {}, images: {}, jobs: {}, videos: {}, sceneId: null });
function fields(value: unknown, allowed: string[]) { check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k)), '载荷含不支持的字段'); }

export function productionItem(db: Database.Database, id: string): ProductionItem {
  const item = db.prepare('SELECT * FROM final_edit_film_production_items WHERE id=?').get(id) as ProductionItem | undefined;
  if (!item) throw new FinalEditError('production_not_found', '制作片号不存在', 404);
  return item;
}
function owner(db: Database.Database, item: ProductionItem) {
  return db.prepare('SELECT * FROM final_edit_film_productions WHERE id=?').get(item.productionId) as { id: string; projectId: string; root: string };
}

/** Only rows this production owns; exclude queue/accounting timestamps and usage reconciliation fields. */
export function productionBaseline(db: Database.Database, item: ProductionItem, registry: ProductionRegistry): string {
  const rows = (table: string, columns: string, ids: string[]) => ids.sort().map(id => db.prepare(`SELECT ${columns} FROM ${table} WHERE id=?`).get(id) ?? null);
  return JSON.stringify({
    set: db.prepare('SELECT * FROM shot_sets WHERE id=?').get(item.shotSetId) ?? null,
    shots: db.prepare('SELECT * FROM shots WHERE shotSetId=? ORDER BY id').all(item.shotSetId),
    candidates: db.prepare('SELECT * FROM shot_result_candidates WHERE shotId IN (SELECT id FROM shots WHERE shotSetId=?) ORDER BY id').all(item.shotSetId),
    scene: registry.sceneId ? db.prepare('SELECT * FROM scene_references WHERE id=?').get(registry.sceneId) ?? null : null,
    images: rows('image_assets', 'id,projectId,role,path,processedPath,width,height', Object.values(registry.images).map(v => v.id)),
    jobs: rows('jobs', 'id,status,inputImageId,referenceImageIds,providerId,model,prompt,outputImageId,providerTaskId,reviewMark', Object.values(registry.jobs)),
    videos: rows('video_jobs', 'id,status,shotSetId,shotId,sourceImageId,providerId,model,prompt,durationSec,localVideoPath,providerTaskId,displayName', Object.values(registry.videos).map(v => v.id)),
    script: db.prepare('SELECT * FROM script_drafts WHERE id=?').get(item.draftId) ?? null,
    groups: db.prepare('SELECT id,revision FROM final_edit_groups WHERE shotSetId=? ORDER BY id').all(item.shotSetId),
  });
}
export function assertProductionUnchanged(db: Database.Database, item: ProductionItem) {
  same(productionBaseline(db, item, parse(item.registryJson)), item.baselineJson, '工作台内容已有人工作用，请保留当前修改并重新核对制作结果');
}

export function beginProduction(db: Database.Database, input: ProductionBegin): ProductionView {
  fields(input, ['requestId', 'root', 'projectId', 'project', 'films']);
  check(input && requestKey(input.requestId) && text(input.root) && path.isAbsolute(input.root), '需要稳定 requestId 和工程绝对路径');
  check(Array.isArray(input.films) && input.films.length > 0 && input.films.length <= 100, '每批须有 1–100 条成片');
  check(Boolean(input.projectId) !== Boolean(input.project), '已有项目 ID 和新建项目参数必须且只能提供一项');
  const root = fs.realpathSync(input.root); check(fs.statSync(root).isDirectory(), '工程根须为目录');
  for (const film of input.films) { fields(film, ['key', 'importKey', 'title', 'clips']); check(film && key(film.key) && text(film.importKey, 128) && text(film.title, 200) && Array.isArray(film.clips) && film.clips.length > 0 && film.clips.length <= 100 && film.clips.every(key) && new Set(film.clips).size === film.clips.length, '片号、标题、importKey 或镜头 ID 列表无效'); }
  check(new Set(input.films.map(f => f.key)).size === input.films.length && new Set(input.films.map(f => f.importKey)).size === input.films.length, '片号或 importKey 重复');
  return db.transaction(() => {
    const existing = db.prepare('SELECT id,requestJson FROM final_edit_film_productions WHERE requestId=?').get(input.requestId) as { id: string; requestJson: string } | undefined;
    if (existing) { same(parse(existing.requestJson), input, 'requestId 已用于另一批制作，不能重建'); return readProduction(db, existing.id); }
    let projectId = input.projectId;
    if (projectId) check(key(projectId) && db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId), '项目不存在');
    else {
      const p = input.project!;
      fields(p, ['storeCode', 'productCode', 'productSubmodel', 'productionType', 'editorName', 'providerId', 'model', 'scenePrompt', 'shotPrompt']);
      let identity;
      try { identity = parseProductionIdentityInput(p as unknown as Record<string, unknown>); }
      catch (error) { throw new FinalEditError('production_invalid', error instanceof Error ? error.message : String(error), 400); }
      check((p.scenePrompt === undefined || text(p.scenePrompt)) && (p.shotPrompt === undefined || text(p.shotPrompt)), '场景或分镜提示词无效');
      check(text(p.providerId, 200) && text(p.model, 200) && db.prepare('SELECT 1 FROM providers WHERE id=?').get(p.providerId), '图片供应商或模型不存在');
      const namingDate = formatShanghaiIdentityDate(new Date());
      const name = resolveUniqueProjectBaseName(db, buildProjectBaseName({ ...identity, namingDate }));
      projectId = randomUUID();
      // Creates only a project shell; provider availability is checked by the actual executor when submitting.
      db.prepare(`INSERT INTO projects (id,name,productCode,providerId,model,prompt,workflowType,scenePrompt,shotPrompt,storeCode,productSubmodel,productionType,editorName,namingDate) VALUES (?,?,?,?,?,'','complex_product',?,?,?,?,?,?,?)`).run(projectId, name, identity.productCode, p.providerId, p.model, p.scenePrompt || '', p.shotPrompt || '', identity.storeCode, identity.productSubmodel, identity.productionType, identity.editorName, namingDate);
    }
    const id = randomUUID(), now = new Date().toISOString();
    db.prepare('INSERT INTO final_edit_film_productions (id,requestId,requestJson,projectId,root,createdAt) VALUES (?,?,?,?,?,?)').run(id, input.requestId, JSON.stringify(input), projectId, root, now);
    for (const film of input.films) {
      check(!db.prepare('SELECT 1 FROM final_edit_film_bindings WHERE importKey=?').get(film.importKey) && !db.prepare('SELECT 1 FROM final_edit_film_production_items WHERE importKey=?').get(film.importKey), 'importKey 已有归属', 409);
      const itemId = randomUUID(), shotSetId = randomUUID();
      db.prepare('INSERT INTO shot_sets (id,projectId,name) VALUES (?,?,?)').run(shotSetId, projectId, film.title);
      db.prepare(`INSERT INTO final_edit_film_production_items (id,productionId,filmKey,importKey,title,shotSetId,groupId,variantId,draftId,shotIdsJson,snapshotJson,registryJson,baselineJson,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(itemId, id, film.key, film.importKey, film.title, shotSetId, randomUUID(), randomUUID(), randomUUID(), JSON.stringify(Object.fromEntries(film.clips.map(clip => [clip, randomUUID()]))), JSON.stringify(emptySnapshot()), JSON.stringify(emptyRegistry()), '', now);
      const item = productionItem(db, itemId);
      db.prepare('UPDATE final_edit_film_production_items SET baselineJson=? WHERE id=?').run(productionBaseline(db, item, emptyRegistry()), itemId);
    }
    return readProduction(db, id);
  }).immediate();
}

export function readProduction(db: Database.Database, id: string): ProductionView {
  const production = db.prepare('SELECT id,projectId,root FROM final_edit_film_productions WHERE id=?').get(id) as Omit<ProductionView, 'films'> | undefined;
  if (!production) throw new FinalEditError('production_not_found', '制作批次不存在', 404);
  const items = db.prepare('SELECT * FROM final_edit_film_production_items WHERE productionId=? ORDER BY rowid').all(id) as ProductionItem[];
  return { ...production, films: items.map(item => {
    const registry = parse<ProductionRegistry>(item.registryJson), snapshot = parse<ProductionSnapshot>(item.snapshotJson);
    const mediaUrl = (kind: string, file: string) => `/api/${kind}/${path.relative(path.join(dataRoot(), 'storage'), file).split(path.sep).map(encodeURIComponent).join('/')}`;
    return { id: item.id, key: item.filmKey, importKey: item.importKey, title: item.title, shotSetId: item.shotSetId, groupId: item.groupId, variantId: item.variantId, revision: item.revision, bindingId: item.bindingId, conflict: !item.bindingId && productionBaseline(db, item, registry) !== item.baselineJson, snapshot,
      images: Object.fromEntries(Object.keys(registry.images).map(file => [file, mediaUrl('images', registry.files[file])])),
      videos: Object.fromEntries(Object.keys(registry.videos).map(task => [task, mediaUrl('videos', registry.files[snapshot.tasks.find(t => t.id === task)!.outputFile!])])) };
  }) };
}

// Openings and closing shots may intentionally use the selected scene directly.
// Keep its actual generation receipt instead of requiring a fictional per-shot job.
function imageSourceTask(snapshot: ProductionSnapshot, file: string, clipId: string) {
  return snapshot.tasks.find(task => task.status === 'succeeded' && task.outputFile === file &&
    ((task.kind === 'shot' && task.clipId === clipId) || (task.kind === 'scene' && file === snapshot.sceneImage)));
}

function validateSnapshot(db: Database.Database, item: ProductionItem, next: ProductionSnapshot) {
  fields(next, ['files', 'tasks', 'sceneImage', 'shots', 'script']);
  const previous = parse<ProductionSnapshot>(item.snapshotJson), clips = parse<Record<string, string>>(item.shotIdsJson);
  check(next && next.files && typeof next.files === 'object' && !Array.isArray(next.files) && Object.keys(next.files).length <= 1000 && Array.isArray(next.tasks) && next.tasks.length <= 1000 && Array.isArray(next.shots) && next.shots.length <= Object.keys(clips).length, '制作快照格式无效');
  const file = (name: unknown) => typeof name === 'string' && !path.isAbsolute(name) && !path.win32.isAbsolute(name) && !name.includes('\\') && name.split('/').every(p => p && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(p)) && /^[a-f0-9]{64}$/.test(next.files[name] || '');
  for (const name of Object.keys(next.files)) check(file(name), '文件须使用工程内规范相对路径和 SHA256');
  for (const [name, hash] of Object.entries(previous.files)) same(next.files[name], hash, '已同步文件不可更换或删除，新结果使用新文件名');
  check(next.tasks.every(t => t && typeof t === 'object' && !Array.isArray(t)) && next.shots.every(s => s && typeof s === 'object' && !Array.isArray(s)), '任务和镜头须为对象');
  check(new Set(next.tasks.map(t => t.id)).size === next.tasks.length && new Set(next.shots.map(s => s.id)).size === next.shots.length, '任务或镜头 ID 重复');
  for (const task of next.tasks) {
    fields(task, ['id', 'kind', 'clipId', 'status', 'providerId', 'model', 'prompt', 'inputFiles', 'remoteTaskId', 'outputFile']);
    check(task && key(task.id) && ['scene', 'shot', 'video', 'script'].includes(task.kind) && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(task.status) && text(task.providerId, 200) && text(task.model, 200) && text(task.prompt) && Array.isArray(task.inputFiles) && task.inputFiles.length <= 30 && task.inputFiles.every(file), '任务身份、输入或来源无效');
    check(task.remoteTaskId == null || text(task.remoteTaskId, 1000), '远端 ID 只能为真实字符串或空');
    if (task.kind === 'shot' || task.kind === 'video') check(task.clipId && Object.hasOwn(clips, task.clipId), '任务不属于本条镜头');
    else check(!task.clipId, '场景和脚本任务不关联单镜头');
    if (task.status === 'succeeded' && task.kind !== 'script') check(file(task.outputFile) && task.inputFiles.length > 0, '成功任务缺少产物或实际输入');
    else check(!task.outputFile, '未成功任务或脚本任务不能声明媒体产物');
    if (task.kind !== 'script') check(db.prepare(`SELECT 1 FROM ${task.kind === 'video' ? 'video_providers' : 'providers'} WHERE id=?`).get(task.providerId), '任务供应商不存在');
  }
  const outputs = next.tasks.filter(t => t.status === 'succeeded' && t.kind !== 'script').map(t => t.outputFile);
  check(new Set(outputs).size === outputs.length, '不同生成任务须使用不同产物文件');
  for (const old of previous.tasks) {
    const current = next.tasks.find(t => t.id === old.id); check(current, '已记录任务不能消失', 409);
    if (['succeeded', 'failed', 'cancelled'].includes(old.status)) same(current, old, '终态任务不可改写，返工使用新任务 ID');
    else {
      const { status: _oldStatus, remoteTaskId: oldRemote, outputFile: _oldOutput, ...oldIdentity } = old;
      const { status: _newStatus, remoteTaskId: newRemote, outputFile: _newOutput, ...newIdentity } = current!;
      void _oldStatus; void _oldOutput; void _newStatus; void _newOutput;
      same(oldIdentity, newIdentity, '进行中任务的输入、提示词或归属不能改变');
      if (oldRemote) same(newRemote, oldRemote, '远端任务 ID 不能改变');
      check(old.status !== 'running' || current!.status !== 'queued', '进行中任务不能回退为未提交', 409);
    }
  }
  const resultTask = (name: string, kind: ProductionTask['kind'], clipId?: string) => next.tasks.find(t => t.status === 'succeeded' && t.outputFile === name && t.kind === kind && t.clipId === clipId);
  if (next.sceneImage) check(resultTask(next.sceneImage, 'scene'), '入选场景须有成功生成来源');
  for (const shot of next.shots) {
    fields(shot, ['id', 'sourceImage', 'generatedImage', 'selectedCandidateId', 'candidates']);
    check(Object.hasOwn(clips, shot.id) && file(shot.sourceImage) && Array.isArray(shot.candidates) && shot.candidates.length <= 50, '镜头输入或候选列表无效');
    check(shot.candidates.every(c => c && typeof c === 'object' && !Array.isArray(c)), '候选须为对象');
    if (shot.generatedImage) check(imageSourceTask(next, shot.generatedImage, shot.id), '分镜图须属于本镜头成功任务或本条已选场景');
    check(new Set(shot.candidates.map(c => c.id)).size === shot.candidates.length, '候选 ID 重复');
    for (const c of shot.candidates) {
      fields(c, ['id', 'file', 'sourceImage', 'generatedImage', 'providerId', 'model', 'prompt', 'providerTaskId', 'provenance', 'approvedRangeSec']);
      fields(c.provenance, ['imageProvider', 'imageModel', 'imagePrompt', 'imageTaskId']);
      const task = next.tasks.find(t => t.id === c.id && t.kind === 'video' && t.clipId === shot.id && t.status === 'succeeded');
      const image = imageSourceTask(next, c.generatedImage, shot.id);
      check(task && task.outputFile === c.file && task.inputFiles[0] === c.generatedImage && file(c.sourceImage) && image && image.inputFiles[0] === c.sourceImage, '候选必须对应实际视频任务与分镜输入');
      check(c.providerId === task!.providerId && c.model === task!.model && c.prompt === task!.prompt && (c.providerTaskId || null) === (task!.remoteTaskId || null), '视频候选来源与台账不一致');
      check(c.provenance && c.provenance.imageProvider === image!.providerId && c.provenance.imageModel === image!.model && c.provenance.imagePrompt === image!.prompt && (!c.provenance.imageTaskId || c.provenance.imageTaskId === image!.id), '图片候选来源与台账不一致');
      check(Array.isArray(c.approvedRangeSec) && c.approvedRangeSec.length === 2 && c.approvedRangeSec.every(Number.isFinite) && c.approvedRangeSec[0] >= 0 && c.approvedRangeSec[1] > c.approvedRangeSec[0], '候选审核区间无效');
    }
    if (shot.selectedCandidateId) { const c = shot.candidates.find(c => c.id === shot.selectedCandidateId); check(c && c.sourceImage === shot.sourceImage && c.generatedImage === shot.generatedImage, '入选候选必须对应当前镜头图片'); }
  }
  for (const old of previous.shots) {
    const current = next.shots.find(s => s.id === old.id); check(current, '已同步镜头不能删除', 409);
    for (const candidate of old.candidates) same(current!.candidates.find(c => c.id === candidate.id), candidate, '已登记候选不能改写或删除');
  }
  if (next.script) { fields(next.script, ['taskId', 'narration']); check(text(next.script.narration) && next.tasks.some(t => t.id === next.script!.taskId && t.kind === 'script' && t.status === 'succeeded'), '脚本须有成功来源和正文'); }
  if (previous.script) { check(next.script, '已同步脚本不能删除', 409); if (next.script!.taskId === previous.script.taskId) same(next.script, previous.script, '终态脚本不可改写，新脚本使用新任务 ID'); }
}

export async function syncProduction(db: Database.Database, storageRoot: string, itemId: string, input: ProductionSync) {
  fields(input, ['requestId', 'expectedRevision', 'snapshot']);
  input = structuredClone(input);
  check(input && requestKey(input.requestId) && Number.isSafeInteger(input.expectedRevision), '同步需要稳定 requestId 和整数 expectedRevision');
  const replay = () => {
    const old = db.prepare('SELECT itemId,requestJson,resultJson FROM final_edit_film_production_syncs WHERE requestId=?').get(input.requestId) as { itemId: string; requestJson: string; resultJson: string } | undefined;
    if (!old) return null;
    same(old.itemId, itemId, '同步请求已用于另一条成片'); same(parse(old.requestJson), input, '同步请求 ID 已用于不同内容'); return parse<{ revision: number; itemId: string }>(old.resultJson);
  };
  const repeated = replay(); if (repeated) return repeated;
  const item = productionItem(db, itemId), production = owner(db, item);
  check(!item.bindingId && item.revision === input.expectedRevision, '制作已接管或版本已变化，请读取当前状态', 409);
  assertProductionUnchanged(db, item); validateSnapshot(db, item, input.snapshot);
  const next = input.snapshot, registry = parse<ProductionRegistry>(item.registryJson), clips = parse<Record<string, string>>(item.shotIdsJson);
  const parent = path.join(storageRoot, 'outputs', 'reassembled-productions', item.id); fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, 'sync-')); let committed = false;
  try {
    for (const [name, hash] of Object.entries(next.files)) {
      const source = projectFile(production.root, name); check(sha256(source) === hash, `制作输入已改变：${name}`);
      if (registry.files[name]) { check(sha256(registry.files[name]) === hash, `工作台素材已改变：${name}`, 409); continue; }
      const target = path.join(work, randomUUID() + path.extname(name)); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); check(sha256(target) === hash, `复制期间文件变化：${name}`); registry.files[name] = target;
    }
    const imageNames = new Set(next.shots.map(s => s.sourceImage));
    for (const task of next.tasks.filter(t => t.status === 'succeeded' && t.kind !== 'script')) {
      task.inputFiles.forEach(name => imageNames.add(name)); if (task.kind !== 'video') imageNames.add(task.outputFile!);
    }
    for (const name of imageNames) if (!registry.images[name]) {
      const meta = await sharp(fs.readFileSync(registry.files[name])).metadata(); check(meta.width && meta.height && ['png', 'jpeg', 'webp'].includes(meta.format || ''), '图片格式无效');
      registry.images[name] = { id: randomUUID(), width: meta.width!, height: meta.height!, mime: `image/${meta.format}` };
    }
    for (const task of next.tasks.filter(t => t.kind === 'video' && t.status === 'succeeded')) if (!registry.videos[task.id]) {
      check(next.shots.some(s => s.id === task.clipId), '先登记对应镜头原图，再同步视频');
      const media = await probeMedia(registry.files[task.outputFile!], work);
      check(media.streams.some(s => s.codec_type === 'video' && (s.width || 0) > 0 && (s.height || 0) > 0), '视频结果必须包含有效画面流');
      const durationSec = Number(media.format.duration); check(Number.isFinite(durationSec) && durationSec > 0, '视频时长无效'); registry.videos[task.id] = { id: randomUUID(), durationSec };
    }
    for (const shot of next.shots) for (const c of shot.candidates) check(registry.videos[c.id].durationSec >= c.approvedRangeSec[1], '候选审核区间超出实际时长');
    const result = db.transaction(() => {
      const repeated = replay(); if (repeated) return repeated;
      const current = productionItem(db, item.id); check(!current.bindingId && current.revision === input.expectedRevision, '复制期间制作版本已变化', 409); assertProductionUnchanged(db, current);
      for (const [name, hash] of Object.entries(next.files)) check(sha256(registry.files[name]) === hash, '提交前受管文件已改变', 409);
      const oldRegistry = parse<ProductionRegistry>(current.registryJson), now = new Date().toISOString();
      for (const [name, image] of Object.entries(registry.images)) if (!oldRegistry.images[name]) {
        const output = next.tasks.find(t => t.outputFile === name && t.status === 'succeeded');
        db.prepare('INSERT INTO image_assets (id,projectId,role,filename,path,mimeType,width,height,usage) VALUES (?,?,?,?,?,?,?,?,?)').run(image.id, production.projectId, output ? 'output' : 'input', path.basename(name), registry.files[name], image.mime, image.width, image.height, output?.kind === 'scene' ? 'scene_gen' : output ? 'shot_gen' : '');
      }
      for (const task of next.tasks.filter(t => (t.kind === 'scene' || t.kind === 'shot') && t.status === 'succeeded')) if (!registry.jobs[task.id]) {
        const id = randomUUID(); registry.jobs[task.id] = id;
        db.prepare(`INSERT INTO jobs (id,projectId,inputImageId,referenceImageIds,providerId,model,prompt,status,outputImageId,providerTaskId,createdAt,finishedAt) VALUES (?,?,?,?,?,?,?,'succeeded',?,?,?,?)`).run(id, production.projectId, registry.images[task.inputFiles[0]].id, JSON.stringify(task.inputFiles.slice(1).map(name => registry.images[name].id)), task.providerId, task.model, task.prompt, registry.images[task.outputFile!].id, task.remoteTaskId || null, now, now);
      }
      if (next.sceneImage) {
        const task = next.tasks.find(t => t.outputFile === next.sceneImage && t.kind === 'scene' && t.status === 'succeeded')!;
        registry.sceneId ??= randomUUID();
        db.prepare(`INSERT INTO scene_references (id,projectId,imageAssetId,sourceJobId,name) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET imageAssetId=excluded.imageAssetId,sourceJobId=excluded.sourceJobId`).run(registry.sceneId, production.projectId, registry.images[next.sceneImage].id, registry.jobs[task.id], item.title);
      }
      for (const shot of next.shots) {
        const imageTask = shot.generatedImage ? imageSourceTask(next, shot.generatedImage, shot.id) : undefined;
        db.prepare(`INSERT INTO shots (id,shotSetId,indexNum,sourceImageId,latestGeneratedImageId,latestJobId) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sourceImageId=excluded.sourceImageId,latestGeneratedImageId=excluded.latestGeneratedImageId,latestJobId=excluded.latestJobId`).run(clips[shot.id], item.shotSetId, Object.keys(clips).indexOf(shot.id) + 1, registry.images[shot.sourceImage].id, shot.generatedImage ? registry.images[shot.generatedImage].id : null, imageTask ? registry.jobs[imageTask.id] : null);
        for (const task of next.tasks.filter(t => t.kind === 'shot' && t.status === 'succeeded' && t.clipId === shot.id)) db.prepare('INSERT OR IGNORE INTO shot_result_candidates (id,shotId,jobId,imageAssetId) VALUES (?,?,?,?)').run(randomUUID(), clips[shot.id], registry.jobs[task.id], registry.images[task.outputFile!].id);
        if (imageTask?.kind === 'scene') db.prepare('INSERT OR IGNORE INTO shot_result_candidates (id,shotId,jobId,imageAssetId) VALUES (?,?,?,?)').run(randomUUID(), clips[shot.id], registry.jobs[imageTask.id], registry.images[imageTask.outputFile!].id);
      }
      for (const task of next.tasks.filter(t => t.kind === 'video' && t.status === 'succeeded')) if (!oldRegistry.videos[task.id]) {
        const video = registry.videos[task.id];
        db.prepare(`INSERT INTO video_jobs (id,projectId,shotSetId,shotId,sourceImageId,providerId,model,prompt,durationSec,status,providerTaskId,localVideoPath,filename,displayName,finishedAt) VALUES (?,?,?,?,?,?,?,?,?,'succeeded',?,?,?,?,?)`).run(video.id, production.projectId, item.shotSetId, clips[task.clipId!], registry.images[task.inputFiles[0]].id, task.providerId, task.model, task.prompt, video.durationSec, task.remoteTaskId || null, registry.files[task.outputFile!], path.basename(task.outputFile!), `${task.clipId} · ${task.id}`, now);
      }
      if (next.script) {
        const task = next.tasks.find(t => t.id === next.script!.taskId)!;
        db.prepare(`INSERT INTO script_drafts (id,projectId,provider,model,inputSnapshot,outputJson) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,inputSnapshot=excluded.inputSnapshot,outputJson=excluded.outputJson`).run(item.draftId, production.projectId, task.providerId, task.model, JSON.stringify(task), JSON.stringify({ version: 2, shotSetId: item.shotSetId, title: item.title, fullScript: next.script.narration, segments: [] }));
      }
      db.prepare('UPDATE shot_sets SET sceneReferenceId=?,status=? WHERE id=?').run(registry.sceneId, Object.keys(registry.videos).length ? 'video_ready' : next.shots.some(s => s.generatedImage) ? 'reviewing' : 'draft', item.shotSetId);
      const result = { itemId: item.id, revision: item.revision + 1 };
      db.prepare('UPDATE final_edit_film_production_items SET revision=?,snapshotJson=?,registryJson=?,baselineJson=?,updatedAt=? WHERE id=?').run(result.revision, JSON.stringify(next), JSON.stringify(registry), productionBaseline(db, item, registry), now, item.id);
      db.prepare('INSERT INTO final_edit_film_production_syncs (requestId,itemId,requestJson,resultJson,createdAt) VALUES (?,?,?,?,?)').run(input.requestId, item.id, JSON.stringify(input), JSON.stringify(result), now);
      committed = true; return result;
    }).immediate();
    return result;
  } finally {
    if (!committed && path.dirname(work) === parent && path.basename(work).startsWith('sync-') && !fs.lstatSync(work).isSymbolicLink()) fs.rmSync(work, { recursive: true });
  }
}

/** Freeze/recheck production identity at both ends of import's asynchronous media validation. */
export function productionForImport(db: Database.Database, manifest: FilmImportManifest) {
  if (!manifest.production) {
    check(!db.prepare('SELECT 1 FROM final_edit_film_production_items WHERE importKey=?').get(manifest.importKey), '该 importKey 已从制作开始登记，请携带制作片号身份和版本', 409);
    return null;
  }
  const item = productionItem(db, manifest.production.itemId), production = owner(db, item);
  check(!item.bindingId && item.revision === manifest.production.expectedRevision && production.projectId === manifest.projectId && item.importKey === manifest.importKey && production.root === fs.realpathSync(manifest.root), '制作身份或版本不匹配', 409);
  assertProductionUnchanged(db, item);
  const snapshot = parse<ProductionSnapshot>(item.snapshotJson), registry = parse<ProductionRegistry>(item.registryJson);
  same(manifest.sceneImage, snapshot.sceneImage, '场景与已同步内容不一致');
  same(manifest.shots, snapshot.shots.map(({ id, selectedCandidateId, candidates }) => ({ id, selectedCandidateId, candidates })), '镜头或候选与已同步内容不一致');
  check(snapshot.script, '请先同步脚本');
  for (const [file, hash] of Object.entries(snapshot.files)) { same(manifest.files[file], hash, '最终清单缺少已同步文件或指纹变化'); check(sha256(registry.files[file]) === hash, '受管素材已改变', 409); }
  return { item, registry, snapshot };
}
