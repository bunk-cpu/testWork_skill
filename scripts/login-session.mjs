import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson } from './manifest.mjs';

const sessionFile = directory => path.join(directory, 'login-session.json');
const confirmationFile = directory => path.join(directory, 'login-confirmation.json');
export function confirmLogin(directory, source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('需要记录用户在当前会话明确告知“已登录”的真实来源。');
  const session = readJson(sessionFile(directory));
  if (session.status !== 'waiting-for-user') throw new Error('没有等待用户告知的登录窗口，请先启动 login。');
  try { process.kill(session.pid, 0); } catch { throw new Error('登录窗口进程已结束，请重新启动 login。'); }
  writeJson(confirmationFile(directory), { sessionId: session.sessionId, source: source.trim(), confirmedAt: new Date().toISOString() });
}
export function confirmedSession(directory) {
  const file = sessionFile(directory);
  if (!fs.existsSync(file)) throw new Error('请先启动 login 检查已有登录状态；未登录时由用户完成登录并告知。');
  const session = readJson(file);
  if (session.status !== 'confirmed' || !session.source) throw new Error('尚未完成实际登录状态核对。');
  return session;
}
export async function manualLogin(adapter, directory, { onReady = () => {} } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const session = { sessionId: crypto.randomUUID(), pid: process.pid, status: 'waiting-for-user', startedAt: new Date().toISOString() };
  writeJson(sessionFile(directory), session);
  try {
    await adapter.openLogin();
    if (await adapter.detectLogin() === 'authenticated') {
      const result = { ...session, status: 'confirmed', mode: 'existing-session', source: 'browser:verified-existing-session', verifiedAt: new Date().toISOString() };
      writeJson(sessionFile(directory), result);
      return result;
    }
    onReady(session);
    let handledConfirmation;
    for (;;) {
      if (adapter.page.isClosed()) throw new Error('登录窗口已关闭，尚未取得用户告知并核对登录状态。');
      const file = confirmationFile(directory);
      const confirmation = fs.existsSync(file) ? readJson(file) : null;
      if (confirmation?.sessionId === session.sessionId && confirmation.confirmedAt !== handledConfirmation) {
        handledConfirmation = confirmation.confirmedAt;
        try {
          await adapter.verifyLogin();
          const result = { ...session, status: 'confirmed', mode: 'manual-login', source: confirmation.source, confirmedAt: confirmation.confirmedAt, verifiedAt: new Date().toISOString() };
          writeJson(sessionFile(directory), result);
          return result;
        } catch (error) {
          if (adapter.page.isClosed() || /拦截/.test(error.message)) throw error;
          console.log('用户已告知登录，但页面尚未确认成功；保留窗口，完成后请再次告知。');
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    writeJson(sessionFile(directory), { ...session, status: 'interrupted', endedAt: new Date().toISOString() });
    throw error;
  }
}
