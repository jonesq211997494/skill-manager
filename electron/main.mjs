import { app, BrowserWindow, ipcMain, dialog, shell, session, net, safeStorage } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ManagerService } from '../core/service.mjs';
import { serializeError } from '../core/errors.mjs';
import { GitHubAuth } from '../core/github-auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SKILL_MANAGER_DATA_DIR || path.join(app.getPath('appData'),'SkillManagerDesktop');
app.setPath('userData',dataDir);
app.setName('Skill Manager');
let window, manager;
if(!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    const entry=path.resolve(here,'../dist/index.html');
    const devUrl=process.env.SKILL_MANAGER_DEV_URL;
    const allowedUrl=devUrl||pathToFileURL(entry).href;
    if(devUrl && !/^http:\/\/127\.0\.0\.1:5173\/?$/.test(devUrl))throw new Error('仅允许本机开发地址。');
    session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    window=new BrowserWindow({width:1440,height:920,minWidth:860,minHeight:620,show:!process.env.SKILL_MANAGER_TEST,backgroundColor:'#f6f5f2',autoHideMenuBar:true,icon:path.join(here,'../assets/icon.png'),title:'Skill Manager · 技能管理器',webPreferences:{preload:path.join(here,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if(url!==allowedUrl)event.preventDefault();});
    const auth=new GitHubAuth({dataDir,fetchImpl:(url,options)=>net.fetch(url,options),safeStorage,
      onChange:()=>manager?.sources.resetAuthState?.(),getProxy:()=>manager?.store.get('settings','main')?.proxy||''});
    await auth.initialize();
    manager=new ManagerService({dataDir,auth,home:process.env.SKILL_MANAGER_HOME,
      onProgress:event=>{if(!window.isDestroyed())window.webContents.send('manager:progress',event);},
      fetchImpl:(url,options)=>net.fetch(url,options),
      openPath:async p=>{const error=await shell.openPath(p);if(error)throw new Error(error);},
      openExternal:url=>shell.openExternal(url),
      chooseDirectory:async()=>{const result=await dialog.showOpenDialog(window,{title:'选择目录',properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0];},
      chooseFile:async()=>{const result=await dialog.showOpenDialog(window,{title:'选择旧数据库或清单',properties:['openFile'],filters:[{name:'迁移数据',extensions:['db','sqlite','sqlite3','json']}]});return result.canceled?null:result.filePaths[0];},
      onSettings:settings=>session.defaultSession.setProxy(settings.proxy?{proxyRules:settings.proxy}:{mode:'system'})
    });
    await manager.initialize();
    const settings=manager.store.get('settings','main');
    await session.defaultSession.setProxy(settings.proxy?{proxyRules:settings.proxy}:{mode:'system'});
    ipcMain.handle('manager:call',async(event,method,args)=>{
      try {
        if(event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame || !event.senderFrame.url.startsWith(allowedUrl))throw new Error('请求来源无效。');
        if(typeof method!=='string' || method.length>80)throw new Error('请求格式无效。');
        return {ok:true,data:await manager.call(method,args)};
      } catch(error){return {ok:false,error:serializeError(error)};}
    });
    if(devUrl)await window.loadURL(devUrl);else await window.loadFile(entry);
  }).catch(error=>{console.error(error);if(!process.env.SKILL_MANAGER_TEST)dialog.showErrorBox('启动失败',error.message);app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
  app.on('will-quit',()=>manager?.close());
}
