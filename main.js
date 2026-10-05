// Ubex Chat for the desktop: a window around the live app at chat.ubex.ai.
//
// The interface is not bundled here. It is the same site the browser loads, so every deploy
// reaches the desktop app at once and there is no second copy of the frontend to keep in
// step. This file only adds what a browser tab gives for free and Electron does not: the
// permission prompts (mic, camera, notifications), a screen-share picker, opening outside
// links in the real browser, a right-click menu in text fields, zoom, and updates of the shell.

const { app, BrowserWindow, Menu, desktopCapturer, ipcMain, nativeTheme, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_URL = 'https://chat.ubex.ai';
const APP_ORIGIN = new URL(APP_URL).origin;

// What the web app may ask for. Anything else (USB, serial, geolocation, …) is refused.
const ALLOWED_PERMISSIONS = new Set([
  'media',
  'display-capture',
  'notifications',
  'fullscreen',
  'clipboard-read',
  'clipboard-sanitized-write',
  'speaker-selection',
]);

function isAppUrl(url) {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch (e) {
    return false;
  }
}

// ubex-chat://meet/abc → https://chat.ubex.ai/meet/abc, so a link from an email or the browser
// can open straight in the app. Not ubex://, which belongs to the separate Ubex app.
function appUrlFromArgs(argv) {
  const link = (argv || []).find((a) => typeof a === 'string' && a.startsWith('ubex-chat://'));
  if (!link) return null;
  const rest = link.slice('ubex-chat://'.length).replace(/^\/+/, '');
  return APP_URL + '/' + rest;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow = null;

  // Windows groups notifications under this id; without it they are shown as "electron.app".
  if (process.platform === 'win32') app.setAppUserModelId('ai.ubex.chat');
  if (!app.isDefaultProtocolClient('ubex-chat')) app.setAsDefaultProtocolClient('ubex-chat');

  const background = () => (nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff');

  // ── Zoom ─────────────────────────────────────────────────────────────────────────────
  // What browser zoom is in a tab: Ctrl + / Ctrl - / Ctrl 0 and Ctrl + mouse wheel, in the
  // browser's own steps. Saved on THIS computer (userData/settings.json), not the account,
  // so making the desktop app bigger leaves the web app as it is — the account-wide
  // "Interface size" setting is the one that follows you everywhere. One level for every
  // Ubex window, so a meeting opened in its own window matches the main one.
  const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

  function readSettings() {
    try {
      return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {};
    } catch (e) {
      return {};
    }
  }

  function writeSettings(patch) {
    try {
      fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }));
    } catch (e) {}
  }

  let zoom = ZOOM_STEPS.indexOf(readSettings().zoom) !== -1 ? readSettings().zoom : 1;

  function applyZoom(contents) {
    if (contents && !contents.isDestroyed()) contents.setZoomFactor(zoom);
  }

  // direction: 1 bigger, -1 smaller, 0 back to 100%.
  function stepZoom(direction) {
    const i = ZOOM_STEPS.indexOf(zoom);
    const next = direction === 0 ? 1 : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i === -1 ? 5 : i) + direction))];
    zoom = next;
    writeSettings({ zoom });
    BrowserWindow.getAllWindows().forEach((w) => {
      applyZoom(w.webContents);
      if (!w.isDestroyed()) w.webContents.send('ubex:zoom', Math.round(zoom * 100));
    });
  }

  function zoomKey(input) {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null;
    if (input.key === '+' || input.key === '=' || input.code === 'NumpadAdd') return 1;
    if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return -1;
    if (input.key === '0' || input.code === 'Numpad0') return 0;
    return null;
  }

  function createWindow(startUrl) {
    const win = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: 'Ubex Chat',
      autoHideMenuBar: true,
      backgroundColor: background(),
      icon: path.join(__dirname, 'build/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
        additionalArguments: ['--ubex-version=' + app.getVersion()],
      },
    });
    win.once('ready-to-show', () => win.show());
    wireContents(win.webContents);
    win.loadURL(startUrl || APP_URL);
    return win;
  }

  // Ubex Chat links stay in the app (a meeting or board opened in a new tab gets its own window);
  // everything else goes to the person's browser.
  function wireContents(contents) {
    contents.setWindowOpenHandler(({ url }) => {
      if (isAppUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: background() },
        };
      }
      if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (isAppUrl(url)) return;
      event.preventDefault();
      if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
    });
    contents.on('context-menu', (_event, params) => showContextMenu(contents, params));
    // Zoom (see above). Chromium resets it on some navigations, so it is set again on each load.
    contents.on('did-finish-load', () => applyZoom(contents));
    contents.on('before-input-event', (event, input) => {
      const direction = zoomKey(input);
      if (direction === null) return;
      event.preventDefault();
      stepZoom(direction);
    });
    contents.on('zoom-changed', (_event, direction) => stepZoom(direction === 'in' ? 1 : -1));
  }

  // Electron has no right-click menu of its own. This is the browser's basic one for text
  // fields and selections; the app's own menus (messages, tasks) cancel the event first and
  // never reach here.
  function showContextMenu(contents, params) {
    const items = [];
    if (params.misspelledWord) {
      params.dictionarySuggestions.slice(0, 5).forEach((word) => {
        items.push({ label: word, click: () => contents.replaceMisspelling(word) });
      });
      if (items.length) items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    if (params.linkURL && !isAppUrl(params.linkURL)) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ label: 'Open link in browser', click: () => shell.openExternal(params.linkURL) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup();
  }

  // Screen sharing. On Wayland (Fedora's default) the system's own portal asks which screen
  // and getSources returns just that one, so it is used as is. On Windows and X11 every
  // screen and window comes back, and the person picks one in picker.html.
  function pickSource(parent, sources) {
    return new Promise((resolve) => {
      const picker = new BrowserWindow({
        parent,
        modal: true,
        width: 760,
        height: 540,
        resizable: false,
        minimizable: false,
        maximizable: false,
        title: 'Share your screen',
        autoHideMenuBar: true,
        backgroundColor: background(),
        webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true },
      });
      let done = false;
      const finish = (source) => {
        if (done) return;
        done = true;
        ipcMain.removeHandler('picker:sources');
        ipcMain.removeAllListeners('picker:choose');
        if (!picker.isDestroyed()) picker.close();
        resolve(source || null);
      };
      ipcMain.removeHandler('picker:sources');
      ipcMain.handle('picker:sources', () =>
        sources.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
        }))
      );
      ipcMain.once('picker:choose', (_event, id) => finish(sources.find((s) => s.id === id)));
      picker.on('closed', () => finish(null));
      picker.loadFile(path.join(__dirname, 'picker.html'));
    });
  }

  function setUpSession() {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((contents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(contents.getURL()));
    });
    ses.setPermissionCheckHandler((contents, permission, origin) => {
      return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(origin || (contents && contents.getURL()) || '');
    });
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
        });
        if (!sources.length) return callback({});
        const parent = BrowserWindow.getFocusedWindow() || mainWindow;
        const source = sources.length === 1 ? sources[0] : await pickSource(parent, sources);
        if (!source) return callback({});
        const streams = { video: source };
        // Windows can share what the computer is playing along with the screen.
        if (process.platform === 'win32' && request.audioRequested) streams.audio = 'loopback';
        callback(streams);
      } catch (e) {
        callback({});
      }
    });
  }

  // Updates of the shell, from the GitHub releases. The interface needs none of this: it is
  // loaded live. The update downloads quietly; the web app shows the "Restart to update"
  // banner (preload.js hands it the state) and installs it when the person asks.
  //
  // AppImage and Windows also install a downloaded update on quit, silently. .rpm and .deb
  // do not: they need the password (pkexec), and a password prompt appearing as you close
  // the app would make no sense, so for them it only ever happens from the banner.
  let updater = null;
  let updateState = { state: 'idle', version: '', percent: 0 };

  function setUpdateState(next) {
    updateState = { ...updateState, ...next };
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('ubex:update', updateState);
    });
  }

  function setUpUpdates() {
    ipcMain.handle('ubex:update-state', () => updateState);
    ipcMain.on('ubex:update-install', () => {
      if (updater && updateState.state === 'ready') updater.quitAndInstall(false, true);
    });
    if (!app.isPackaged) return;
    try {
      updater = require('electron-updater').autoUpdater;
    } catch (e) {
      return;
    }
    const packaged = process.env.APPIMAGE || process.platform === 'win32';
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = !!packaged;
    updater.on('update-available', (info) => setUpdateState({ state: 'downloading', version: info.version, percent: 0 }));
    updater.on('download-progress', (p) => setUpdateState({ state: 'downloading', percent: Math.round(p.percent || 0) }));
    updater.on('update-downloaded', (info) => setUpdateState({ state: 'ready', version: info.version, percent: 100 }));
    updater.on('error', () => {
      if (updateState.state !== 'ready') setUpdateState({ state: 'error' });
    });
    const check = () => updater.checkForUpdates().catch(() => {});
    check();
    // People leave a chat app open for days; look again every four hours.
    setInterval(check, 4 * 60 * 60 * 1000);
  }

  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    const url = appUrlFromArgs(argv);
    if (url) mainWindow.loadURL(url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    // Windows opened by the app (setWindowOpenHandler 'allow') get the same rules.
    if (contents.getType() === 'window' && mainWindow && contents !== mainWindow.webContents) wireContents(contents);
  });

  app.whenReady().then(() => {
    setUpSession();
    mainWindow = createWindow(appUrlFromArgs(process.argv));
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    setUpUpdates();
  });

  app.on('window-all-closed', () => app.quit());
}
