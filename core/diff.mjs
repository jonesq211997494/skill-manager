import fs from 'node:fs/promises';
import path from 'node:path';
import { inside } from './operations.mjs';
import { fail } from './errors.mjs';

// 差异预览只读取已登记版本内的文件，文本有大小上限。
export async function readRevisionFile(root,relativePath,manifest) {
  if(!root) return {missing:true};
  if(typeof relativePath!=='string' || path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').some(p=>['.','..',''].includes(p))) fail('INVALID_PATH','差异文件路径无效。');
  const target=path.resolve(root,relativePath);
  if(!inside(root,target)) fail('INVALID_PATH','文件不在技能包中。');
  const entry=manifest?.files.find(f=>f.path===relativePath);
  try {
    const realRoot=await fs.realpath(root), real=await fs.realpath(target);
    if(!inside(realRoot,real) || (await fs.lstat(target)).isSymbolicLink())fail('INVALID_PATH','不预览包外引用或链接。');
    const stat=await fs.stat(target);
    if(!stat.isFile())return {binary:true,hash:entry?.hash};
    if(stat.size>512*1024)return {binary:true,size:stat.size,hash:entry?.hash,reason:'文件超过512KB文本预览限制'};
    const bytes=await fs.readFile(target);
    if(bytes.includes(0))return {binary:true,size:bytes.length,hash:entry?.hash};
    return {text:bytes.toString('utf8'),size:bytes.length,hash:entry?.hash};
  } catch(e) {if(e.code==='ENOENT')return {missing:true};throw e;}
}
