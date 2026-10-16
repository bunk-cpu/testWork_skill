import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadManifest, inside, readJson, writeJson, assertRunnable, receipt, record, bugIdentity, errorText, validWorkspaceId, submitOne } from './manifest.mjs';
import { manualLogin, confirmedSession } from './login-session.mjs';

export function commandManifest(options, root) {
  if (!options.manifest) return null;
  const file = path.resolve(options.manifest);
  if (!inside(fs.realpathSync(root), fs.realpathSync(file))) throw new Error('缺陷清单必须存放在测试根目录中。');
  const loaded = loadManifest(file, root, { requireApproval: options.command !== 'validate' });
  if (options.fingerprints && JSON.stringify(options.fingerprints) !== JSON.stringify(loaded.defects.map(d => d.fingerprint))) throw new Error('清单或附件在检查后发生变化，未提交；请重新核对材料。');
  return loaded;
}

export async function executeBrowserCommand(options, { adapter, privateDirectory, root, runDirectory }) {
  const output = path.join(runDirectory, `${options.command}_${crypto.randomUUID()}`);
  let activeDefect;
  try {
    if (options.command === 'login') {
      const login = await manualLogin(adapter, privateDirectory, { onReady: () => console.log('当前尚未登录；请用户自行登录后告知“已登录”，代理收到告知后执行 confirm-login。浏览器窗口保持打开。') });
      const result = { mode: login.mode, status: 'login-verified' };
      writeJson(path.join(output, 'result.json'), { ...result, timestamp: new Date().toISOString() });
      return result;
    }
    if (!['project', 'inspect', 'submit', 'reconcile'].includes(options.command)) throw new Error('不支持的浏览器命令。');
    const session = confirmedSession(privateDirectory);
    const loaded = commandManifest(options, root);
    if (options.command === 'submit' && loaded.defects.every(defect => !assertRunnable(defect))) return { skipped: true, results: loaded.defects.map(receipt) };
    let project;
    if (options.command !== 'project') {
      const projectFile = path.join(privateDirectory, 'project-context.json');
      if (!fs.existsSync(projectFile)) throw new Error('请先取得本次项目名称并执行 project。');
      project = readJson(projectFile);
      if (project.sessionId !== session.sessionId) throw new Error('项目属于上一次登录，请按本次项目名称重新核对。');
      const origin = adapter.origin;
      if (!validWorkspaceId(project.workspaceId) || project.listUrl !== `${origin}/tapd_fe/${project.workspaceId}/bug/list` || !project.projectName?.trim()) throw new Error('项目上下文无效，请重新执行 project。');
      if (adapter.workspaceId !== project.workspaceId) throw new Error('运行中的浏览器与项目上下文不一致，请重新核对项目。');
      if (loaded && (loaded.manifest.workspaceId !== project.workspaceId || loaded.manifest.projectName !== project.projectName)) throw new Error('缺陷清单的项目名称和 ID 必须与本次核对的项目一致。');
    }
    // Check the live page; do not revisit login or recreate the browser between steps.
    await adapter.verifyLogin();
    let result;
    if (options.command === 'project') {
      if (!options['project-name']?.trim()) throw new Error('需要本次用户提供的项目名称。');
      result = await adapter.resolveProject(options['project-name'].trim());
      writeJson(path.join(privateDirectory, 'project-context.json'), { ...result, sessionId: session.sessionId, verifiedAt: new Date().toISOString() });
    } else if (options.command === 'inspect') {
      await adapter.list();
      if (options.form) await adapter.openCreate();
      await adapter.inspect(output);
      result = { directory: output };
    } else if (options.command === 'reconcile') {
      const target = loaded.defects.find(defect => defect.id === options.id);
      if (!target || !bugIdentity(options.url, adapter.origin, target.workspaceId)) throw new Error('本地 ID 或目标项目的详情 URL 无效。');
      const previous = receipt(target);
      if (!previous || !['submitting', 'uncertain'].includes(previous.status) || previous.fingerprint !== target.fingerprint) throw new Error('只能核实内容未变、状态为 submitting/uncertain 的缺陷。');
      activeDefect = target;
      const verified = await adapter.verifyCreated(target, options.url);
      writeJson(path.join(target.directory, 'tapd-submission-before-reconcile.json'), previous);
      result = record(target, 'submitted', { ...verified, reconciledAt: new Date().toISOString() });
      await adapter.screenshot(path.join(target.directory, 'tapd-after-reconcile.png')).catch(() => {});
    } else {
      const results = [];
      for (const defect of loaded.defects) {
        activeDefect = defect;
        results.push(await submitOne(defect, adapter, loaded.manifest.review));
      }
      result = { results };
    }
    writeJson(path.join(output, 'result.json'), { command: options.command, status: 'completed', result, timestamp: new Date().toISOString() });
    return result;
  } catch (error) {
    writeJson(path.join(output, 'result.json'), { command: options.command, status: 'blocked', error: errorText(error), defectDirectory: activeDefect?.directory, timestamp: new Date().toISOString() });
    if (options.command !== 'login') await adapter.inspect(output).catch(() => {});
    throw new Error(`${errorText(error)}；诊断位置：${output}`);
  }
}
