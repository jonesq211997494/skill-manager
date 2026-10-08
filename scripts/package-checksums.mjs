import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function packageChecksums(directory, version, { verify = false } = {}) {
  if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))throw new Error('无效的应用版本。');
  const names=[`Skill-Manager-${version}-portable.exe`,`Skill-Manager-${version}-setup-x64.exe`];
  const lines=[];
  // 只处理当前版本的两个成品，避免把目录中的旧安装器混入交付清单。
  for(const name of names) {
    const filename=path.join(directory,name);
    const stat=await fs.stat(filename);
    if(!stat.isFile() || stat.size===0)throw new Error(`安装包为空或不是文件：${name}`);
    const digest=createHash('sha256');
    for await(const chunk of createReadStream(filename))digest.update(chunk);
    lines.push(`${digest.digest('hex')}  ${name}`);
  }
  const content=lines.join('\n')+'\n';
  const filename=path.join(directory,`SHA256SUMS-${version}.txt`);
  if(verify) {
    if(await fs.readFile(filename,'utf8')!==content)throw new Error('安装包校验失败：文件在生成校验清单后发生变化。');
  } else await fs.writeFile(filename,content);
  return filename;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const verify=process.argv.includes('--verify');
  const filename=await packageChecksums(path.join(root,'release'),pkg.version,{verify});
  console.log(`${verify?'已核验':'已生成'}安装包 SHA-256：${path.basename(filename)}`);
}
