#!/usr/bin/env node
/**
 * FXSimulator 資料庫熱備份（線上、不停服務）。
 *
 * 用 better-sqlite3 的 `.backup()`（SQLite Online Backup API）：會處理 WAL、
 * 取得一致的快照，不會像 `cp` 那樣複製到一半的交易狀態。
 *
 * 產物：`<dest>/fxsim-<UTC ISO>.db.gz`，預設保留最近 14 份。
 *
 * 用法：
 *   node scripts/backup-db.mjs
 *   FXSIM_DB=/path/fxsim.db FXSIM_BACKUP_DIR=/var/backups/fxsim FXSIM_BACKUP_KEEP=14 node scripts/backup-db.mjs
 */

import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dbPath = process.env.FXSIM_DB ?? '/opt/fxsimulator/fxsim.db';
const destDir = process.env.FXSIM_BACKUP_DIR ?? '/var/backups/fxsim';
const keep = Math.max(1, Number(process.env.FXSIM_BACKUP_KEEP ?? 14));

mkdirSync(destDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const tmpPath = join(destDir, `.tmp-${stamp}.db`);
const outPath = join(destDir, `fxsim-${stamp}.db.gz`);

const db = new Database(dbPath);
try {
  await db.backup(tmpPath);
} finally {
  db.close();
}

const raw = readFileSync(tmpPath);
const gz = gzipSync(raw, { level: 9 });
writeFileSync(outPath, gz);
unlinkSync(tmpPath);

// 只保留最近 N 份（檔名帶 UTC 時間，字典序 = 時間序）
const files = readdirSync(destDir)
  .filter((f) => f.startsWith('fxsim-') && f.endsWith('.db.gz'))
  .sort();
for (const f of files.slice(0, Math.max(0, files.length - keep))) {
  unlinkSync(join(destDir, f));
}

const sizeMb = (gz.length / 1024 / 1024).toFixed(2);
console.log(`${new Date().toISOString()} backup ok ${outPath} (${sizeMb} MB gz, raw ${(raw.length / 1024 / 1024).toFixed(2)} MB, keep ${keep})`);

// 簡單自檢：備份檔非空
if (statSync(outPath).size < 1024) {
  console.error('backup file too small, something is wrong');
  process.exit(1);
}
