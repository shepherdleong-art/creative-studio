import { MANUAL_SCRIPT_BATCH_MAX, MANUAL_SCRIPT_PASTE_CHARS_MAX } from './manual-script-import.ts';

export const MANUAL_SCRIPT_FILE_BYTES_MAX = 64 * 1024;

interface ScriptFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UploadedScriptDraft {
  filename: string;
  title: string;
  bodyText: string;
}

/** 一份文件对应一份脚本；正文空行保留，不按段落拆成多条口播。 */
export async function readManualScriptFiles(files: ScriptFile[]): Promise<UploadedScriptDraft[]> {
  if (files.length === 0 || files.length > MANUAL_SCRIPT_BATCH_MAX) {
    throw new Error(`请选择 1–${MANUAL_SCRIPT_BATCH_MAX} 个脚本文件`);
  }
  for (const file of files) {
    if (!/\.(txt|md)$/i.test(file.name)) throw new Error(`${file.name}：仅支持 TXT 或 Markdown 文件`);
    if (file.size > MANUAL_SCRIPT_FILE_BYTES_MAX) throw new Error(`${file.name}：文件不能超过 64 KB`);
  }
  const drafts: UploadedScriptDraft[] = [];
  let totalChars = 0;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text: string;
    try {
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // 兼容 Windows 记事本旧版保存的 GBK/GB18030 中文文案。
      try { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
      catch { throw new Error(`${file.name}：无法读取文字，请另存为 UTF-8 文本后重试`); }
    }
    if (/[\u0000-\u0008\u000e-\u001f\ufffd]/u.test(text)) {
      throw new Error(`${file.name}：包含无法识别的字符，请上传纯文本脚本`);
    }
    const bodyText = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!bodyText) throw new Error(`${file.name}：脚本文件为空`);
    const title = file.name.replace(/\.(txt|md)$/i, '').trim();
    totalChars += Array.from(title).length + Array.from(bodyText).length;
    if (totalChars > MANUAL_SCRIPT_PASTE_CHARS_MAX) {
      throw new Error(`单次导入的总字符数不能超过 ${MANUAL_SCRIPT_PASTE_CHARS_MAX}`);
    }
    drafts.push({ filename: file.name, title, bodyText });
  }
  return drafts;
}
