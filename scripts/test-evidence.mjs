import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(root,'test-results');
await fs.mkdir(directory,{recursive:true});
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const report={appVersion:pkg.version,commit:git('rev-parse','HEAD'),worktreeModified:!!git('status','--porcelain'),node:process.version,platform:process.platform,arch:process.arch,checkedAt:new Date().toISOString(),workflowRun:process.env.GITHUB_RUN_ID||null,results:[]};
// 只处理已知隔离测试报告，路径替换同时覆盖 JSON 转义和 URL 编码形式。
const privatePaths=[[root,'[workspace]'],[os.tmpdir(),'[temporary]'],[os.homedir(),'[home]']];
for(const name of ['core-tests.xml','desktop-smoke.json','security-smoke.json','operation-result-ui.json','ui-flow.json','improvements-ui-smoke.json','ui-state-smoke.json','package-smoke.json','portable-smoke.json']) {
  const filename=path.join(directory,name);
  let content;
  try {content=await fs.readFile(filename,'utf8');} catch(error) {if(error.code==='ENOENT')continue;throw error;}
  for(const [value,replacement] of privatePaths) {
    const forms=[value,value.replaceAll('\\','/'),JSON.stringify(value).slice(1,-1),encodeURI(value.replaceAll('\\','/'))];
    for(const form of forms) content=content.split(form).join(replacement);
  }
  // 发现常见凭据或认证头时停止证据整理，不尝试静默掩盖。
  if(/(?:Bearer\s+[A-Za-z0-9_\-.]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/i.test(content))throw new Error('报告包含疑似凭据，禁止上传：'+name);
  await fs.writeFile(filename,content);
  report.results.push(name);
}
await fs.writeFile(path.join(directory,'environment.json'),JSON.stringify(report,null,2));
console.log('测试报告已脱敏并关联版本、提交与运行环境。');
