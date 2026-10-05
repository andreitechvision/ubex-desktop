// Tells the web app it is running inside the desktop app, so it can hide what only makes
// sense in a browser (the rail's download button) and show the update banner.
//
// The update calls exist from 1.1.0 on; the web app checks for them before using them,
// because a 1.0.0 install only has `platform` and `version`.
const { contextBridge, ipcRenderer } = require('electron');

const versionArg = process.argv.find((a) => a.startsWith('--ubex-version='));

contextBridge.exposeInMainWorld('ubexDesktop', {
  platform: process.platform,
  version: versionArg ? versionArg.slice('--ubex-version='.length) : '',
  // { state: 'idle' | 'downloading' | 'ready' | 'error', version, percent }
  getUpdate: () => ipcRenderer.invoke('ubex:update-state'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('ubex:update', listener);
    return () => ipcRenderer.removeListener('ubex:update', listener);
  },
  installUpdate: () => ipcRenderer.send('ubex:update-install'),
  // The zoom level in percent, each time Ctrl + / - / 0 or Ctrl + wheel changes it (1.2.0 on).
  onZoom: (callback) => {
    const listener = (_event, percent) => callback(percent);
    ipcRenderer.on('ubex:zoom', listener);
    return () => ipcRenderer.removeListener('ubex:zoom', listener);
  },
});
