import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await fs.mkdir(path.join(root,'test-results'),{recursive:true});
const child=spawn(process.execPath,['--test','--test-reporter=spec','--test-reporter-destination=stdout','--test-reporter=junit','--test-reporter-destination=test-results/core-tests.xml','tests/*.test.mjs'],{cwd:root,stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
