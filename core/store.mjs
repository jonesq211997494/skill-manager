import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// 数据库只保存本程序的索引和日志，不写旧管理器数据库。
export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir, {recursive: true});
    this.db = new DatabaseSync(path.join(dataDir, 'index.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(collection,id));
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES (1);`);
  }
  get(collection, id, fallback = null) {
    const row = this.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection, id);
    return row ? JSON.parse(row.data) : fallback;
  }
  all(collection) {
    return this.db.prepare('SELECT data FROM records WHERE collection=? ORDER BY id').all(collection).map(r => JSON.parse(r.data));
  }
  put(collection, id, value) {
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(collection, id, JSON.stringify(value), new Date().toISOString());
    return value;
  }
  delete(collection, id) { this.db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(collection,id); }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = callback(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
