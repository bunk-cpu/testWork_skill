import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { contentFields, referencedFiles, isImage } from './defect-content.mjs';

export const validWorkspaceId = value => typeof value === 'string' && /^\d{5,20}$/.test(value);
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}
export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function checkComponent(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() ||
      /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || ['.', '..'].includes(value)) {
    throw new Error(`${label} 必须是单层、有效的 Windows 文件夹名称。`);
  }
}
function checkedFile(root, defectDir, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('文件路径必须相对于测试根目录。');
  const target = path.resolve(root, relative);
  if (!inside(defectDir, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`附件或描述必须位于本条缺陷目录且文件存在：${relative}`);
  }
  if (!inside(fs.realpathSync(root), fs.realpathSync(target)) ||
      !inside(fs.realpathSync(defectDir), fs.realpathSync(target))) throw new Error('文件链接越过了缺陷目录。');
  return target;
}
export function loadManifest(file, root, { requireApproval = false } = {}) {
  root = fs.realpathSync(root);
  const manifest = readJson(file);
  if (!validWorkspaceId(manifest.workspaceId)) throw new Error('缺陷清单需要从实际项目页核对的 TAPD 项目 ID。');
  const resultBase = manifest.resultBase ?? '';
  if (typeof resultBase !== 'string') throw new Error('resultBase 必须是分类目录或回测批次的相对路径。');
  let resultRoot = root;
  if (resultBase) {
    const segments = resultBase.split(/[\\/]/);
    const prefixes = [['资源中心前台'], ['资源中心后台'], ['通用测试资料', 'TAPD自动化']];
    const prefix = prefixes.find(parts => parts.every((part, index) => segments[index] === part));
    const run = prefix ? segments.slice(prefix.length) : segments;
    const validRun = run.length === 3 && run[0] === '回测结果' && /^\d{4}-\d{2}-\d{2}$/.test(run[1]) &&
      !Number.isNaN(Date.parse(run[1])) && new Date(run[1]).toISOString().slice(0, 10) === run[1];
    if (path.isAbsolute(resultBase) || (!validRun && !(prefix && run.length === 0))) {
      throw new Error('resultBase 必须为 所属端 或 所属端/回测结果/日期/批次，不能越界。');
    }
    if (validRun) checkComponent(run[2], '回测批次');
    resultRoot = path.resolve(root, ...segments);
    if (!fs.existsSync(resultRoot) || !inside(root, fs.realpathSync(resultRoot))) throw new Error('分类目录或回测批次不存在或越过测试根目录。');
  }
  if (!Array.isArray(manifest.defects) || !manifest.defects.length) throw new Error('缺陷清单不能为空。');
  const purpose = manifest.purpose || 'reviewed-defects';
  if (!['reviewed-defects', 'creation-smoke'].includes(purpose)) throw new Error('未知的提交用途。');
  if (purpose === 'creation-smoke' && (manifest.defects.length !== 1 || manifest.review?.kind !== 'explicit-test-creation' ||
      !manifest.defects[0].title?.includes('自动化验证'))) {
    throw new Error('创建链路测试必须有 explicit-test-creation 授权类型，且只能包含一条标题明确标注“自动化验证”的测试记录。');
  }
  if (purpose === 'reviewed-defects' && manifest.review?.kind === 'explicit-test-creation') throw new Error('测试创建授权不能用于提交业务缺陷。');
  const ids = new Set();
  const defects = manifest.defects.map(item => {
    checkComponent(item.page, '页面名称');
    checkComponent(item.id, '缺陷 ID');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.id) || ids.has(item.id)) throw new Error(`缺陷 ID 无效或重复：${item.id}`);
    ids.add(item.id);
    if (typeof item.title !== 'string' || !item.title.trim() || /[\r\n]/.test(item.title)) throw new Error(`${item.id} 缺少有效标题。`);
    const directory = path.resolve(resultRoot, item.page, item.id);
    if (!fs.existsSync(directory) || !inside(fs.realpathSync(resultRoot), fs.realpathSync(directory))) throw new Error(`${item.id} 的归档目录不存在或越界。`);
    const descriptionFile = checkedFile(root, directory, item.descriptionFile);
    const description = fs.readFileSync(descriptionFile, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!description || /\.html?$/i.test(descriptionFile)) throw new Error(`${item.id} 请提供非空 UTF-8 纯文本描述文件；HTML 可另作附件。`);
    if (item.attachments !== undefined && !Array.isArray(item.attachments)) throw new Error('attachments 必须为文件路径数组。');
    for (const relative of item.attachments || []) checkedFile(root, directory, relative);
    const attachmentPaths = referencedFiles(root, directory, description, item.attachments || []);
    const attachments = attachmentPaths.map(relative => {
      const absolute = checkedFile(root, directory, relative);
      const buffer = fs.readFileSync(absolute);
      return { path: relative, absolute, buffer, sha256: sha256(buffer) };
    }).filter(item => !isImage(item.absolute, item.buffer));
    if (new Set(attachments.map(a => a.absolute.toLowerCase())).size !== attachments.length) throw new Error(`${item.id} 附件重复。`);
    const suppliedFields = item.fields || {};
    if (typeof suppliedFields !== 'object' || Array.isArray(suppliedFields) || Object.values(suppliedFields).some(v => typeof v !== 'string' || !v.trim())) throw new Error('fields 必须为“字段名：非空字符串”的对象。');
    if (Object.keys(suppliedFields).some(key => /^(标题|缺陷名称|描述|详细描述|附件)$/.test(key))) throw new Error('标题、描述和附件不能通过 fields 覆盖。');
    const fields = contentFields(description, suppliedFields, { required: requireApproval });
    const marker = `[${item.id}]`;
    const title = item.title.includes(marker) ? item.title.trim() : `${marker} ${item.title.trim()}`;
    const payload = { workspaceId: manifest.workspaceId, ...(manifest.projectName ? { projectName: manifest.projectName } : {}), ...(resultBase ? { resultBase } : {}), ...(purpose === 'creation-smoke' ? { purpose } : {}), page: item.page, id: item.id, title, description,
      fields: Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))),
      attachments: attachments.map(({ path: relative, sha256: hash }) => ({ path: relative, sha256: hash })) };
    return { ...payload, directory, attachments, fingerprint: sha256(JSON.stringify(payload)), payload };
  });
  if (requireApproval) {
    const review = manifest.review;
    if (review?.approved !== true || typeof review.source !== 'string' || !review.source.trim() ||
        !Array.isArray(review.approvedIds) || review.approvedIds.length !== ids.size ||
        new Set(review.approvedIds).size !== ids.size || review.approvedIds.some(id => !ids.has(id))) {
      throw new Error('提交需要用户审核记录及完全一致的 approvedIds 清单；不能用脚本自行批准。');
    }
  }
  return { manifest, defects };
}
export function receiptFile(defect) { return path.join(defect.directory, 'tapd-submission.json'); }
export function receipt(defect) {
  const file = receiptFile(defect);
  return fs.existsSync(file) ? readJson(file) : null;
}
export function assertRunnable(defect) {
  const previous = receipt(defect);
  if (!previous) return true;
  if (['submitting', 'uncertain'].includes(previous.status)) throw new Error(`${defect.id} 上次提交结果不确定，先在 TAPD 核实并用 reconcile 登记；禁止自动重试。`);
  if (['submitted', 'already-exists'].includes(previous.status)) {
    if (previous.fingerprint !== defect.fingerprint) throw new Error(`${defect.id} 已有 TAPD 记录且内容改变；请单独处理原缺陷，不能再创建。`);
    return false;
  }
  if (previous.status !== 'failed-before-submit') throw new Error(`${defect.id} 本地提交状态无效，请先核实记录。`);
  return true;
}
export function record(defect, status, details = {}) {
  const data = { localId: defect.id, page: defect.page, fingerprint: defect.fingerprint,
    status, updatedAt: new Date().toISOString(), ...details };
  writeJson(receiptFile(defect), data);
  const summaryPath = path.join(path.dirname(defect.directory), 'TAPD提交执行记录.json');
  const events = fs.existsSync(summaryPath) ? readJson(summaryPath) : [];
  events.push(data);
  writeJson(summaryPath, events);
  return data;
}
export function bugIdentity(url, origin = 'https://www.tapd.cn', workspaceId) {
  try {
    if (!validWorkspaceId(workspaceId)) return null;
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return null;
    const pattern = new RegExp(`^/(?:tapd_fe/${workspaceId}/bug/(?:detail|view)/|${workspaceId}/bugtrace/bugs/view/)(11${workspaceId}\\d{5,})/?$`);
    const match = parsed.pathname.match(pattern);
    return match ? { bugId: match[1], url: parsed.href } : null;
  } catch { return null; }
}
export function errorText(error) {
  // Error messages must not contain input values or login credentials.
  return `${error?.name || 'Error'}: ${error?.message || 'Unknown error'}`.slice(0, 2000);
}
export async function submitOne(defect, adapter, review) {
  if (!assertRunnable(defect)) return { skipped: true, ...receipt(defect) };
  let clicked = false;
  try {
    writeJson(path.join(defect.directory, 'tapd-payload.json'), { ...defect.payload, fingerprint: defect.fingerprint, review });
    const existing = await adapter.findExisting(defect);
    if (existing) return record(defect, 'already-exists', await adapter.verifyCreated(defect, existing.url));
    await adapter.prepare(defect);
    await adapter.screenshot(path.join(defect.directory, 'tapd-before-submit.png'));
    // Durable intent precedes the only submit click. A crash here requires reconciliation.
    record(defect, 'submitting', { attemptedAt: new Date().toISOString() });
    clicked = true;
    const created = await adapter.submit(defect);
    if (!created?.bugId || !created?.url) throw new Error('缺少可核对的 TAPD 缺陷 ID 和详情链接。');
    const verified = await adapter.verifyCreated(defect, created.url);
    const saved = record(defect, 'submitted', verified);
    // A screenshot failure after confirmation must never make a submitted defect retryable.
    try { await adapter.screenshot(path.join(defect.directory, 'tapd-after-submit.png')); } catch { /* receipt is authoritative */ }
    return saved;
  } catch (error) {
    record(defect, clicked ? 'uncertain' : 'failed-before-submit', { error: errorText(error) });
    try { await adapter.screenshot(path.join(defect.directory, 'tapd-error.png')); } catch { /* preserve the original failure */ }
    throw error;
  }
}
