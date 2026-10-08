import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageChecksums } from '../scripts/package-checksums.mjs';

test('交付清单限定当前版本，缺少成品或内容被修改时不能通过校验', async t=>{
  const base=await fs.realpath(os.tmpdir());
  const directory=await fs.mkdtemp(path.join(base,'skill-manager-checksums-'));
  t.after(async()=>{
    assert.equal(path.dirname(directory),base);
    assert.ok(path.basename(directory).startsWith('skill-manager-checksums-'));
    await fs.rm(directory,{recursive:true,force:true});
  });
  const portable=path.join(directory,'Skill-Manager-1.2.3-portable.exe');
  await fs.writeFile(portable,'便携包');
  await fs.writeFile(path.join(directory,'Skill-Manager-1.2.2-setup-x64.exe'),'旧安装包');
  await assert.rejects(packageChecksums(directory,'1.2.3'),{code:'ENOENT'});
  await fs.writeFile(path.join(directory,'Skill-Manager-1.2.3-setup-x64.exe'),'安装包');
  const manifest=await packageChecksums(directory,'1.2.3');
  assert.equal((await fs.readFile(manifest,'utf8')).trim().split('\n').length,2);
  await packageChecksums(directory,'1.2.3',{verify:true});
  await fs.appendFile(portable,'修改');
  await assert.rejects(packageChecksums(directory,'1.2.3',{verify:true}),/校验失败/);
});
