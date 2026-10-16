#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, assertRunnable, receipt, errorText } from './manifest.mjs';
import { openBrowser } from './tapd-browser.mjs';
import { confirmLogin } from './login-session.mjs';
import { activeBrowserSession, serveBrowserSession, sendBrowserCommand } from './browser-session.mjs';
import { commandManifest, executeBrowserCommand } from './tapd-commands.mjs';
import { allocateResults } from './result-paths.mjs';

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(skillDirectory, '../../..');
const privateDirectory = path.join(skillDirectory, '.local');
const help = `资源中心测试 / TAPD 浏览器自动化
用法：node scripts/tapd.mjs <命令> [参数]

login                                          启动并保留带窗口的 Chrome，已有登录则跳过人工登录
confirm-login --source-file <用户告知记录.txt>    用户手动登录并告知后，通知现有窗口核对
project   --project-name <本次项目名称>          在同一运行中的浏览器核对项目
inspect   [--form]                              检查当前项目；--form 打开空白创建表单
validate  --manifest <清单.json>                 只检查本地材料，不访问 TAPD
submit    --manifest <清单.json>                 同一窗口创建并核对已审核清单
reconcile --manifest <清单.json> --id <本地ID> --url <详情URL>
                                               核对结果不确定的已有记录
status                                         查看浏览器会话状态
close                                          完成本轮操作后关闭浏览器会话

测试根目录：${root}
保持 login 进程与浏览器运行；project / inspect / submit 由后续命令连接同一会话。
只在取得有效详情 ID，并核对标题、正文与附件后登记成功；结果不确定时不自动重试。
`;
function argumentsFor(argv) {
  const command = argv.shift();
  if (!command || ['--help', '-h'].includes(command)) return { command: 'help' };
  if (!['validate', 'submit', 'login', 'confirm-login', 'project', 'inspect', 'reconcile', 'status', 'close'].includes(command)) throw new Error('未知命令；使用 --help 查看。');
  const options = { command };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (['--headed', '--manual', '--form'].includes(flag)) options[flag.slice(2)] = true;
    else if (['--manifest', '--id', '--url', '--source-file', '--project-name'].includes(flag) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[flag.slice(2)] = argv[++index];
    else throw new Error(`未知参数或缺少值：${flag}`);
  }
  if (['validate', 'submit', 'reconcile'].includes(command) && !options.manifest) throw new Error('需要 --manifest 指定缺陷清单。');
  if (command === 'reconcile' && (!options.id || !options.url)) throw new Error('reconcile 需要 --id 和 --url。');
  if (command === 'confirm-login' && !options['source-file']) throw new Error('需要记录用户已登录告知的真实来源。');
  if (command === 'project' && !options['project-name']?.trim()) throw new Error('需要本次用户提供的项目名称。');
  if (options.form && command !== 'inspect') throw new Error('--form 仅用于 inspect。');
  if (options.manifest) options.manifest = path.resolve(options.manifest);
  return options;
}
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.command === 'help') { console.log(help); return; }
  if (options.command === 'status') { console.log(JSON.stringify(activeBrowserSession(privateDirectory) || { status: 'closed' }, null, 2)); return; }
  if (options.command === 'confirm-login') {
    confirmLogin(privateDirectory, fs.readFileSync(path.resolve(options['source-file']), 'utf8').replace(/^\uFEFF/, ''));
    console.log('已通知现有窗口核对登录；等待会话就绪提示，不关闭 login 进程。'); return;
  }
  const loaded = commandManifest(options, root);
  if (options.command === 'validate') {
    console.log(JSON.stringify({ valid: true, authorized: loaded.manifest.review?.approved === true, defects: loaded.defects.map(d => ({ id: d.id, page: d.page, title: d.title, fields: d.fields, attachments: d.attachments.map(a => a.path), fingerprint: d.fingerprint })) }, null, 2)); return;
  }
  if (options.command === 'submit' && loaded.defects.every(defect => !assertRunnable(defect))) {
    console.log(JSON.stringify({ skipped: true, results: loaded.defects.map(receipt) }, null, 2)); return;
  }
  if (loaded) options.fingerprints = loaded.defects.map(d => d.fingerprint);
  const live = activeBrowserSession(privateDirectory);
  if (options.command !== 'login' || live) {
    const result = await sendBrowserCommand(privateDirectory, options);
    console.log(JSON.stringify(result, null, 2)); return;
  }
  const config = readJson(path.join(skillDirectory, 'config.json'));
  if (config.loginUrl !== 'https://www.tapd.cn/cloud_logins/login') throw new Error('登录入口必须为用户指定的固定地址。');
  fs.mkdirSync(privateDirectory, { recursive: true });
  const lockPath = path.join(privateDirectory, 'run.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); fs.writeFileSync(lock, String(process.pid)); }
  catch { throw new Error('已有浏览器运行锁；请先核对原进程，不能同时打开同一浏览器配置。'); }
  let context;
  try {
    const runDirectory = allocateResults(skillDirectory, 'TAPD连续会话验证').outputDirectory;
    const opened = await openBrowser(skillDirectory, config);
    context = opened.context;
    const environment = { adapter: opened.adapter, privateDirectory, root, runDirectory };
    const login = await executeBrowserCommand({ command: 'login' }, environment);
    console.log(login.mode === 'existing-session' ? '检测到有效登录，已跳过手动登录。' : '用户告知与登录状态已核对。');
    await serveBrowserSession(privateDirectory, {
      isClosed: () => opened.adapter.page.isClosed(),
      dispatch: request => executeBrowserCommand(request, environment),
      onReady: () => console.log(`浏览器会话已就绪，保持同一 Chrome 窗口和本进程运行。后续使用 project / inspect / submit；本轮结束后执行 close。诊断目录：${runDirectory}`),
    });
  } finally {
    try { if (context) await context.close(); }
    finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
  }
}
main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
