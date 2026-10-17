// Ubex Chat for the desktop: a window around the live app at chat.ubex.ai.
//
// The interface is not bundled here. It is the same site the browser loads, so every deploy
// reaches the desktop app at once and there is no second copy of the frontend to keep in
// step. This file only adds what a browser tab gives for free and Electron does not: the
// permission prompts (mic, camera, notifications), a screen-share picker, opening outside
// links in the real browser, a right-click menu in text fields, zoom, raising the window when
// a notification is clicked, updates of the shell, and Google Meet in a window of its own.

const { app, BrowserWindow, Menu, Notification, desktopCapturer, ipcMain, nativeImage, nativeTheme, net, session, shell } = require('electron');
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

// ── Google Meet ──────────────────────────────────────────────────────────────────────
// A Google Meet link opened from Ubex Chat (a public meet link, a meeting's Meet, a link in a
// message) opens HERE, in a window of its own, instead of in the browser. The web app cannot do
// this by itself: meet.google.com refuses to be framed (X-Frame-Options: SAMEORIGIN).
//
// The window runs in its own persistent session (`persist:google-meet`): the Google sign-in is
// remembered between meetings and never mixes with Ubex Chat's own storage. It presents itself as
// the Chrome it is, without the "Electron/…" and "ubex-chat/…" tokens, because Google's sign-in
// refuses browsers it does not recognise. Inside it, Google's own pages (Meet, the account sign-in)
// stay in the window; anything else goes to the real browser. Camera, microphone, screen sharing
// and notifications are allowed for meet.google.com only.
const MEET_PARTITION = 'persist:google-meet';
const MEET_LINK = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[?#].*)?$/i;

function isGoogleMeetUrl(url) {
  return typeof url === 'string' && MEET_LINK.test(url);
}

// Google's own pages the Meet window may move between: Meet itself and the account sign-in, which
// passes through accounts.youtube.com and the country domains (accounts.google.es) to set cookies.
function isGooglePage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return (
      h === 'google.com' ||
      h.endsWith('.google.com') ||
      /^accounts\.google\.[a-z.]{2,6}$/.test(h) ||
      h === 'accounts.youtube.com' ||
      h.endsWith('.googleusercontent.com') ||
      h.endsWith('.gstatic.com')
    );
  } catch (e) {
    return false;
  }
}

