import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson, errorText } from './manifest.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessionPath = directory => path.join(directory, 'browser-session.json');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function activeBrowserSession(directory) {
  const file = sessionPath(directory);
  if (!fs.existsSync(file)) return null;
  const session = readJson(file);
  return ['ready', 'busy'].includes(session.status) && alive(session.pid) ? session : null;
}

// One host owns the browser. Clients exchange local files, never reopen its profile.
export async function serveBrowserSession(directory, { isClosed, dispatch, onReady = () => {} }) {
  const session = { id: crypto.randomUUID(), pid: process.pid, status: 'ready', startedAt: new Date().toISOString(), mode: 'headed' };
  const jobs = path.join(directory, 'browser-jobs', session.id);
  fs.mkdirSync(jobs, { recursive: true });
  writeJson(sessionPath(directory), session);
  onReady(session);
  try {
    while (!isClosed()) {
      for (const entry of fs.readdirSync(jobs, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const job = path.join(jobs, entry.name);
        const requestFile = path.join(job, 'request.json');
        const responseFile = path.join(job, 'response.json');
        if (!fs.existsSync(requestFile) || fs.existsSync(responseFile)) continue;
        const request = readJson(requestFile);
        session.status = 'busy'; session.requestId = entry.name; session.command = request.options?.command;
        writeJson(sessionPath(directory), session);
        let result;
        try {
          if (request.sessionId !== session.id || request.id !== entry.name) throw new Error('浏览器请求不属于当前会话。');
          if (Date.now() > request.expiresAt) throw new Error('请求已过期，未执行；请核实任务状态。');
          result = { ok: true, value: request.options.command === 'close' ? { closed: true } : await dispatch(request.options) };
        } catch (error) { result = { ok: false, error: errorText(error) }; }
        writeJson(responseFile, { ...result, requestId: entry.name, finishedAt: new Date().toISOString() });
        if (request.options?.command === 'close') return;
        session.status = 'ready';
        writeJson(sessionPath(directory), session);
      }
      await pause(150);
    }
  } finally {
    session.status = 'closed'; session.endedAt = new Date().toISOString();
    writeJson(sessionPath(directory), session);
  }
}

export async function sendBrowserCommand(directory, options, { timeoutMs = 15 * 60 * 1000 } = {}) {
  const session = activeBrowserSession(directory);
  if (!session) throw new Error('没有运行中的浏览器会话；请先执行 login 并保持该进程与窗口运行。');
  if (session.status === 'busy') throw new Error('浏览器正在执行另一条命令，请等待其结果；不自动重发请求。');
  const lockPath = path.join(directory, 'browser-command.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); fs.writeFileSync(lock, String(process.pid)); }
  catch { throw new Error('已有命令等待浏览器执行，请先核对其结果。'); }
  const id = crypto.randomUUID();
  const job = path.join(directory, 'browser-jobs', session.id, id);
  try {
    writeJson(path.join(job, 'request.json'), { id, sessionId: session.id, options, expiresAt: Date.now() + timeoutMs });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const responseFile = path.join(job, 'response.json');
      if (fs.existsSync(responseFile)) {
        const response = readJson(responseFile);
        if (!response.ok) throw new Error(response.error);
        return response.value;
      }
      if (!alive(session.pid)) throw new Error('浏览器进程已结束；请先核对本地回执和 TAPD 实际记录，禁止盲目重试。');
      if (Date.now() > deadline) throw new Error(`等待浏览器结果超时；请求 ${id} 不会自动重发，请核对回执与实际记录。`);
      await pause(150);
    }
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
