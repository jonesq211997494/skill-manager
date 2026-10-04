import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { previewMigration, importMigration } from '../core/migration.mjs';
import { Store } from '../core/store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-migration-test-'));
  const close = [];
  t.after(async () => {
    for (const db of close.reverse()) db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, close };
}

test('只读事务包含未检查点 WAL 中已提交记录，排除未提交修改', async t => {
  const { root, close } = await fixture(t);
  const file = path.join(root, 'skills-manager.db');
  const writer = new DatabaseSync(file);
  close.push(writer);
  writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE skills(id TEXT PRIMARY KEY,name TEXT,path TEXT,command TEXT);
    CREATE TABLE discovered_skills(id TEXT PRIMARY KEY,name TEXT,path TEXT);
    CREATE TABLE skill_targets(id TEXT PRIMARY KEY,path TEXT,tool TEXT);`);
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  writer.exec('BEGIN IMMEDIATE');
  writer.prepare('INSERT INTO skills VALUES(?,?,?,?)').run('old-1', 'committed skill', root, 'never execute this field');
  writer.prepare('INSERT INTO discovered_skills VALUES(?,?,?)').run('found-1', 'committed skill', root);
  writer.prepare('INSERT INTO skill_targets VALUES(?,?,?)').run('target-1', root, 'codex');
  writer.exec('COMMIT');
  assert.ok((await fs.stat(file + '-wal')).size > 0);
  const originalDb = await fs.readFile(file);
  const originalWal = await fs.readFile(file + '-wal');
  writer.exec('BEGIN IMMEDIATE');
  writer.prepare('INSERT INTO skills VALUES(?,?,?,?)').run('uncommitted', 'not visible', root, '');
  const report = await previewMigration(file);
  assert.equal(report.readOnly, true);
  assert.equal(report.records.length, 3);
  assert.deepEqual(report.records.map(row => row.table).sort(), ['discovered_skills', 'skill_targets', 'skills']);
  assert.equal(report.records.some(row => row.data.id === 'uncommitted'), false);
  const skill = report.records.find(row => row.table === 'skills');
  assert.equal(skill.data.name, 'committed skill');
  assert.equal('command' in skill.data, false);
  assert.ok(skill.unknownFields.includes('command'));
  assert.match(report.files[0].method, /WAL/);
  writer.exec('ROLLBACK');
  assert.deepEqual(await fs.readFile(file), originalDb);
  assert.deepEqual(await fs.readFile(file + '-wal'), originalWal);
  assert.equal(writer.prepare('SELECT count(*) AS n FROM skills').get().n, 1);
});

test('历史会话只登记过期证据，不更改当前会话与停用状态', async t => {
  const { root, close } = await fixture(t);
  const skillPath = path.join(root, 'existing-skill');
  await fs.mkdir(skillPath);
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), 'local custom content');
  const file = path.join(root, 'session_snapshot.json');
  const captured = '2025-01-01T12:00:00Z';
  await fs.writeFile(file, JSON.stringify({ captured_at: captured, skills: [
    { name: 'existing-skill', path: path.join(skillPath, 'SKILL.md') },
    { name: 'missing-skill', path: path.join(root, 'historical-missing') },
  ] }));
  const store = new Store(path.join(root, 'new-manager'));
  close.push(store);
  const current = { id: 'skill-current', physicalPath: skillPath, name: 'existing-skill', sessionEvidence: 'none', configState: 'disabled' };
  store.put('skills', current.id, current);
  const report = await previewMigration(file);
  const result = await importMigration(report, store);
  assert.equal(result.summary.historical, 2);
  assert.equal(result.summary.matched, 1);
  assert.deepEqual(store.get('skills', current.id), current);
  assert.equal(store.all('skills').length, 1);
  const observations = store.all('observations');
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], { skillId: current.id, dimension: 'historical-session', capturedAt: captured, source: file, value: 'expired' });
  assert.equal(await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8'), 'local custom content');
});

test('相同迁移输入反复预览和导入保持幂等，并保留已编辑管理元数据', async t => {
  const { root, close } = await fixture(t);
  const skillPath = path.join(root, 'existing-skill');
  await fs.mkdir(skillPath);
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), 'immutable fixture');
  const file = path.join(root, 'skills_inventory.json');
  await fs.writeFile(file, JSON.stringify({ generated_at: '2025-01-01', skills: [{ name: 'existing-skill', path: skillPath, alias: '旧别名', category: '旧分类' }] }));
  const store = new Store(path.join(root, 'new-manager'));
  close.push(store);
  store.put('skills', 'skill-1', { id: 'skill-1', physicalPath: skillPath, name: 'existing-skill' });
  store.put('metadata', 'skill-1', { alias: '新的自定义别名', tags: ['用户标签'], favorite: true });
  const original = store.get('metadata', 'skill-1');
  const firstPreview = await previewMigration(file);
  const secondPreview = await previewMigration(file);
  assert.equal(firstPreview.id, secondPreview.id);
  const first = await importMigration(firstPreview, store);
  const second = await importMigration(secondPreview, store);
  assert.equal(first.summary.matched, 1);
  assert.equal(second.alreadyImported, true);
  assert.equal(second.importedAt, first.importedAt);
  assert.equal(store.all('migrations').length, 1);
  assert.equal(store.all('skills').length, 1);
  assert.deepEqual(store.get('metadata', 'skill-1'), original);
});
