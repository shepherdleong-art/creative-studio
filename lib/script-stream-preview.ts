export interface StreamPreviewText {
  text: string;
  done: boolean;
}

export interface StreamPreviewSegment {
  narration: StreamPreviewText;
  subtitle: StreamPreviewText | null;
}

export interface ScriptStreamPreviewResult {
  title: StreamPreviewText | null;
  coverTitleParts: {
    primary: StreamPreviewText | null;
    secondary: StreamPreviewText | null;
  } | null;
  segments: StreamPreviewSegment[];
}

function skipWhitespace(buf: string, start: number): number {
  let cursor = start;
  while (cursor < buf.length && /\s/u.test(buf[cursor])) cursor += 1;
  return cursor;
}

/** 查找 JSON 对象键，返回冒号后的位置；找不到返回 -1。 */
function findKey(buf: string, key: string, from: number): number {
  let cursor = from;
  while (cursor < buf.length) {
    const hit = buf.indexOf(`"${key}"`, cursor);
    if (hit < 0) return -1;
    const after = skipWhitespace(buf, hit + key.length + 2);
    if (buf[after] === ':') return skipWhitespace(buf, after + 1);
    cursor = hit + 1;
  }
  return -1;
}

function findStringField(buf: string, key: string, from: number): number {
  const keyEnd = findKey(buf, key, from);
  return keyEnd >= 0 && buf[keyEnd] === '"' ? keyEnd + 1 : -1;
}

function readJsonString(buf: string, start: number): StreamPreviewText {
  let out = '';
  let cursor = start;
  while (cursor < buf.length) {
    const char = buf[cursor];
    if (char === '\\') {
      if (cursor + 1 >= buf.length) return { text: out, done: false };
      const escaped = buf[cursor + 1];
      if (escaped === 'u') {
        if (cursor + 6 > buf.length) return { text: out, done: false };
        const hex = buf.slice(cursor + 2, cursor + 6);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) return { text: out, done: false };
        out += String.fromCharCode(Number.parseInt(hex, 16));
        cursor += 6;
        continue;
      }
      if (escaped === 'n') out += '\n';
      else if (escaped === 't') out += '\t';
      else if (escaped === 'r') out += '\r';
      else if (escaped === 'b') out += '\b';
      else if (escaped === 'f') out += '\f';
      else out += escaped;
      cursor += 2;
      continue;
    }
    if (char === '"') return { text: out, done: true };
    out += char;
    cursor += 1;
  }
  return { text: out, done: false };
}

export function parseScriptStreamPreview(streamedContent: string): ScriptStreamPreviewResult {
  const buf = streamedContent || '';
  const result: ScriptStreamPreviewResult = {
    title: null,
    coverTitleParts: null,
    segments: [],
  };

  const titleStart = findStringField(buf, 'title', 0);
  if (titleStart >= 0) result.title = readJsonString(buf, titleStart);

  const coverStart = findKey(buf, 'coverTitleParts', 0);
  if (coverStart >= 0) {
    const primaryStart = findStringField(buf, 'primary', coverStart);
    const secondaryStart = findStringField(buf, 'secondary', coverStart);
    result.coverTitleParts = {
      primary: primaryStart >= 0 ? readJsonString(buf, primaryStart) : null,
      secondary: secondaryStart >= 0 ? readJsonString(buf, secondaryStart) : null,
    };
  }

  const segmentsStart = findKey(buf, 'segments', 0);
  if (segmentsStart >= 0) {
    let cursor = segmentsStart;
    while (cursor < buf.length) {
      const narrationStart = findStringField(buf, 'narration', cursor);
      if (narrationStart < 0) break;
      const narration = readJsonString(buf, narrationStart);
      let subtitle: StreamPreviewText | null = null;
      if (narration.done) {
        const subtitleStart = findStringField(buf, 'subtitle', narrationStart + 1);
        if (subtitleStart >= 0) subtitle = readJsonString(buf, subtitleStart);
      }
      result.segments.push({ narration, subtitle });
      cursor = narrationStart + 1;
      if (!narration.done) break;
      if (subtitle && !subtitle.done) break;
    }
  }

  return result;
}
