import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const executable=require('electron');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(executable,['.'],{stdio:'inherit',env,windowsHide:true});
child.on('exit',code=>process.exit(code||0));
