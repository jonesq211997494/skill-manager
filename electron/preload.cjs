const { contextBridge, ipcRenderer } = require('electron');

// 只暴露固定消息通道，不向网页开放文件系统或任意 IPC。
contextBridge.exposeInMainWorld('manager', {
  async call(method, args = {}) {
    const response = await ipcRenderer.invoke('manager:call', method, args);
    // contextBridge 传递 Error 时会丢弃自定义字段，使用普通对象保留错误码与恢复时间。
    if (!response.ok) return { ok: false, error: response.error };
    return response.data;
  },
  onProgress(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('manager:progress', listener);
    return () => ipcRenderer.removeListener('manager:progress', listener);
  }
});
