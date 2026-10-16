import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inside, readJson, writeJson } from './manifest.mjs';

export function allocateResults(skillDirectory, batch) {
  const root = path.resolve(skillDirectory, '../../..');
  const result = JSON.parse(execFileSync('python', ['-X', 'utf8', path.join(skillDirectory, 'scripts/result_paths.py'), '--mode', 'retest', '--batch', batch, '--page', 'TAPD自动化'], { encoding: 'utf8' }));
  // The current conversation's AGENTS.md puts retests directly under the workspace.
  // Preserve the allocator's actual start time even when its shared classification changes.
  const components = result.resultBase.replaceAll('\\', '/').split('/');
  const relative = components.slice(-3).join('/');
  if (!/^回测结果\/\d{4}-\d{2}-\d{2}\//.test(relative)) throw new Error('结果分配工具未返回有效回测批次。');
  const target = path.resolve(root, relative);
  const source = path.resolve(result.resultDirectory);
  if (!inside(root, source) || !inside(root, target)) throw new Error('结果目录越过工作区。');
  if (source !== target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) throw new Error('回测目标批次已存在，未覆盖。');
    fs.renameSync(source, target);
    const metadata = path.join(target, '回测批次.json');
    writeJson(metadata, { ...readJson(metadata), resultBase: relative, outputRule: '当前会话 AGENTS.md：根目录回测结果' });
  }
  return { resultBase: relative, resultDirectory: target, outputDirectory: path.join(target, 'TAPD自动化') };
}
