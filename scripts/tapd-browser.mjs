import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { bugIdentity, writeJson, validWorkspaceId } from './manifest.mjs';
import { deferredFields } from './defect-content.mjs';

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function unique(candidates, label, { optional = false, visible = true } = {}) {
  for (const candidate of candidates.filter(Boolean)) {
    const matches = [];
    for (const locator of await candidate.all()) if (!visible || await locator.isVisible()) matches.push(locator);
    if (matches.length === 1) return matches[0];
  }
  if (optional) return null;
  throw new Error(`无法唯一识别“${label}”，请运行 inspect 核对页面并在 config.json 的 selectors 中配置选择器。`);
}
export async function waitFor(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(250);
  }
  throw new Error(message);
}
export class TapdBrowser {
  constructor(page, config, { origin = 'https://www.tapd.cn' } = {}) {
    this.page = page;
    this.config = config;
    this.origin = origin;
    this.selectors = config.selectors || {};
    this.timeout = config.timeoutMs || 20000;
    this.workspaceId = config.workspaceId || new URL(config.listUrl || '/', origin).pathname.match(/\/tapd_fe\/(\d+)\//)?.[1];
  }
  css(key, scope = this.page) { return this.selectors[key] ? scope.locator(this.selectors[key]) : null; }
  async assertAccessible() {
    const body = await this.page.locator('body').innerText();
    if (/您的请求已中断|Web应用防护|请求可能对网站造成威胁|Access Denied|Forbidden|ERR_PROXY/i.test(body)) {
      throw new Error('TAPD 访问被站点或网络防护拦截，未执行登录或缺陷提交。请在可正常访问 TAPD 的环境中重试。');
    }
  }
  async list() {
    await this.page.goto(this.config.listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.page.locator('body').waitFor();
    await this.assertAccessible();
  }
  async openLogin() {
    const loginUrl = new URL(this.config.loginUrl || '/cloud_logins/login', this.origin);
    if (loginUrl.origin !== this.origin) throw new Error('登录入口必须属于 TAPD 站点。');
    await this.page.goto(loginUrl.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.assertAccessible();
  }
  async loginState() {
    await this.assertAccessible();
    const url = new URL(this.page.url());
    if (url.origin !== this.origin) return 'unknown';
    if (await this.page.locator('input[type="password"]:visible').count()) return 'login-required';
    if (/login/i.test(url.pathname)) {
      return await this.page.locator('input:visible, button:visible, [role="button"]:visible').count() ? 'login-required' : 'unknown';
    }
    const projectOrAccount = await this.page.locator('a[href]:visible').evaluateAll(elements => elements.some(element => {
      const url = new URL(element.href);
      return url.origin === location.origin && (/^\/(?:tapd_fe\/)?\d{5,20}(?:\/|$)/.test(url.pathname) || /logout|signout/i.test(url.pathname));
    }));
    const accountControl = await this.page.getByText(/^(退出登录|退出账号|注销登录|个人设置)$/).evaluateAll(elements => elements.some(element => element.getClientRects().length));
    return projectOrAccount || accountControl ? 'authenticated' : 'unknown';
  }
  async detectLogin() {
    return waitFor(async () => {
      const state = await this.loginState();
      return state === 'unknown' ? null : state;
    }, this.timeout, '无法确认登录状态，未继续操作；请核对实际页面。');
  }
  async verifyLogin() {
    await waitFor(async () => {
      const state = await this.loginState();
      if (state === 'authenticated') return true;
      if (state === 'login-required') return false;
      const url = new URL(this.page.url());
      if (url.origin !== this.origin || !validWorkspaceId(this.workspaceId)) return false;
      if (url.pathname === `/${this.workspaceId}/bugtrace/bugs/add` && await this.page.locator('#bug_form:visible').count()) return true;
      return this.lastVerifiedDetail?.url === url.href && (await this.page.locator('body').innerText()).includes(this.lastVerifiedDetail.title);
    }, this.timeout,
      '登录尚未完成或会话已失效，请由用户在登录浏览器中完成登录。');
  }
  async ensureLoggedIn() {
    await this.openLogin();
    await this.verifyLogin();
    if (this.config.listUrl) {
      await this.list();
      if (new URL(this.page.url()).pathname !== `/tapd_fe/${this.workspaceId}/bug/list`) throw new Error('未进入已核对的目标项目缺陷列表。');
    }
  }
  async resolveProject(name) {
    const matches = async () => {
      const projects = new Map();
      for (const anchor of await this.page.locator('a[href]').all()) {
        if (!await anchor.isVisible() || (await anchor.innerText()).trim() !== name) continue;
        const url = new URL(await anchor.getAttribute('href'), this.origin);
        const id = url.pathname.match(/^\/(?:tapd_fe\/)?(\d+)\//)?.[1];
        if (url.origin === this.origin && validWorkspaceId(id)) projects.set(id, { projectName: name, workspaceId: id, listUrl: `${this.origin}/tapd_fe/${id}/bug/list` });
      }
      return [...projects.values()];
    };
    let found = await matches();
    if (!found.length && this.selectors.projectSwitcher) {
      await this.page.locator(this.selectors.projectSwitcher).click();
      if (this.selectors.projectSearch) await this.page.locator(this.selectors.projectSearch).fill(name);
    }
    found = await waitFor(async () => { const results = await matches(); return results.length ? results : null; }, this.timeout,
      '未找到用户指定名称的可访问项目；请核对项目名称、项目切换器或账号权限。');
    if (found.length !== 1) throw new Error('当前账号存在多个同名项目，请用户补充所属团队等区分信息。');
    const project = found[0];
    this.config = { ...this.config, ...project };
    this.workspaceId = project.workspaceId;
    await this.list();
    if (new URL(this.page.url()).pathname !== `/tapd_fe/${project.workspaceId}/bug/list`) throw new Error('按名称选择后未进入相应项目。');
    return project;
  }
  async existingOnPage(defect) {
    // Read one DOM snapshot: a post-submit navigation may otherwise invalidate locators mid-loop.
    let anchors;
    try {
      anchors = await this.page.locator('a[href]').evaluateAll(elements => elements.filter(element => element.getClientRects().length).map(element => ({
        text: element.innerText.trim(), title: element.getAttribute('title'), href: element.getAttribute('href'),
      })));
    } catch (error) {
      if (/Execution context was destroyed|navigation/i.test(error.message)) return null;
      throw error;
    }
    for (const anchor of anchors) {
      if (anchor.text !== defect.title && anchor.title !== defect.title) continue;
      const found = bugIdentity(anchor.href, this.origin, this.workspaceId);
      if (found) return found;
    }
    return null;
  }
  async findExisting(defect) {
    await this.list();
    const search = await unique([this.css('duplicateSearch'), this.page.getByPlaceholder(/^(搜索缺陷|请输入缺陷标题|搜索标题)$/)], '缺陷标题搜索', { optional: true });
    if (search) {
      await search.fill(defect.title);
      await search.press('Enter');
      // Give the list response a bounded chance to settle. The local receipt remains the primary duplicate guard.
      await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
    await this.assertAccessible();
    return this.existingOnPage(defect);
  }
  async openCreate() {
    const create = await waitFor(() => unique([this.css('createBug'), this.page.getByRole('button', { name: /^(创建|创建缺陷|新建缺陷|新增缺陷)$/ }),
      this.page.getByRole('link', { name: /^(创建缺陷|新建缺陷|新增缺陷)$/ }), this.page.getByText(/^(创建缺陷|新建缺陷|新增缺陷)$/)], '创建缺陷入口',
      { optional: true }), this.timeout, '无法唯一识别创建缺陷入口；请运行 inspect 核对实际页面。');
    const listPage = this.page;
    const onPopup = popup => { this.page = popup; popup.setDefaultTimeout(this.timeout); };
    listPage.on('popup', onPopup);
    try {
      await create.click();
      await waitFor(async () => this.titleField(true), this.timeout, '新建缺陷表单未出现。');
      await this.assertAccessible();
      const target = new URL(this.page.url());
      if (!validWorkspaceId(this.workspaceId) || target.origin !== this.origin || !new RegExp(`^/(?:tapd_fe/${this.workspaceId}/|${this.workspaceId}/)`).test(target.pathname)) throw new Error('创建表单不属于目标 TAPD 项目。');
    } finally { listPage.off('popup', onPopup); }
  }
  async scope() {
    return await unique([this.css('form'), this.page.getByRole('dialog')], '新建缺陷表单', { optional: true }) || this.page;
  }
  async titleField(optional = false) {
    const scope = await this.scope();
    return unique([this.css('title', scope), scope.getByLabel(/^[\s*]*(标题|缺陷名称)[\s*：:]*$/),
      scope.getByPlaceholder(/^(请输入)?(缺陷)?标题/), scope.locator('input[name="data[Bug][title]"], input[name="title"], #BugTitle')], '缺陷标题', { optional });
  }
  async descriptionField() {
    return waitFor(async () => {
      const scope = await this.scope();
      const direct = await unique([this.css('description', scope), scope.getByLabel(/^[\s*]*(详细描述|缺陷描述|描述)[\s*：:]*$/),
        scope.locator('[contenteditable="true"], textarea[name="data[Bug][description]"], textarea[name="description"]')], '缺陷描述', { optional: true });
      if (direct) return direct;
      const candidates = [];
      for (const frame of this.page.frames().filter(frame => frame !== this.page.mainFrame())) {
        candidates.push(frame.locator('body[contenteditable="true"], [contenteditable="true"]'));
      }
      return unique(candidates, '富文本描述编辑器', { optional: true });
    }, this.timeout, '无法识别已加载的描述编辑器。');
  }
  async field(label) {
    const scope = await this.scope();
    const expression = new RegExp(`^[\\s*]*${escapeRegex(label)}[\\s*：:]*$`);
    const configured = this.selectors.fields?.[label];
    const candidates = [configured ? scope.locator(configured) : null, scope.getByLabel(expression)];
    for (const text of await scope.getByText(expression).all()) {
      const parent = text.locator('xpath=..');
      candidates.push(parent.locator('input:not([type="hidden"]), textarea, select, [role="combobox"]'));
    }
    return unique(candidates, label);
  }
  async fillField(label, value) {
    const field = await this.field(label);
    const tag = await field.evaluate(element => element.tagName.toLowerCase());
    if (tag === 'select') {
      await field.selectOption({ label: value });
      if ((await field.locator('option:checked').innerText()).trim() !== value) throw new Error(`字段“${label}”未选择成功。`);
    } else if (await field.getAttribute('role') === 'combobox' || await field.getAttribute('readonly') !== null || !['input', 'textarea'].includes(tag)) {
      await field.click();
      const option = await unique([this.page.getByRole('option', { name: value, exact: true }), this.page.getByText(value, { exact: true })], `${label} 的选项`);
      await option.click();
      const actual = await field.evaluate(element => element.value || element.innerText || element.textContent || '');
      if (!actual.includes(value)) throw new Error(`字段“${label}”选择后无法核对，请配置实际控件选择器。`);
    } else {
      await field.fill(value);
      if (await field.inputValue() !== value) throw new Error(`字段“${label}”填写后不一致。`);
    }
  }
  async prepare(defect) {
    await this.openCreate();
    const title = await this.titleField();
    await title.fill(defect.title);
    const description = await this.descriptionField();
    if (this.config.descriptionEditorId) {
      // TinyMCE turns pasted newlines into paragraphs and can inherit template formatting.
      // Use its public editor API with escaped text and explicit line breaks instead.
      const html = `<p>${defect.description.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\r?\n/g, '<br>')}</p>`;
      await this.page.evaluate(({ id, html }) => {
        const editor = globalThis.tinymce?.get(id);
        if (!editor?.initialized) throw new Error('配置的 TinyMCE 编辑器尚未初始化。');
        editor.setContent(html);
        editor.save();
        editor.fire('input');
        editor.fire('change');
      }, { id: this.config.descriptionEditorId, html });
    } else await description.fill(defect.description);
    for (const [label, value] of Object.entries(defect.fields)) if (!deferredFields.has(label)) await this.fillField(label, value);
    if (defect.attachments.length) {
      const scope = await this.scope();
      const input = await unique([this.css('attachmentInput', scope), scope.locator('input[type="file"][multiple]'), scope.locator('input[type="file"]')], '附件上传控件', { visible: false });
      const filePayload = item => {
        const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.zip': 'application/zip', '.html': 'text/html' };
        return { name: path.basename(item.absolute), mimeType: types[path.extname(item.absolute).toLowerCase()] || 'application/octet-stream', buffer: item.buffer };
      };
      if (await input.getAttribute('multiple') !== null) {
        await input.setInputFiles(defect.attachments.map(filePayload));
      } else {
        for (const attachment of defect.attachments) {
          await input.setInputFiles(filePayload(attachment));
          await waitFor(async () => (await this.page.locator('body').innerText()).includes(path.basename(attachment.absolute)), 45000, '单文件附件上传状态无法确认。');
        }
      }
      await waitFor(async () => {
        const body = scope === this.page ? await this.page.locator('body').innerText() : await scope.innerText();
        if (/上传失败|附件上传失败/.test(body)) throw new Error('附件上传失败，未点击提交。');
        return !/正在上传|上传中/.test(body) && defect.attachments.every(item => body.includes(path.basename(item.absolute)));
      }, 45000, '附件上传完成状态无法确认，未点击提交。');
    }
    if (await title.inputValue() !== defect.title) throw new Error('提交前标题发生变化。');
    const actualDescription = await description.evaluate(element => element.value ?? element.innerText ?? '');
    if (actualDescription.replace(/\r\n/g, '\n').trim() !== defect.description.replace(/\r\n/g, '\n').trim()) throw new Error('提交前描述与审核文件不一致。');
    const scope = await this.scope();
    const missing = await scope.locator('input[required], textarea[required], select[required], [aria-required="true"]').evaluateAll(elements => elements.filter(element => {
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length && !element.disabled &&
        !String(element.value ?? element.innerText ?? '').trim();
    }).map(element => element.getAttribute('aria-label') || element.name || element.id || element.tagName));
    if (missing.length) throw new Error(`表单必填项缺失：${missing.join('、')}。请核对项目要求；发现版本、模块、处理人仍交由用户手动处理，不选择占位值。`);
  }
  async submit(defect) {
    const scope = await this.scope();
    const button = await unique([this.css('submitBug', scope), scope.getByRole('button', { name: /^(创建|保存|提交|创建缺陷|保存缺陷|提交缺陷)$/ })], '缺陷提交按钮');
    // Only one click. A timeout after this point is always treated as uncertain.
    await button.click({ timeout: this.timeout });
    return waitFor(async () => {
      await this.assertAccessible();
      const identity = bugIdentity(this.page.url(), this.origin, this.workspaceId);
      if (identity && (await this.page.locator('body').innerText()).includes(defect.title)) return identity;
      return this.existingOnPage(defect);
    }, this.timeout, '已点击提交，但未取得带缺陷 ID 的详情链接；请人工核实，禁止直接重试。');
  }
  async verifyExisting(defect, url) {
    const identity = bugIdentity(url, this.origin, this.workspaceId);
    if (!identity) throw new Error('详情链接必须属于指定 TAPD 项目，并包含有效缺陷 ID。');
    await this.page.goto(identity.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitFor(async () => {
      await this.assertAccessible();
      return (await this.page.locator('body').innerText()).includes(defect.title);
    }, this.timeout, '详情页未找到本条缺陷的完整标题，不能自动登记。');
    return identity;
  }
  async verifyCreated(defect, url) {
    const identity = await this.verifyExisting(defect, url);
    const normalize = text => text.replace(/\s+/gu, ' ').trim();
    await waitFor(async () => {
      await this.assertAccessible();
      const text = normalize(await this.page.locator('body').innerText());
      return text.includes(normalize(defect.description)) && defect.attachments.every(item => text.includes(path.basename(item.absolute)));
    }, this.timeout, '详情页正文或附件未核对通过；请核实实际记录，禁止直接再次创建。');
    this.lastVerifiedDetail = { ...identity, title: defect.title };
    const verified = { ...identity, verifiedAt: new Date().toISOString(), verified: ['title', 'description', 'attachment-names'] };
    writeJson(path.join(defect.directory, 'tapd-detail-verification.json'), verified);
    return verified;
  }
  async screenshot(file) {
    await this.page.screenshot({ path: file, fullPage: true, mask: [this.page.locator('input[type="password"]')] });
  }
  async inspect(directory) {
    fs.mkdirSync(directory, { recursive: true });
    const fields = await this.page.locator('input, textarea, select, button, a, [contenteditable="true"], [role="combobox"]').evaluateAll(elements => elements.map(element => ({
      tag: element.tagName, id: element.id, name: element.getAttribute('name'), type: element.getAttribute('type'),
      role: element.getAttribute('role'), placeholder: element.getAttribute('placeholder'), ariaLabel: element.getAttribute('aria-label'),
      text: (element.innerText || '').slice(0, 160), href: element.getAttribute('href'),
      visible: !!element.getClientRects().length
    })));
    writeJson(path.join(directory, 'page-fields.json'), { url: this.page.url(), fields });
    fs.writeFileSync(path.join(directory, 'page-text.txt'), await this.page.locator('body').innerText(), 'utf8');
    await this.screenshot(path.join(directory, 'page.png'));
  }
}
export async function openBrowser(skillDirectory, config) {
  const context = await chromium.launchPersistentContext(path.join(skillDirectory, '.local', 'browser-profile'), {
    channel: config.browserChannel || 'chrome', headless: false, viewport: { width: 1440, height: 1000 }, acceptDownloads: false,
  });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(config.timeoutMs || 20000);
  return { context, adapter: new TapdBrowser(page, config) };
}
