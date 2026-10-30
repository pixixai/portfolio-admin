import { cp, lstat, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {recoverUserData} from './restore-activation.mjs';

export function legacyDataDirectory(projectRoot, env = process.env) {
  const key = createHash('sha256').update(projectRoot).digest('hex').slice(0, 10);
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'PixixPortfolioAdmin', key);
}
async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Resolve explicit locations unchanged. Only the old default for this checkout
// is migrated; an existing user folder always takes precedence over old data.
export async function resolveRuntimeData(projectRoot, { dataDir, env = process.env, legacyDirectory = legacyDataDirectory(projectRoot, env), onMigration = () => {} } = {}) {
  if (dataDir || env.PORTFOLIO_DATA_DIR) {const directory=path.resolve(dataDir || env.PORTFOLIO_DATA_DIR);await recoverUserData(directory);return directory;}
  const target = path.join(projectRoot, 'user');
  await recoverUserData(target);
  if (await exists(path.join(target, 'portfolio.sqlite'))) return target;
  const targetExists = await exists(target);
  if (targetExists && (await readdir(target)).length) throw new Error('user 文件夹已有内容但缺少 portfolio.sqlite，请先备份并检查完整数据，避免覆盖。');
  const sourceFile = path.join(legacyDirectory, 'portfolio.sqlite');
  if (!await exists(sourceFile)) return target;
  const staging = path.join(projectRoot, '.user-migration-' + randomUUID());
  // Stage alongside the destination so a completed migration appears atomically.
  // No legacy file is removed, and incomplete copies never become active data.
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    const version = () => source.prepare('PRAGMA data_version').get().data_version;
    const before = version();
    await mkdir(staging);
    await cp(legacyDirectory, staging, { recursive: true, filter: async file => {
      const relative = path.relative(legacyDirectory, file);
      if (relative.split(path.sep).includes('node_modules') || /^portfolio\.sqlite(?:-(?:wal|shm|journal))?$/.test(relative)) return false;
      return !(await lstat(file)).isSymbolicLink();
    } });
    // VACUUM INTO captures committed WAL data without copying a live SQLite file.
    source.prepare('VACUUM INTO ?').run(path.join(staging, 'portfolio.sqlite'));
    if (version() !== before) throw new Error('旧后台仍在写入数据，请关闭旧后台窗口后重新启动，原数据已保留。');
    await writeFile(path.join(staging, 'migration.json'), JSON.stringify({ from: legacyDirectory, migratedAt: new Date().toISOString() }, null, 2));
    if (targetExists) await rmdir(target); // Only the previously verified empty directory.
    await rename(staging, target);
  } finally {
    source.close();
    // The generated path must remain a direct child of this project.
    if (path.dirname(staging) === path.resolve(projectRoot) && path.basename(staging).startsWith('.user-migration-')) await rm(staging, { recursive: true, force: true });
  }
  onMigration({ from: legacyDirectory, to: target });
  return target;
}