function isMeetOrigin(url) {
  try {
    return new URL(url).hostname.toLowerCase() === 'meet.google.com';
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
        // Message chimes and call rings play without a click first. Electron's default too,
        // but stated, because the app depends on it: a chat app is often started and left
        // in the background without ever being clicked, and a call must still ring.
        autoplayPolicy: 'no-user-gesture-required',
        additionalArguments: ['--ubex-version=' + app.getVersion()],
        // Google Meet inside the app (1.5.0 on): the web app shows it in a <webview>, which
        // guardWebview below allows for a Google Meet link only, in the Meet session, with
        // nothing of Node or of this app inside it.
        webviewTag: true,
      },
    });
    win.once('ready-to-show', () => win.show());
    // The taskbar highlight asked for by a notification (ubex:attention) ends when you look.
    win.on('focus', () => win.flashFrame(false));
    wireContents(win.webContents);
    win.loadURL(startUrl || APP_URL);
    return win;
  }

  // Ubex Chat links stay in the app (a meeting or board opened in a new tab gets its own window);
  // everything else goes to the person's browser.
  function wireContents(contents) {
    contents.setWindowOpenHandler(({ url }) => {
      if (isGoogleMeetUrl(url)) {
        meetLink(contents, url);
        return { action: 'deny' };
      }
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
      if (isGoogleMeetUrl(url)) meetLink(contents, url);
      else if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
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
    // Only what the window and new-tab handlers also hand to the system: another scheme (file:,
    // smb:, ms-msdt:, search-ms: …) would let the OS run whatever handler it has for it.
    if (params.linkURL && !isAppUrl(params.linkURL) && /^(https?|mailto|tel):/i.test(params.linkURL)) {
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
    handleScreenShare(ses);
  }

  // The Google Meet session: made once, the first time a Meet is opened.
  let meetSes = null;
  function meetSession() {
    if (meetSes) return meetSes;
    meetSes = session.fromPartition(MEET_PARTITION);
    meetSes.setUserAgent(chromeUserAgent());
    meetSes.setPermissionRequestHandler((contents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission) && isMeetOrigin(contents.getURL()));
    });
    meetSes.setPermissionCheckHandler((contents, permission, origin) => {
      return ALLOWED_PERMISSIONS.has(permission) && isMeetOrigin(origin || (contents && contents.getURL()) || '');
    });
    handleScreenShare(meetSes);
    return meetSes;
  }

  // Electron's own user agent minus the tokens that make Google's sign-in refuse it.
  function chromeUserAgent() {
    return app.userAgentFallback.replace(/\s+(Electron|ubex-chat|Ubex Chat)\/\S+/gi, '');
  }

  // One window per meeting: opening a Meet that is already open brings its window forward;
  // another meeting gets a window of its own rather than replacing a call in progress.
  const meetWindows = new Map(); // meeting code -> BrowserWindow

  function meetCode(url) {
    const m = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(url || '');
    return m ? m[1].toLowerCase() : '';
  }

  function openMeetWindow(url) {
    if (!isGoogleMeetUrl(url)) return;
    const code = meetCode(url);
    const open = meetWindows.get(code);
    if (open && !open.isDestroyed()) {
      raise(open);
      return;
    }
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: 'Google Meet',
      autoHideMenuBar: true,
      backgroundColor: '#202124',
      icon: path.join(__dirname, 'build/icon.png'),
      webPreferences: {
        session: meetSession(),
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    meetWindows.set(code, win);
    win.on('closed', () => {
      if (meetWindows.get(code) === win) meetWindows.delete(code);
    });
    win.once('ready-to-show', () => win.show());
    // The page's own title ("Meet - abc-defg-hij"), not "Electron".
    win.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      win.setTitle(title && title !== 'Meet' ? title : 'Google Meet');
    });
    const contents = win.webContents;
    wireMeetContents(contents);
    contents.on('did-finish-load', () => applyZoom(contents));
    win.loadURL(url);
  }

  // What a Google Meet page may do, in its own window or in the app's <webview>: move between
  // Google's own pages (Meet, the sign-in), and nothing else — other links go to the browser.
  function wireMeetContents(contents) {
    contents.setWindowOpenHandler(({ url: next }) => {
      if (isGoogleMeetUrl(next)) openMeetWindow(next);
      else if (/^(https?|mailto|tel):/i.test(next)) shell.openExternal(next);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, next) => {
      if (isGooglePage(next)) return;
      event.preventDefault();
      if (/^(https?|mailto|tel):/i.test(next)) shell.openExternal(next);
    });
    contents.on('context-menu', (_event, params) => {
      const items = [];
      if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' });
      else if (params.selectionText) items.push({ role: 'copy' });
      if (items.length) items.push({ type: 'separator' });
      // A way out when Google refuses something in here: the same meeting in the real browser.
      const code = meetCode(contents.getURL());
      items.push({
        label: 'Open this meeting in your browser',
        click: () => shell.openExternal(code ? 'https://meet.google.com/' + code : 'https://meet.google.com/'),
      });
      Menu.buildFromTemplate(items).popup();
    });
  }

  // Only a Google Meet link, in the Meet session, sandboxed, with no preload: whatever the page
  // asked for in its <webview> tag. Anything else is refused before it is created.
  function guardWebview(host) {
    host.on('will-attach-webview', (event, webPreferences, params) => {
      if (!isAppUrl(host.getURL()) || !isGoogleMeetUrl(params.src)) {
        event.preventDefault();
        return;
      }
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webviewTag = false;
      meetSession();
      webPreferences.partition = MEET_PARTITION;
      params.partition = MEET_PARTITION;
    });
  }

  // A Meet link from an app page: back to that page when it shows Meet itself (the web app asked
  // for links with onMeetLink), else a window of its own.
  const meetLinkPages = new Set();
  function meetLink(contents, url) {
    if (meetLinkPages.has(contents.id) && !contents.isDestroyed()) contents.send('ubex:meet-link', url);
    else openMeetWindow(url);
  }

  function handleScreenShare(ses) {
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

  // Notifications (1.3.1 on). The web app shows them itself; what it cannot do from inside the
  // page is bring the window forward. A renderer's window.focus() does nothing to a window
  // that is minimized or behind other apps, so clicking a system notification opened the
  // conversation out of sight.
  function windowOf(event) {
    if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() ? win : null;
  }

  function raise(win) {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  // System notifications are shown from here (1.3.2 on), not by the page's own
  // `new Notification()`. On Wayland (Fedora's GNOME) a window may only come to the front with
  // the one-time activation token GNOME hands over when a notification is clicked. Electron
  // stores it just before it reports the click, so the window has to be raised in that same
  // click handler — which only this process has. The page's notification reached its onclick
  // late, went through IPC to get back here, and could be garbage-collected (click lost) before
  // it was ever clicked; so the click opened nothing. Each one is kept in `shown` until it
  // closes, which is what keeps its click alive. One per conversation (`tag`), like the page's.
  const shown = new Map();
  const MAX_SHOWN = 30;

  // A notification's icon (1.3.3 on): the picture of the organization it comes from, which the page
  // names by URL (the avatars bucket). Downloaded once per URL and kept; anything that is not an https
  // image that loads falls back to the app's own icon, as before.
  const DEFAULT_ICON = path.join(__dirname, 'build/icon.png');
  const icons = new Map();

  async function iconFor(url) {
    if (typeof url !== 'string' || !/^https:\/\//.test(url) || url.length > 2000) return DEFAULT_ICON;
    if (icons.has(url)) return icons.get(url);
    let icon = DEFAULT_ICON;
    try {
      const res = await net.fetch(url);
      if (res.ok) {
        const image = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
        if (!image.isEmpty()) icon = image.resize({ width: 128, height: 128 });
      }
    } catch (e) {
      icon = DEFAULT_ICON;
    }
    icons.set(url, icon);
    while (icons.size > 50) icons.delete(icons.keys().next().value);
    return icon;
  }

  async function showNotification(win, { id, title, body, tag, icon }) {
    if (!Notification.isSupported()) return;
    const image = await iconFor(icon);
    if (win.isDestroyed()) return;
    const key = String(tag || id || '');
    const previous = shown.get(key);
    if (previous) {
      shown.delete(key);
      previous.close();
    }
    const note = new Notification({
      title: String(title || 'Ubex Chat').slice(0, 200),
      body: String(body || '').slice(0, 500),
      icon: image,
      // The page plays the account's own chime; a system sound on top would double it.
      silent: true,
    });
    const forget = () => {
      if (shown.get(key) === note) shown.delete(key);
    };
    note.on('click', () => {
      raise(win);
      if (!win.isDestroyed()) win.webContents.send('ubex:notification-click', id);
      forget();
    });
    note.on('close', forget);
    shown.set(key, note);
    while (shown.size > MAX_SHOWN) shown.delete(shown.keys().next().value);
    note.show();
  }

  function setUpNotifications() {
    // A Google Meet link, from the web app (shared/meet-window.js): its own window (see above).
    ipcMain.on('ubex:open-meet', (_event, url) => {
      if (isGoogleMeetUrl(String(url || ''))) openMeetWindow(String(url));
    });
    // The web app shows Meet itself (1.5.0 on): Meet links clicked in its page go back to it.
    ipcMain.on('ubex:meet-links', (event) => {
      const contents = event.sender;
      if (!isAppUrl(contents.getURL()) || meetLinkPages.has(contents.id)) return;
      meetLinkPages.add(contents.id);
      contents.once('destroyed', () => meetLinkPages.delete(contents.id));
    });
    ipcMain.on('ubex:focus', (event) => raise(windowOf(event)));
    ipcMain.on('ubex:notify', (event, payload) => {
      const win = windowOf(event);
      if (win && payload && typeof payload === 'object') showNotification(win, payload);
    });
    // A new message while the window is in the background: highlight it in the taskbar
    // (the urgency hint on Linux, a flashing button on Windows) until it is focused.
    ipcMain.on('ubex:attention', (event) => {
      const win = windowOf(event);
      if (win && !win.isFocused()) win.flashFrame(true);
    });
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
    // A Google Meet in the app's <webview> (guardWebview let it in): the Meet rules.
    if (contents.getType() === 'webview') {
      wireMeetContents(contents);
      return;
    }
    // The Google Meet windows have rules of their own (openMeetWindow) and are left alone.
    if (meetSes && contents.session === meetSes) return;
    guardWebview(contents);
    if (contents.getType() === 'window' && mainWindow && contents !== mainWindow.webContents) wireContents(contents);
  });

  app.whenReady().then(() => {
    setUpSession();
    setUpNotifications();
    mainWindow = createWindow(appUrlFromArgs(process.argv));
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    setUpUpdates();
  });

  app.on('window-all-closed', () => app.quit());
}
