import fs from 'node:fs';
import path from 'node:path';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.jpe', '.webp', '.gif', '.svg', '.bmp', '.tif', '.tiff', '.ico', '.avif', '.heic', '.heif']);
export const deferredFields = new Set(['发现版本', '模块', '处理人']);
export function isImage(file, buffer) {
  if (imageExtensions.has(path.extname(file).toLowerCase())) return true;
  const head = buffer.subarray(0, 512);
  return head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    head.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || /^(GIF8[79]a|BM|II\*\x00|MM\x00\*)/.test(head.toString('latin1')) ||
    (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') ||
    /<svg\b/i.test(head.toString('utf8')) ||
    (head.toString('ascii', 4, 8) === 'ftyp' && /avif|avis|heic|heix|heif|mif1/.test(head.toString('ascii', 8, 40)));
}
export function contentFields(description, supplied = {}, { required = false } = {}) {
  const fields = Object.fromEntries(Object.entries(supplied).filter(([label]) => !deferredFields.has(label)));
  for (const label of ['优先级', '严重程度']) {
    const values = [...description.matchAll(new RegExp(`^\\s*(?:【${label}】|(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[:：])\\s*([^\\r\\n]+)`, 'gm'))].map(match => match[1].trim());
    if (!values.length) {
      if (required || supplied[label]) throw new Error(`缺陷正文缺少“${label}”，请在生成缺陷内容时明确评定值。`);
      continue;
    }
    if (new Set(values).size !== 1 || (supplied[label] && supplied[label] !== values[0])) throw new Error(`“${label}”与缺陷正文不一致。`);
    fields[label] = values[0];
  }
  return fields;
}
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentions(description, reference) {
  return new RegExp(`(?<![\\p{L}\\p{N}_.\\/\\\\-])${escapeRegex(reference)}(?![\\p{L}\\p{N}_.-])`, 'u').test(description);
}
function filesWithin(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? filesWithin(file) : entry.isFile() ? [file] : [];
  });
}
// A manifest's legacy attachment list is a location hint, never an instruction to upload unreferenced files.
export function referencedFiles(root, directory, description, hints = []) {
  const selected = new Set();
  const explicit = [...description.matchAll(/(?<!!)\[[^\]\r\n]*\]\(([^)\r\n]+)\)|`([^`\r\n]+\.[a-zA-Z0-9]{1,10})`/g)]
    .map(match => (match[1] || match[2]).trim().replace(/^<|>$/g, ''));
  for (const reference of explicit) {
    if (/^(?:https?:|data:|#)/i.test(reference)) continue;
    const decoded = decodeURIComponent(reference).split('#')[0];
    if (imageExtensions.has(path.extname(decoded).toLowerCase())) continue;
    const candidates = path.isAbsolute(decoded) ? [decoded] : [path.resolve(directory, decoded), path.resolve(root, decoded)];
    const found = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!found) throw new Error(`缺陷正文引用的文件不存在：${reference}`);
    selected.add(path.resolve(found));
  }
  for (const file of [...filesWithin(directory), ...hints.map(relative => path.resolve(root, relative))]) {
    const references = [path.basename(file), path.relative(directory, file), path.relative(root, file), file];
    if (references.some(reference => mentions(description, reference) || mentions(description, reference.replaceAll('\\', '/')))) selected.add(file);
  }
  return [...selected].sort().map(file => path.relative(root, file));
}
