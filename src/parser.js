import JSZip from 'jszip';
import { extractText } from 'unpdf';

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

// 从 PDF 提取纯文本
export async function parsePdf(buffer) {
  const { text } = await extractText(new Uint8Array(buffer));
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines;
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
