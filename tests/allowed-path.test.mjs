import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAllowedOpenPath } from '../core/allowed-path.mjs';

test('打开路径同时核验物理边界，不能沿目录链接访问未登记区域', async t => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'skillspace-open-path-')));
  const identity=await fs.stat(root,{bigint:true});
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);
    assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));
    const current=await fs.stat(root,{bigint:true});
    assert.equal(current.ino,identity.ino); assert.equal(current.dev,identity.dev);
    await fs.rm(root,{recursive:true,force:true});
  });
  const allowed=path.join(root,'allowed'),outside=path.join(root,'outside');
  await fs.mkdir(allowed); await fs.mkdir(outside);
  await fs.writeFile(path.join(allowed,'SKILL.md'),'# 测试');
  await fs.writeFile(path.join(outside,'SKILL.md'),'# 范围外');
  await fs.writeFile(path.join(allowed,'run.exe'),'fixture');
  assert.equal(await resolveAllowedOpenPath(path.join(allowed,'SKILL.md'),[allowed]),path.join(allowed,'SKILL.md'));
  await assert.rejects(resolveAllowedOpenPath(path.join(allowed,'run.exe'),[allowed]),{code:'INVALID_PATH'});
  await assert.rejects(resolveAllowedOpenPath(outside,[allowed]),{code:'INVALID_PATH'});
  const link=path.join(allowed,'linked');
  await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(resolveAllowedOpenPath(path.join(link,'SKILL.md'),[allowed]),{code:'INVALID_PATH'});
  // 用户明确登记该入口后，可访问它的真实根目录。
  assert.equal(await resolveAllowedOpenPath(path.join(link,'SKILL.md'),[link]),path.join(outside,'SKILL.md'));
  assert.equal(await resolveAllowedOpenPath(outside,[link]),outside);
  assert.equal(await resolveAllowedOpenPath(path.join(outside,'SKILL.md'),[link]),path.join(outside,'SKILL.md'));
  const nestedEscape=path.join(outside,'escape');
  await fs.symlink(allowed,nestedEscape,process.platform==='win32'?'junction':'dir');
  await assert.rejects(resolveAllowedOpenPath(path.join(nestedEscape,'SKILL.md'),[link]),{code:'INVALID_PATH'});
});
