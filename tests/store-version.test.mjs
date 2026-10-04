import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Store } from '../core/store.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skillspace-db-version-')));
  const identity = fs.statSync(root, {bigint:true});
  t.after(() => {
    assert.equal(fs.realpathSync(root), root);
    const current = fs.statSync(root, {bigint:true});
    assert.equal(current.ino, identity.ino); assert.equal(current.dev, identity.dev);
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, {recursive:true, force:true});
  });
  return root;
}

test('当前数据库重复启动保持版本与整理记录', t => {
  const root=fixture(t); let store=new Store(root);
  store.put('metadata','skill',{alias:'中文别名',tags:['科研']}); store.close();
  store=new Store(root);
  assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version,1);
  assert.deepEqual(store.get('metadata','skill'),{alias:'中文别名',tags:['科研']}); store.close();
});

for (const version of [2,99]) test(`拒绝过新数据库版本 ${version} 且不改写数据库`, t => {
  const root=fixture(t), file=path.join(root,'index.sqlite');
  const db=new DatabaseSync(file);
  db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (${version});`); db.close();
  const before=fs.readFileSync(file);
  assert.throws(()=>new Store(root), {code:'DATABASE_TOO_NEW'});
  assert.deepEqual(fs.readFileSync(file),before);
});

test('缺失或歧义版本不能被默认写成版本 1', t => {
  const root=fixture(t), file=path.join(root,'index.sqlite');
  const db=new DatabaseSync(file); db.exec('CREATE TABLE unknown (value TEXT)'); db.close();
  assert.throws(()=>new Store(root), {code:'DATABASE_VERSION_INVALID'});
  const db2=new DatabaseSync(file); db2.exec('CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (1),(1)'); db2.close();
  assert.throws(()=>new Store(root), {code:'DATABASE_VERSION_INVALID'});
});

test('非法 JSON 在开放服务前失败且保留原记录', t => {
  const root=fixture(t), file=path.join(root,'index.sqlite');
  const store=new Store(root); store.close();
  const db=new DatabaseSync(file); db.exec("INSERT INTO records VALUES ('metadata','bad','{broken','now')"); db.close();
  const before=fs.readFileSync(file);
  assert.throws(()=>new Store(root), {code:'DATABASE_CONTENT_INVALID'});
  assert.deepEqual(fs.readFileSync(file),before);
});

function snapshotDirectory(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name), stat = fs.statSync(file, {bigint:true});
    return [name, { sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }];
  }));
}

test('过新的 WAL 格式数据库在拒绝时不创建或改写任何源目录旁文件', t => {
  const root=fixture(t), file=path.join(root,'index.sqlite');
  const db=new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (99)');
  db.close();
  assert.deepEqual(fs.readdirSync(root), ['index.sqlite']);
  const before=snapshotDirectory(root);
  assert.throws(()=>new Store(root), {code:'DATABASE_TOO_NEW'});
  assert.deepEqual(snapshotDirectory(root),before);
});

test('仅在 WAL 中提交的新版本同样被拒绝，主库与既有 WAL、SHM 均保持原样', t => {
  const root=fixture(t), file=path.join(root,'index.sqlite');
  const initial=new Store(root); initial.close();
  const db=new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)');
    const mainBefore=fs.readFileSync(file);
    db.exec('UPDATE schema_version SET version=99');
    assert.deepEqual(fs.readFileSync(file),mainBefore);
    assert.ok(fs.statSync(`${file}-wal`).size>0);
    const before=snapshotDirectory(root);
    assert.throws(()=>new Store(root), {code:'DATABASE_TOO_NEW'});
    assert.deepEqual(snapshotDirectory(root),before);
  } finally { db.close(); }
});

test('仅在 WAL 中提交的非法 JSON 也不能绕过启动记录检查', t => {
  const root=fixture(t), file=path.join(root,'index.sqlite');
  const initial=new Store(root); initial.close();
  const db=new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)');
    const mainBefore=fs.readFileSync(file);
    db.exec("INSERT INTO records VALUES ('metadata','wal-bad','{broken','now')");
    assert.deepEqual(fs.readFileSync(file),mainBefore);
    const before=snapshotDirectory(root);
    assert.throws(()=>new Store(root), {code:'DATABASE_CONTENT_INVALID'});
    assert.deepEqual(snapshotDirectory(root),before);
  } finally { db.close(); }
});

test('复制探测期间源文件变化时停止开放数据库，并清理确权的临时副本', t => {
  const root=fixture(t), file=path.join(root,'index.sqlite');
  const initial=new Store(root); initial.close();
  const originalCopy=fs.copyFileSync, copies=[];
  t.mock.method(fs,'copyFileSync',(from,to,flags)=>{
    originalCopy(from,to,flags); copies.push(path.dirname(to));
    if(from===file)fs.utimesSync(file,new Date(),new Date(Date.now()+2000));
  });
  assert.throws(()=>new Store(root), {code:'DATABASE_CHANGED'});
  assert.ok(copies.length>0);
  for(const directory of copies)assert.equal(fs.existsSync(directory),false);
});
