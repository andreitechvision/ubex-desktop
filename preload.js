// Tells Ubex Chat (the web app) it is running inside the desktop app, so it can hide what only makes
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
  // A Google Meet link in a window of the desktop app's own (1.4.0 on), instead of the browser.
  // The web app checks for this before using it (shared/meet-window.js).
  openGoogleMeet: (url) => ipcRenderer.send('ubex:open-meet', String(url || '')),
  // Google Meet INSIDE the app's window (1.5.0 on): the web app may show it in a <webview>, which
  // the main process allows for a Google Meet link only (Meet/GoogleMeetDock.jsx).
  embedGoogleMeet: true,
  // Meet links clicked in the page come back here instead of opening a window (1.5.0 on).
  onMeetLink: (callback) => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on('ubex:meet-link', listener);
    ipcRenderer.send('ubex:meet-links');
    return () => ipcRenderer.removeListener('ubex:meet-link', listener);
  },
  // Notifications (1.3.1 on): bring this window to the front (a system notification was
  // clicked), and highlight it in the taskbar until it is focused (a message arrived).
  focus: () => ipcRenderer.send('ubex:focus'),
  attention: () => ipcRenderer.send('ubex:attention'),
  // A system notification shown by the desktop app itself (1.3.2 on), so that clicking it can
  // bring the window forward on Wayland. `onNotificationClick` gets the `id` back.
  // `icon` (1.3.3 on): the organization's picture URL, or '' for the app's icon.
  notify: ({ id, title, body, tag, icon }) => ipcRenderer.send('ubex:notify', { id, title, body, tag, icon: typeof icon === 'string' ? icon : '' }),
  onNotificationClick: (callback) => {
    const listener = (_event, id) => callback(id);
    ipcRenderer.on('ubex:notification-click', listener);
    return () => ipcRenderer.removeListener('ubex:notification-click', listener);
  },
  // The zoom level in percent, each time Ctrl + / - / 0 or Ctrl + wheel changes it (1.2.0 on).
  onZoom: (callback) => {
    const listener = (_event, percent) => callback(percent);
    ipcRenderer.on('ubex:zoom', listener);
    return () => ipcRenderer.removeListener('ubex:zoom', listener);
  },
});
