import JSZip from 'jszip';

// 从 docx 提取纯文本
export async function parseDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('无效的 docx 文件');
  // 提取 <w:t> 标签中的文本
  const texts = [];
  let current = '';
  for (const match of xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)) {
    current += match[1];
  }
  // 按段落分割 (<w:p>)
  for (const para of xml.split(/<\/w:p>/)) {
    const t = [...para.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map(m => m[1]).join('');
    if (t.trim()) texts.push(t.trim());
  }
  return texts;
}

// 从 xlsx 提取纯文本（所有 sheet）
export async function parseXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  // 读取共享字符串
  const ssXml = await zip.file('xl/sharedStrings.xml')?.async('string') || '';
  const shared = [...ssXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]);

  const texts = [];
  // 遍历所有 sheet
  const sheetFiles = Object.keys(zip.files).filter(f => f.match(/xl\/worksheets\/sheet\d+\.xml/));
  for (const sf of sheetFiles) {
    const sheetXml = await zip.file(sf)?.async('string');
    if (!sheetXml) continue;
    // 每行拼接单元格
    for (const row of sheetXml.split(/<\/row>/)) {
      const cells = [];
      for (const cell of row.split(/<\/c>/)) {
        const isShared = cell.includes('t="s"');
        const valMatch = cell.match(/<v>([\s\S]*?)<\/v>/);
        if (valMatch) {
          const val = isShared ? (shared[parseInt(valMatch[1])] || '') : valMatch[1];
          cells.push(val);
        }
      }
      if (cells.length) texts.push(cells.join(' | '));
    }
  }
  return texts;
}

// 从 PDF 提取纯文本（轻量实现，适用于 CF Workers）
export async function parsePdf(buffer) {
  const bytes = new Uint8Array(buffer);
  const raw = new TextDecoder('latin1').decode(bytes);
  const texts = [];

  // 找到所有 stream 对象并尝试解压提取文本
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  let match;
  while ((match = streamRegex.exec(raw)) !== null) {
    const streamData = match[1];
    const extracted = await extractTextFromStream(bytes, match.index + match[0].indexOf('\n') + 1, streamData.length);
    if (extracted) texts.push(...extracted);
  }

  // 如果 stream 解析失败，尝试直接提取可见文本
  if (!texts.length) {
    const fallback = extractPlainText(raw);
    if (fallback.length) texts.push(...fallback);
  }

  return texts.length ? texts : ['（PDF 内容无法解析，可能是扫描件或图片型 PDF）'];
}

async function extractTextFromStream(bytes, offset, length) {
  const chunk = bytes.slice(offset, offset + length);
  let text = '';
  // 尝试 deflate 解压
  try {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(chunk);
    writer.close();
    const parts = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const merged = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
    let pos = 0;
    for (const p of parts) { merged.set(p, pos); pos += p.length; }
    text = new TextDecoder('latin1').decode(merged);
  } catch {
    text = new TextDecoder('latin1').decode(chunk);
  }
  return parseTextOperators(text);
}

function parseTextOperators(content) {
  const lines = [];
  let current = '';
  // 匹配 Tj 操作符（简单文本）
  const tjRegex = /\(([^)]*)\)\s*Tj/g;
  let m;
  while ((m = tjRegex.exec(content)) !== null) {
    current += decodeEscapes(m[1]);
  }
  // 匹配 TJ 操作符（数组文本）
  const tjArrayRegex = /\[(.*?)\]\s*TJ/gi;
  while ((m = tjArrayRegex.exec(content)) !== null) {
    const inner = m[1];
    const strRegex = /\(([^)]*)\)/g;
    let s;
    while ((s = strRegex.exec(inner)) !== null) {
      current += decodeEscapes(s[1]);
    }
  }
  // 匹配 ' 操作符
  const quoteRegex = /\(([^)]*)\)\s*'/g;
  while ((m = quoteRegex.exec(content)) !== null) {
    current += decodeEscapes(m[1]) + '\n';
  }

  if (current.trim()) {
    for (const line of current.split('\n')) {
      const t = line.trim();
      if (t) lines.push(t);
    }
  }
  return lines.length ? lines : null;
}

function decodeEscapes(s) {
  return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
    .replace(/\\([()])/g, '$1');
}

function extractPlainText(raw) {
  const texts = [];
  const regex = /\(([^)]{2,})\)/g;
  let m;
  while ((m = regex.exec(raw)) !== null) {
    const t = m[1].trim();
    if (t.length > 3 && !/^[\\x00-\\x1f]+$/.test(t) && /[\u4e00-\u9fff\w]{2,}/.test(t)) {
      texts.push(t);
    }
  }
  return texts;
}

// 文本分块
export function chunkTexts(texts, maxLen = 500) {
  const chunks = [];
  let buf = '';
  for (const t of texts) {
    if (buf.length + t.length > maxLen && buf) {
      chunks.push(buf.trim());
      buf = '';
    }
    buf += t + '\n';
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}
