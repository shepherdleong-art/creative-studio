import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { dataRoot } from '../../data-root.ts';
import { runFfmpeg } from '../../ffmpeg.ts';
import { assertNoStorageSymlink } from '../../media-core/storage-path.ts';
import { speechContent } from '../../media-core/adapters/alignment.ts';
import { BatchDomainError } from '../errors.ts';
import { assertFormulaBatch, getFormulaCollection } from './collection-store.ts';
import { readFormulaSettings } from './settings-store.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import { assertFormulaNarrationAudio, inspectFormulaNarrationAudio, type FormulaNarrationAudio } from './narration.ts';

export interface FormulaExternalNarration {
  id: string; scriptKey: string; scriptsSessionId: string; revision: number; baseInputRevision: number;
  inputHash: string; createdAt: string; formatVersion: 1; origin: 'external';
  text: string; filename: string | null; srt: string | null; audio: FormulaNarrationAudio | null;
}
export interface FormulaExternalNarrationView {
  inputRevision: number; scriptsSessionId: string | null; editable: boolean;
  items: Array<{ scriptKey: string; scriptNumber: string; text: string; stale: boolean; saved: FormulaExternalNarration | null }>;
}
export type FormulaExternalNarrationPublicView = Omit<FormulaExternalNarrationView, 'items'> & {
  items: Array<Omit<FormulaExternalNarrationView['items'][number], 'saved'> & { saved: null | {
    id: string; revision: number; filename: string | null; text: string; srt: string | null;
    durationUs: number | null; channels: number | null;
  } }>;
};
export function publicFormulaExternalNarrations(view: FormulaExternalNarrationView): FormulaExternalNarrationPublicView {
  return { ...view, items: view.items.map(item => ({ ...item, saved: item.saved ? {
    id: item.saved.id, revision: item.saved.revision, filename: item.saved.filename, text: item.saved.text, srt: item.saved.srt,
    durationUs: item.saved.audio?.durationUs ?? null, channels: item.saved.audio?.channels ?? null,
  } : null })) };
}
export interface FormulaExternalNarrationInput {
  scriptKey: string; scriptsSessionId: string; expectedInputRevision: number; expectedNarrationRevision: number;
  confirmed: boolean; filename?: string; bytes?: Buffer; srt?: string; remove?: boolean; signal?: AbortSignal;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const invalid = (message: string): never => { throw new BatchDomainError('invalid_input', message); };

/** SRT cues remain complete cues; no guessed per-character timing. */
function parseSrt(srt: string, text: string) {
  if (Buffer.byteLength(srt, 'utf8') > 256 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(srt)) invalid('SRT 过长或含无效字符');
  const blocks = srt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n/);
  if (!blocks.length || blocks.length > 1000) invalid('SRT 须包含 1–1,000 条字幕');
  let end = 0;
  const words = blocks.map((block, index) => {
    const lines = block.split('\n');
    const match = /^(\d{2}):([0-5]\d):([0-5]\d),(\d{3}) --> (\d{2}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(lines[1]?.trim() ?? '');
    if (lines[0]?.trim() !== String(index + 1) || !match) return invalid('SRT 序号须从 1 连续递增，时间格式须为 00:00:00,000 --> 00:00:00,000');
    const time = (at: number) => (Number(match[at]) * 3600 + Number(match[at + 1]) * 60 + Number(match[at + 2])) * 1_000_000 + Number(match[at + 3]) * 1000;
    const startUs = time(1), endUs = time(5), cue = lines.slice(2).join('\n').trim();
    if (!speechContent(cue) || /<[^>]*>/.test(cue) || startUs < end || endUs <= startUs) invalid('SRT 文字不能为空或含格式标签，时间须按先后排列且不能重叠');
    end = endUs;
    return { text: cue, startUs, endUs };
  });
  if (text.length > 20_000 || !speechContent(text) || speechContent(words.map(word => word.text).join('')) !== speechContent(text)) {
    invalid('SRT 文字与当前脚本文案不一致，请先核对实际配音和要朗读的文案');
  }
  return words;
}

export function readFormulaExternalNarrations(db: Database.Database, projectId: string, batchId: string): FormulaExternalNarrationView {
  const settings = readFormulaSettings(db, projectId, batchId), collection = getFormulaCollection(db, projectId, batchId);
  const rows = collection && settings.scriptsSessionId ? db.prepare(`SELECT n.* FROM live_mixcut_formula_external_narrations n
    WHERE n.collectionId=? AND n.scriptsSessionId=? AND NOT EXISTS (SELECT 1 FROM live_mixcut_formula_external_narrations x
      WHERE x.collectionId=n.collectionId AND x.scriptsSessionId=n.scriptsSessionId AND x.scriptKey=n.scriptKey AND x.revision>n.revision)`)
    .all(collection.id, settings.scriptsSessionId) as Array<Omit<FormulaExternalNarration, 'formatVersion' | 'origin' | 'text' | 'filename' | 'srt' | 'audio'> & { contentJson: string }> : [];
  return { inputRevision: settings.inputRevision, scriptsSessionId: settings.scriptsSessionId, editable: settings.editable,
    items: settings.scripts.map(script => {
      const row = rows.find(row => row.scriptKey === script.key);
      const saved: FormulaExternalNarration | null = row ? { id: row.id, scriptKey: row.scriptKey, scriptsSessionId: row.scriptsSessionId,
        revision: row.revision, baseInputRevision: row.baseInputRevision, inputHash: row.inputHash, createdAt: row.createdAt, ...JSON.parse(row.contentJson) } : null;
      return { scriptKey: script.key, scriptNumber: script.scriptNumber, text: script.bodyText,
        stale: !!saved?.audio && saved.text !== script.bodyText, saved };
    }) };
}

/** Import and confirmation are one versioned input change. Old outputs retain their frozen audio. */
export async function saveFormulaExternalNarration(db: Database.Database, projectId: string, batchId: string,
  input: FormulaExternalNarrationInput): Promise<FormulaExternalNarrationView> {
  if (!input.scriptKey || !input.scriptsSessionId || !Number.isSafeInteger(input.expectedInputRevision) || input.expectedInputRevision < 0
    || !Number.isSafeInteger(input.expectedNarrationRevision) || input.expectedNarrationRevision < 0 || input.confirmed !== true) {
    invalid('请试听配音并确认字幕内容和时间，再提交有效的脚本版本');
  }
  if (input.remove !== undefined && typeof input.remove !== 'boolean') invalid('外部配音操作无效');
  if (!input.remove) {
    if (!Buffer.isBuffer(input.bytes)) invalid('没有收到音频文件，请重新选择');
    if (!input.bytes!.length || input.bytes!.length > 60 * 1024 * 1024) invalid('音频为空或超过 60 MiB，请选择有效文件');
    if (typeof input.filename !== 'string' || !/\.(wav|mp3|m4a|aac|flac)$/i.test(input.filename)) invalid('音频文件扩展名须为 WAV、MP3、M4A、AAC 或 FLAC');
    if (typeof input.srt !== 'string') invalid('没有收到 UTF-8 SRT，请同时选择字幕文件');
  }
  const filename = input.remove ? null : path.basename(input.filename!.replace(/\\/g, '/')).slice(0, 240);
  const inputHash = hash(JSON.stringify({ filename, audioHash: input.remove ? null : hash(input.bytes!), srt: input.remove ? null : input.srt }));
  const readExpected = () => {
    input.signal?.throwIfAborted();
    assertFormulaBatch(db, projectId, batchId);
    if (!formulaExecutionAvailable(db)) throw new BatchDomainError('conflict', '实拍公式功能当前不可用');
    const view = readFormulaExternalNarrations(db, projectId, batchId), item = view.items.find(item => item.scriptKey === input.scriptKey);
    if (!item || view.scriptsSessionId !== input.scriptsSessionId) throw new BatchDomainError('conflict', '脚本已变化，请重新读取');
    const saved = item.saved;
    const replay = saved?.revision === input.expectedNarrationRevision + 1 && saved.baseInputRevision === input.expectedInputRevision
      && saved.inputHash === inputHash && saved.text === item.text;
    if (!replay) {
      assertFormulaBatch(db, projectId, batchId, true);
      if (view.inputRevision !== input.expectedInputRevision || (saved?.revision ?? 0) !== input.expectedNarrationRevision) {
        throw new BatchDomainError('conflict', '资料或外部配音已更新，请重新读取后核对');
      }
    }
    return { view, item, replay };
  };
  const before = readExpected();
  if (before.replay) return before.view;
  const words = input.remove ? [] : parseSrt(input.srt!, before.item.text);
  const id = randomUUID(), directory = `live-mixcut/narration/${hash(projectId)}/external/${id}`;
  const storage = path.join(dataRoot(), 'storage');
  const sourcePath = assertNoStorageSymlink(storage, `${directory}/input${path.extname(filename ?? '.wav')}`);
  const relativePath = `${directory}/narration.wav`, audioPath = assertNoStorageSymlink(storage, relativePath);
  let committed = false;
  try {
    let audio: FormulaNarrationAudio | null = null;
    if (!input.remove) {
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, input.bytes!, { flag: 'wx' });
      try {
        const format = path.extname(filename!).slice(1).toLowerCase();
        await runFfmpeg(['-nostdin', '-protocol_whitelist', 'file,pipe', '-f', format === 'm4a' ? 'mov' : format, '-i', sourcePath, '-map', '0:a:0', '-vn', '-t', '601',
          '-ar', '48000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-y', audioPath], { timeoutMs: 120_000, signal: input.signal });
        audio = { relativePath, ...inspectFormulaNarrationAudio(relativePath), words, timingSource: 'manual', externalNarrationId: id };
      } catch {
        input.signal?.throwIfAborted();
        invalid('无法读取音频：须有声音、单声道或立体声，时长不超过 10 分钟');
      }
      if (words.some(word => word.endUs > audio!.durationUs)) invalid('SRT 时间超出实际音频，请重新核对');
      assertFormulaNarrationAudio(projectId, before.item.text, audio!);
    }
    const result = db.transaction(() => {
      const current = readExpected();
      if (current.replay) return current.view;
      if (current.item.text !== before.item.text) throw new BatchDomainError('conflict', '核验期间脚本文案已更新');
      if (audio) assertFormulaNarrationAudio(projectId, current.item.text, audio);
      const now = new Date().toISOString(), collection = getFormulaCollection(db, projectId, batchId)!;
      db.prepare(`INSERT INTO live_mixcut_formula_external_narrations
        (id,collectionId,scriptsSessionId,scriptKey,revision,baseInputRevision,inputHash,contentJson,createdAt) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, collection.id, input.scriptsSessionId, input.scriptKey, input.expectedNarrationRevision + 1, input.expectedInputRevision, inputHash,
          JSON.stringify({ formatVersion: 1, origin: 'external', text: current.item.text, filename, srt: input.remove ? null : input.srt, audio }), now);
      db.prepare('UPDATE live_mixcut_formula_collections SET revision=revision+1,updatedAt=? WHERE id=?').run(now, collection.id);
      return readFormulaExternalNarrations(db, projectId, batchId);
    }).immediate();
    committed = result.items.some(item => item.saved?.id === id);
    return result;
  } finally {
    fs.rmSync(sourcePath, { force: true });
    if (!committed) fs.rmSync(audioPath, { force: true });
  }
}
