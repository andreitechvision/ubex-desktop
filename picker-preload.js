const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  sources: () => ipcRenderer.invoke('picker:sources'),
  previews: () => ipcRenderer.invoke('picker:previews'),
  choose: (id) => ipcRenderer.send('picker:choose', id),
});
