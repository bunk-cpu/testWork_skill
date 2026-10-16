import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadManifest, writeJson, readJson, receipt, record, assertRunnable, submitOne, bugIdentity } from './manifest.mjs';
import { TapdBrowser, waitFor } from './tapd-browser.mjs';
import { manualLogin, confirmLogin, confirmedSession } from './login-session.mjs';
import { activeBrowserSession, serveBrowserSession, sendBrowserCommand } from './browser-session.mjs';
import { executeBrowserCommand } from './tapd-commands.mjs';
import { allocateResults } from './result-paths.mjs';

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(skillDirectory, '../../..');
const testBase = process.env.TAPD_TEST_OUTPUT_DIRECTORY || allocateResults(skillDirectory, 'TAPD脚本验证').outputDirectory;
fs.mkdirSync(testBase, { recursive: true });
const testDirectory = fs.mkdtempSync(path.join(testBase, '执行_'));
const listPath = '/tapd_fe/67780910/bug/list';
const classification = '【优先级】中\n【严重程度】一般\n';
const htmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
let server, browser, origin, state;
const reset = options => { state = { creates: [], auth: [], visits: [], mode: 'normal', iframe: false, requireLogin: false, blocked: false, ...options }; };
function fixture(name, approved = true) {
  const root = path.join(testDirectory, name);
  const directory = path.join(root, '模拟授权页面', 'MOCK-001');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'TAPD.txt'), classification + '前置条件：进入模拟授权页面\n复现步骤：选择测试资源后保存\n预期结果：保存成功\n实际结果：保存后内容丢失\n【相关文件】\n- [日志](证据.txt)', 'utf8');
  fs.writeFileSync(path.join(directory, '证据.txt'), 'reviewed evidence', 'utf8');
  const manifest = { projectName: '模拟项目', workspaceId: '67780910', review: { approved, source: approved ? 'LOCAL FIXTURE ONLY - not a real user approval' : '', approvedIds: approved ? ['MOCK-001'] : [] },
    defects: [{ page: '模拟授权页面', id: 'MOCK-001', title: '保存后内容丢失', descriptionFile: '模拟授权页面/MOCK-001/TAPD.txt', fields: {} }] };
  const manifestFile = path.join(root, '模拟授权页面', '模拟待提交清单.json');
  writeJson(manifestFile, manifest);
  return { root, directory, manifest, manifestFile, load: () => loadManifest(manifestFile, root, { requireApproval: true }) };
}
function listHtml(formPage = false) {
  const rows = state.creates.map(item => `<a href="/tapd_fe/67780910/bug/detail/${item.bugId}">${htmlEscape(item.title)}</a>`).join('');
  const editor = state.iframe ? '<iframe title="描述编辑器" srcdoc="<body contenteditable=\'true\'></body>"></iframe>' : '<label for="description">描述</label><textarea id="description" name="description" required></textarea>';
  return `<!doctype html><meta charset="utf-8"><h1>模拟 TAPD 项目缺陷列表 - 67780910（本地浏览器自动化验证环境）</h1><a href="${listPath}">模拟项目</a><a href="/tapd_fe/11111111/bug/list">${state.duplicateProject ? '模拟项目' : '另一个项目'}</a>${rows}
<button id="create" onclick="${state.popup ? "window.open('/67780910/bugtrace/bugs/add')" : "document.querySelector('#form').style.display='block'"}">创建缺陷</button>
<div id="form" role="dialog" style="display:${formPage ? 'block' : 'none'}">
<label for="title">标题</label><input id="title" name="title" required>
${editor}
<label for="severity">严重程度</label><select id="severity" required><option value="">请选择</option><option value="normal">一般</option><option value="major">严重</option></select>
<label for="priority">优先级</label><select id="priority" required><option value="">请选择</option><option value="middle">中</option></select>
<label for="testtype">测试类型</label><input id="testtype" ${state.requireExtra ? 'required' : ''}>
<label for="version">发现版本</label><input id="version" ${state.requireDeferred ? 'required' : ''}>
<label for="module">模块</label><input id="module"><label for="owner">处理人</label><input id="owner">
<input type="file" id="files" multiple><span id="uploads"></span>
<button id="submit">提交</button></div>
<script>
${state.tiny ? `globalThis.tinymce = { get(id) { return id === 'fixtureEditor' ? { initialized: true, setContent(html) { document.querySelector('iframe').contentDocument.body.innerHTML = html; }, save() {}, fire() {} } : null; } };` : ''}
document.querySelector('#files').onchange = () => { document.querySelector('#uploads').innerText = '正在上传'; setTimeout(() => { document.querySelector('#uploads').innerText = [...document.querySelector('#files').files].map(f => f.name).join(' '); }, 100); };
document.querySelector('#submit').onclick = async () => {
const files = await Promise.all([...document.querySelector('#files').files].map(async f => ({name:f.name, content:await f.text()})));
const description = document.querySelector('#description')?.value ?? document.querySelector('iframe').contentDocument.body.innerText;
const response = await fetch('/create', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:document.querySelector('#title').value, description, severity:document.querySelector('#severity').value, priority:document.querySelector('#priority').value, version:document.querySelector('#version').value, module:document.querySelector('#module').value, owner:document.querySelector('#owner').value, files})});
const result = await response.json();
if(result.navigate) location.href = '/tapd_fe/67780910/bug/detail/' + result.bugId;
};
</script>`;
}
before(async () => {
  fs.mkdirSync(testDirectory, { recursive: true });
  reset();
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    state.visits.push(url.pathname);
    if (state.blocked) { response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<h1>您的请求已中断</h1><p>Web应用防护服务检测访问存在风险</p>'); return; }
    if (url.pathname === '/auth' || url.pathname === '/create') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw);
      if (url.pathname === '/auth') {
        state.auth.push(payload);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'mockauth=1; Path=/' }); response.end('{}');
      } else {
        const bugId = `1167780910${String(state.creates.length + 1).padStart(9, '0')}`;
        state.creates.push({ ...payload, bugId });
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ bugId, navigate: state.mode !== 'lost-result' }));
      }
      return;
    }
    const isLogin = ['/login', '/cloud_logins/login'].includes(url.pathname);
    if (state.requireLogin && !request.headers.cookie?.includes('mockauth=1') && !isLogin) { response.writeHead(302, { Location: '/login' }); response.end(); return; }
    if (isLogin && request.headers.cookie?.includes('mockauth=1')) { response.writeHead(302, { Location: listPath }); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (isLogin) response.end(`<!doctype html><meta charset="utf-8"><template id="login-template"><label for="username">账号</label><input id="username"><label for="password">密码</label><input id="password" type="password"><label><input id="protocol-checkbox" type="checkbox">登录协议</label><div id="tcloud_login_button" onclick="if(!document.querySelector('#protocol-checkbox').checked)return;fetch('/auth',{method:'POST',body:JSON.stringify({username:document.querySelector('#username').value,password:document.querySelector('#password').value})}).then(()=>location.href='${listPath}')">登录</div></template><div id="login-content"></div><script>setTimeout(()=>document.querySelector('#login-content').append(document.querySelector('#login-template').content.cloneNode(true)),${state.loginDelay || 0});</script>`);
    else if ([listPath, '/tapd_fe/11111111/bug/list'].includes(url.pathname)) response.end(listHtml());
    else if (url.pathname === '/67780910/bugtrace/bugs/add') response.end(listHtml(true));
    else {
      const item = state.creates.find(item => url.pathname.endsWith(item.bugId));
      response.end(item ? `<h1>${htmlEscape(item.title)}</h1><p>缺陷创建成功</p><pre>${htmlEscape(state.missingDetail ? '模拟详情正文缺失' : item.description)}</pre>${(item.files || []).map(file => `<a href="#">${htmlEscape(file.name)}</a>`).join('')}` : '<h1>未找到缺陷</h1>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
async function withAdapter(callback, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(2500);
    const adapter = new TapdBrowser(page, { listUrl: origin + listPath, loginUrl: origin + '/cloud_logins/login', timeoutMs: 2500, selectors: {}, ...options }, { origin });
    return await callback(adapter);
  } finally { await context.close(); }
}
test('审核范围未确认或与清单不一致时，拒绝正式提交', () => {
  const f = fixture('审核校验', false);
  assert.equal(loadManifest(f.manifestFile, f.root).defects.length, 1);
  assert.throws(f.load, /审核/);
  f.manifest.review = { approved: true, source: 'LOCAL FIXTURE ONLY', approvedIds: ['MOCK-999'] };
  writeJson(f.manifestFile, f.manifest);
  assert.throws(f.load, /审核/);
});
test('禁止串用其他缺陷的附件和越过页面目录', () => {
  const f = fixture('附件隔离');
  const another = path.join(f.root, '模拟授权页面', 'MOCK-002'); fs.mkdirSync(another);
  fs.writeFileSync(path.join(another, '证据.txt'), 'other bug');
  f.manifest.defects[0].attachments = ['模拟授权页面/MOCK-002/证据.txt'];
  writeJson(f.manifestFile, f.manifest); assert.throws(f.load, /本条缺陷/);
  f.manifest.defects[0].page = '../其他页面';
  writeJson(f.manifestFile, f.manifest); assert.throws(f.load, /单层/);
});
test('正确解析目标项目详情链接并拒绝其他项目或站点', () => {
  const identity = url => bugIdentity(url, 'https://www.tapd.cn', '67780910');
  assert.ok(identity('https://www.tapd.cn/tapd_fe/67780910/bug/detail/1167780910000000001'));
  assert.ok(identity('https://www.tapd.cn/67780910/bugtrace/bugs/view/1167780910000000001'));
  assert.equal(identity('https://evil.example/tapd_fe/67780910/bug/detail/1167780910000000001'), null);
  assert.equal(identity('https://www.tapd.cn/tapd_fe/11111111/bug/detail/1111111111000000001'), null);
  assert.ok(bugIdentity('https://www.tapd.cn/tapd_fe/11111111/bug/detail/1111111111000000001', 'https://www.tapd.cn', '11111111'));
});
test('回测提交使用本轮页面和缺陷目录，不串用首轮或其他批次附件', async () => {
  reset(); const f = fixture('回测批次隔离');
  const base = '回测结果/2026-10-16/160000_本地模拟回测';
  const relative = `${base}/模拟授权页面/MOCK-001`;
  const directory = path.join(f.root, relative); fs.mkdirSync(directory, { recursive: true });
  for (const name of ['TAPD.txt', '证据.txt']) fs.copyFileSync(path.join(f.directory, name), path.join(directory, name));
  f.manifest.resultBase = base;
  f.manifest.defects[0].descriptionFile = `${relative}/TAPD.txt`;
  f.manifest.defects[0].attachments = [`${relative}/证据.txt`];
  writeJson(f.manifestFile, f.manifest);
  const defect = f.load().defects[0]; assert.equal(defect.directory, directory);
  await withAdapter(async adapter => { const result = await submitOne(defect, adapter, f.manifest.review); assert.equal(result.status, 'submitted'); });
  assert.ok(fs.existsSync(path.join(directory, 'tapd-submission.json')));
  assert.ok(!fs.existsSync(path.join(f.directory, 'tapd-submission.json')));
  f.manifest.defects[0].attachments = ['模拟授权页面/MOCK-001/证据.txt']; writeJson(f.manifestFile, f.manifest);
  assert.throws(f.load, /本条缺陷/);
  f.manifest.resultBase = '../其他批次'; writeJson(f.manifestFile, f.manifest);
  assert.throws(f.load, /不能越界/);
});
test('分类后的首轮和回测清单只读取本端本批次缺陷附件', () => {
  for (const base of ['资源中心前台', '资源中心后台', '资源中心后台/回测结果/2026-10-16/160000_分类验证', '通用测试资料/TAPD自动化']) {
    const f = fixture(`分类验证-${base.replaceAll('/', '-')}`);
    const relative = `${base}/模拟授权页面/MOCK-001`;
    const directory = path.join(f.root, relative); fs.mkdirSync(directory, { recursive: true });
    for (const name of ['TAPD.txt', '证据.txt']) fs.copyFileSync(path.join(f.directory, name), path.join(directory, name));
    f.manifest.resultBase = base;
    f.manifest.defects[0].descriptionFile = `${relative}/TAPD.txt`;
    writeJson(f.manifestFile, f.manifest);
    assert.equal(f.load().defects[0].directory, directory);
    f.manifest.defects[0].attachments = ['模拟授权页面/MOCK-001/证据.txt'];
    writeJson(f.manifestFile, f.manifest); assert.throws(f.load, /本条缺陷/);
    f.manifest.resultBase = '资源中心后台/../资源中心前台';
    writeJson(f.manifestFile, f.manifest); assert.throws(f.load, /不能越界/);
  }
});
test('用户自行登录后仍等待明确告知，核对会话后才继续', async () => {
  reset({ requireLogin: true, loginDelay: 250 });
  await withAdapter(async adapter => {
    const directory = path.join(testDirectory, '模拟登录检查');
    let ready;
    const opened = new Promise(resolve => { ready = resolve; });
    const pending = manualLogin(adapter, directory, { onReady: ready });
    await opened;
    assert.equal(state.auth.length, 0);
    assert.throws(() => confirmedSession(directory), /尚未完成/);
    // These actions stand in for the human in this isolated local fixture only.
    await adapter.page.locator('#username').fill('fixture-user');
    await adapter.page.locator('#password').fill('fixture-password');
    await adapter.page.locator('#protocol-checkbox').check();
    await adapter.page.locator('#tcloud_login_button').click();
    await adapter.page.waitForURL(origin + listPath);
    assert.throws(() => confirmedSession(directory), /尚未完成/);
    confirmLogin(directory, 'LOCAL FIXTURE USER ACK ONLY');
    await pending;
    assert.equal(confirmedSession(directory).status, 'confirmed');
    assert.equal(state.auth.length, 1);
    assert.equal(state.auth[0].username, 'fixture-user');
    assert.equal(state.visits[0], '/cloud_logins/login');
    assert.equal(state.creates.length, 0);
    await adapter.inspect(directory);
    assert.ok(!fs.readFileSync(path.join(directory, 'page-fields.json'), 'utf8').includes('fixture-password'));
  });
});
test('已有有效登录时跳过人工登录及告知，不沿用旧项目上下文', async () => {
  reset({ requireLogin: true });
  await withAdapter(async adapter => {
    await adapter.page.context().addCookies([{ name: 'mockauth', value: '1', url: origin }]);
    const directory = path.join(testDirectory, '已有登录自动继续');
    writeJson(path.join(directory, 'project-context.json'), { sessionId: 'previous-user-session', projectName: '旧用户项目', workspaceId: '11111111' });
    const login = await manualLogin(adapter, directory, { onReady: () => assert.fail('已有会话不应进入人工登录等待') });
    assert.equal(login.mode, 'existing-session');
    assert.equal(confirmedSession(directory).status, 'confirmed');
    assert.notEqual(login.sessionId, readJson(path.join(directory, 'project-context.json')).sessionId);
    assert.equal(login.source, 'browser:verified-existing-session');
    assert.equal(state.auth.length, 0);
    assert.equal(state.creates.length, 0);
    assert.equal(state.visits[0], '/cloud_logins/login');
  });
});
test('旧标记和没有登录控件的普通错误页不能作为登录成功依据', async () => {
  reset();
  await withAdapter(async adapter => {
    await adapter.page.goto(origin + '/not-an-authenticated-page');
    await adapter.page.setContent('<p>这是普通错误页面，虽然具有足够多的文字，但没有任何实际账号或项目访问证据。</p>');
    assert.equal(await adapter.loginState(), 'unknown');
    const directory = path.join(testDirectory, '旧标记不复用');
    writeJson(path.join(directory, 'login-session.json'), { status: 'waiting-for-user', source: 'previous-user' });
    assert.throws(() => confirmedSession(directory), /尚未完成/);
  });
});
test('按用户项目名称核对其他项目，拒绝重名和不存在的项目', async () => {
  reset();
  await withAdapter(async adapter => {
    await adapter.list();
    const project = await adapter.resolveProject('另一个项目');
    assert.equal(project.workspaceId, '11111111');
    assert.equal(adapter.workspaceId, '11111111');
    assert.equal(new URL(adapter.page.url()).pathname, '/tapd_fe/11111111/bug/list');
    await assert.rejects(adapter.resolveProject('不存在的项目'), /未找到/);
    state.duplicateProject = true;
    await adapter.list();
    await assert.rejects(adapter.resolveProject('模拟项目'), /多个同名/);
    assert.equal(state.creates.length, 0);
  });
});
test('单条创建验证授权不能扩大为多条或用于业务缺陷', () => {
  const f = fixture('创建验证授权');
  f.manifest.purpose = 'creation-smoke';
  f.manifest.review.kind = 'explicit-test-creation';
  f.manifest.defects[0].title = '【自动化验证】模拟创建';
  writeJson(f.manifestFile, f.manifest);
  assert.equal(f.load().defects.length, 1);
  f.manifest.defects.push({ ...f.manifest.defects[0], id: 'MOCK-002' });
  writeJson(f.manifestFile, f.manifest); assert.throws(f.load, /只能包含一条/);
  f.manifest.defects.pop(); f.manifest.purpose = 'reviewed-defects';
  writeJson(f.manifestFile, f.manifest); assert.throws(f.load, /测试创建授权不能/);
  f.manifest.purpose = 'creation-smoke'; f.manifest.review.approved = false;
  writeJson(f.manifestFile, f.manifest); assert.throws(f.load, /审核/);
});
test('创建表单在新标签打开时，跟随新页面并只创建一次', async () => {
  reset({ popup: true }); const f = fixture('新标签创建'); const defect = f.load().defects[0];
  await withAdapter(async adapter => {
    const originalPage = adapter.page;
    const result = await submitOne(defect, adapter, f.manifest.review);
    assert.notEqual(adapter.page, originalPage);
    assert.equal(result.status, 'submitted'); assert.equal(state.creates.length, 1);
    assert.equal((await submitOne(defect, adapter, f.manifest.review)).skipped, true);
    assert.equal(state.creates.length, 1);
  });
});
test('模拟站点防护时停止，未尝试登录和创建', async () => {
  reset({ blocked: true });
  await withAdapter(async adapter => {
    await assert.rejects(adapter.ensureLoggedIn(), /拦截/);
    assert.equal(state.auth.length, 0); assert.equal(state.creates.length, 0);
  });
});
test('填写中文描述、业务字段、审核附件，创建一次并保留独立证据', async () => {
  reset(); const f = fixture('完整提交'); const { defects } = f.load(); const defect = defects[0];
  // Changing an on-disk file after loading must not change the reviewed upload bytes.
  fs.writeFileSync(path.join(f.directory, '证据.txt'), 'unreviewed later change', 'utf8');
  await withAdapter(async adapter => {
    const result = await submitOne(defect, adapter, f.manifest.review);
    assert.equal(result.status, 'submitted'); assert.ok(result.bugId); assert.equal(state.creates.length, 1);
    assert.equal(state.creates[0].title, '[MOCK-001] 保存后内容丢失');
    assert.equal(state.creates[0].description, defect.description); assert.equal(state.creates[0].severity, 'normal');
    assert.equal(state.creates[0].priority, 'middle');
    assert.equal(state.creates[0].files[0].content, 'reviewed evidence');
    for (const file of ['tapd-payload.json', 'tapd-submission.json', 'tapd-before-submit.png', 'tapd-after-submit.png']) assert.ok(fs.existsSync(path.join(f.directory, file)));
    const again = await submitOne(defect, adapter, f.manifest.review); assert.equal(again.skipped, true); assert.equal(state.creates.length, 1);
    const summary = readJson(path.join(f.root, '模拟授权页面', 'TAPD提交执行记录.json')); assert.equal(summary.at(-1).status, 'submitted');
    assert.throws(() => assertRunnable({ ...defect, fingerprint: 'changed' }), /内容改变/);
  });
});
test('iframe 富文本编辑器可填写并提交完整描述', async () => {
  reset({ iframe: true }); const f = fixture('富文本提交'); const { defects } = f.load();
  await withAdapter(async adapter => { await submitOne(defects[0], adapter, f.manifest.review); assert.equal(state.creates[0].description, defects[0].description); });
});
test('TinyMCE 描述保留原始换行，将 HTML 特殊字符按纯文本保存', async () => {
  reset({ iframe: true, tiny: true }); const f = fixture('TinyMCE换行与转义');
  const text = classification + '<img src=x onerror=alert(1)> & "纯文本"\n\n保持空行\n末行';
  fs.writeFileSync(path.join(f.directory, 'TAPD.txt'), text, 'utf8');
  const defect = f.load().defects[0];
  await withAdapter(async adapter => {
    await adapter.list(); await adapter.prepare(defect);
    const editor = await adapter.descriptionField();
    assert.equal(await editor.innerText(), text);
    assert.equal(await editor.locator('img').count(), 0);
    const result = await adapter.submit(defect);
    assert.ok(result.bugId); assert.equal(state.creates[0].description, text);
  }, { descriptionEditorId: 'fixtureEditor' });
});
test('可见必填字段缺失时不提交，补齐字段后允许重试', async () => {
  reset({ requireExtra: true }); const f = fixture('必填字段恢复');
  await withAdapter(async adapter => {
    await assert.rejects(submitOne(f.load().defects[0], adapter, f.manifest.review), /必填项缺失/);
    assert.equal(state.creates.length, 0); assert.equal(receipt(f.load().defects[0]).status, 'failed-before-submit');
    f.manifest.defects[0].fields = { '测试类型': '功能测试' }; writeJson(f.manifestFile, f.manifest);
    const result = await submitOne(f.load().defects[0], adapter, f.manifest.review); assert.equal(result.status, 'submitted'); assert.equal(state.creates.length, 1);
  });
});
test('已有同标题缺陷时登记链接，避免再次点击创建', async () => {
  reset(); const f = fixture('远端记录核对'); const defect = f.load().defects[0];
  state.creates.push({ title: defect.title, description: defect.description, files: [{ name: '证据.txt' }], bugId: '1167780910000000001' });
  await withAdapter(async adapter => { const result = await submitOne(defect, adapter, f.manifest.review); assert.equal(result.status, 'already-exists'); assert.equal(state.creates.length, 1); });
});
test('从正文读取分级，忽略发现版本、模块和处理人，字段冲突时拒绝', async () => {
  reset(); const f = fixture('正文字段与延后填写');
  f.manifest.defects[0].fields = { '发现版本': '不得自动填写', '模块': '不得自动填写', '处理人': '不得自动填写' };
  writeJson(f.manifestFile, f.manifest);
  const defect = f.load().defects[0];
  assert.deepEqual(defect.fields, { '优先级': '中', '严重程度': '一般' });
  await withAdapter(async adapter => {
    await submitOne(defect, adapter, f.manifest.review);
    assert.deepEqual([state.creates[0].version, state.creates[0].module, state.creates[0].owner], ['', '', '']);
  });
  f.manifest.defects[0].fields['严重程度'] = '严重'; writeJson(f.manifestFile, f.manifest);
  assert.throws(f.load, /正文不一致/);
  f.manifest.defects[0].fields = {}; writeJson(f.manifestFile, f.manifest);
  fs.writeFileSync(path.join(f.directory, 'TAPD.txt'), '没有分级的缺陷正文');
  assert.throws(f.load, /优先级/);
});
test('项目强制要求延后填写字段时停止，不猜测或提交', async () => {
  reset({ requireDeferred: true }); const f = fixture('延后字段必填阻塞');
  await withAdapter(async adapter => {
    await assert.rejects(submitOne(f.load().defects[0], adapter, f.manifest.review), /发现版本、模块、处理人仍交由用户/);
    assert.equal(state.creates.length, 0);
  });
});
test('只上传正文引用的非图片文件，排除未引用文件及改名图片', async () => {
  reset(); const f = fixture('正文附件筛选');
  for (const name of ['录屏.mp4', '接口.json', '截图.PNG', '插图.svg', '未引用日志.txt']) fs.writeFileSync(path.join(f.directory, name), name);
  fs.writeFileSync(path.join(f.directory, '改名图片.bin'), Buffer.from([137,80,78,71,13,10,26,10,0]));
  fs.appendFileSync(path.join(f.directory, 'TAPD.txt'), '\n- [录屏](录屏.mp4)\n- [接口](接口.json)\n- [截图](截图.PNG)\n- [插图](插图.svg)\n- [图片改名](改名图片.bin)');
  f.manifest.defects[0].attachments = ['模拟授权页面/MOCK-001/未引用日志.txt'];
  writeJson(f.manifestFile, f.manifest);
  const defect = f.load().defects[0];
  assert.deepEqual(defect.attachments.map(a => path.basename(a.path)).sort(), ['接口.json', '录屏.mp4', '证据.txt'].sort());
  await withAdapter(async adapter => {
    await submitOne(defect, adapter, f.manifest.review);
    assert.deepEqual(state.creates[0].files.map(a => a.name).sort(), ['接口.json', '录屏.mp4', '证据.txt'].sort());
  });
  assert.ok(fs.existsSync(path.join(f.directory, '截图.PNG')));
});
test('正文引用缺失文件或其他缺陷文件时停止', () => {
  const f = fixture('正文引用校验');
  fs.appendFileSync(path.join(f.directory, 'TAPD.txt'), '\n[日志](不存在.log)');
  assert.throws(f.load, /文件不存在/);
  const another = path.join(f.root, '模拟授权页面', 'MOCK-002'); fs.mkdirSync(another);
  fs.writeFileSync(path.join(another, '日志.txt'), 'other defect');
  fs.writeFileSync(path.join(f.directory, 'TAPD.txt'), classification + '[日志](../MOCK-002/日志.txt)');
  assert.throws(f.load, /本条缺陷/);
});
test('创建已发生但结果丢失时停止，重跑不重复创建，详情核实可恢复', async () => {
  reset({ mode: 'lost-result' }); const f = fixture('提交中断恢复'); const defect = f.load().defects[0];
  await withAdapter(async adapter => {
    await assert.rejects(submitOne(defect, adapter, f.manifest.review), /禁止直接重试/);
    assert.equal(state.creates.length, 1); assert.equal(receipt(defect).status, 'uncertain');
    await assert.rejects(submitOne(defect, adapter, f.manifest.review), /禁止自动重试/); assert.equal(state.creates.length, 1);
    const url = `${origin}/tapd_fe/67780910/bug/detail/${state.creates[0].bugId}`;
    const verified = await adapter.verifyExisting(defect, url); record(defect, 'submitted', { ...verified, reconciledAt: new Date().toISOString() });
    assert.equal(assertRunnable(defect), false);
  });
});
test('提交截图失败不把已确认成功的缺陷改为可重试', async () => {
  reset(); const f = fixture('截图中断保护'); const defect = f.load().defects[0];
  await withAdapter(async adapter => {
    let calls = 0; const screenshot = adapter.screenshot.bind(adapter);
    adapter.screenshot = async file => { if (++calls === 2) throw new Error('fixture disk error'); return screenshot(file); };
    const result = await submitOne(defect, adapter, f.manifest.review);
    assert.equal(result.status, 'submitted'); assert.equal(receipt(defect).status, 'submitted'); assert.equal(assertRunnable(defect), false);
  });
});
test('登录、选项目、打开表单与创建跨命令复用同一浏览器，完成后显式关闭', async () => {
  reset({ requireLogin: true, popup: true }); const f = fixture('连续浏览器会话');
  const privateDirectory = path.join(f.root, '.local');
  await withAdapter(async adapter => {
    const context = adapter.page.context();
    await context.addCookies([{ name: 'mockauth', value: '1', url: origin }]);
    const environment = { adapter, privateDirectory, root: f.root, runDirectory: path.join(f.root, '运行检查') };
    await executeBrowserCommand({ command: 'login' }, environment);
    await adapter.page.evaluate(() => localStorage.setItem('continuous-session-marker', 'kept'));
    let ready;
    const opened = new Promise(resolve => { ready = resolve; });
    const host = serveBrowserSession(privateDirectory, { isClosed: () => adapter.page.isClosed(), dispatch: command => executeBrowserCommand(command, environment), onReady: ready });
    await opened;
    const session = activeBrowserSession(privateDirectory);
    try {
      const project = await sendBrowserCommand(privateDirectory, { command: 'project', 'project-name': '模拟项目' });
      assert.equal(project.workspaceId, '67780910');
      await sendBrowserCommand(privateDirectory, { command: 'inspect', form: true });
      const submitted = await sendBrowserCommand(privateDirectory, { command: 'submit', manifest: f.manifestFile });
      assert.equal(submitted.results[0].status, 'submitted');
      assert.deepEqual(submitted.results[0].verified, ['title', 'description', 'attachment-names']);
      assert.equal(adapter.page.context(), context);
      assert.equal(await adapter.page.evaluate(() => localStorage.getItem('continuous-session-marker')), 'kept');
      assert.equal(activeBrowserSession(privateDirectory).id, session.id);
      assert.equal(state.visits.filter(url => url === '/cloud_logins/login').length, 1);
      const again = await sendBrowserCommand(privateDirectory, { command: 'submit', manifest: f.manifestFile });
      assert.equal(again.skipped, true); assert.equal(state.creates.length, 1);
    } finally {
      await sendBrowserCommand(privateDirectory, { command: 'close' });
      await host;
    }
    assert.equal(activeBrowserSession(privateDirectory), null);
    await assert.rejects(sendBrowserCommand(privateDirectory, { command: 'inspect' }), /没有运行中的浏览器/);
  });
});
test('详情正文核对失败时不报成功，保留不确定回执并禁止重复创建', async () => {
  reset({ missingDetail: true }); const f = fixture('详情核对失败保护'); const defect = f.load().defects[0];
  await withAdapter(async adapter => {
    await assert.rejects(submitOne(defect, adapter, f.manifest.review), /正文或附件未核对/);
    assert.equal(receipt(defect).status, 'uncertain'); assert.equal(state.creates.length, 1);
    await assert.rejects(submitOne(defect, adapter, f.manifest.review), /禁止自动重试/);
    assert.equal(state.creates.length, 1);
  });
});
test('已有同标题但内容不同的记录不能登记为成功或再次创建', async () => {
  reset(); const f = fixture('同标题内容不匹配'); const defect = f.load().defects[0];
  state.creates.push({ title: defect.title, description: '不同的正文', bugId: '1167780910000000001', files: [] });
  await withAdapter(async adapter => {
    await assert.rejects(submitOne(defect, adapter, f.manifest.review), /正文或附件未核对/);
    assert.equal(receipt(defect).status, 'failed-before-submit'); assert.equal(state.creates.length, 1);
  });
});
test('会话命令串行执行，繁忙时拒绝另一命令，不自动重发', async () => {
  const directory = path.join(testDirectory, '会话并发保护');
  let ready, release;
  const opened = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const host = serveBrowserSession(directory, { isClosed: () => false, onReady: ready, dispatch: async () => { calls++; await gate; return { done: true }; } });
  await opened;
  const pending = sendBrowserCommand(directory, { command: 'inspect' });
  await waitFor(async () => activeBrowserSession(directory)?.status === 'busy', 2000, 'fixture host did not start');
  await assert.rejects(sendBrowserCommand(directory, { command: 'submit' }), /正在执行另一条命令/);
  release(); assert.deepEqual(await pending, { done: true }); assert.equal(calls, 1);
  await sendBrowserCommand(directory, { command: 'close' }); await host;
});
