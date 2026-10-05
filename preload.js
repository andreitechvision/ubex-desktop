// Tells the web app it is running inside the desktop app, so it can hide what only makes
// sense in a browser (the "Get the desktop app" button on the rail).
const { contextBridge } = require('electron');

const versionArg = process.argv.find((a) => a.startsWith('--ubex-version='));

contextBridge.exposeInMainWorld('ubexDesktop', {
  platform: process.platform,
  version: versionArg ? versionArg.slice('--ubex-version='.length) : '',
});
