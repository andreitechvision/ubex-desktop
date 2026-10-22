// Ubex Chat for the desktop: a window around the live app at chat.ubex.ai.
//
// The interface is not bundled here. It is the same site the browser loads, so every deploy
// reaches the desktop app at once and there is no second copy of the frontend to keep in
// step. This file only adds what a browser tab gives for free and Electron does not: the
// permission prompts (mic, camera, notifications), a screen-share picker, opening outside
// links in the real browser, a right-click menu in text fields, zoom, raising the window when
// a notification is clicked, updates of the shell, Google Meet in a window of its own, and (1.5.2) a record
// of the window hanging and of its page or GPU process crashing, which the web app sends to Debug. (1.5.4) How
// it draws (Settings → Desktop app → Graphics), and updates on Linux installed without freezing the window.
// (1.5.6) Every record carries a timeline of what the window and its processes did before it, and a run that was
// killed (a stuck window closed by force) is reported on the next start with how it was at the end.

const { app, BrowserWindow, Menu, Notification, desktopCapturer, dialog, ipcMain, powerMonitor, nativeImage, nativeTheme, net, session, shell } = require('electron');
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

// ── Graphics (1.5.4) ─────────────────────────────────────────────────────────────────
// How the app draws, chosen in Settings → Desktop app → Graphics and kept in userData/settings.json:
//   auto      Electron's own choice: the GPU, and on Linux a native Wayland window under Wayland
//   x11       the GPU, in an X11 window (XWayland) — the usual cure when a Wayland session with the
//             NVIDIA driver freezes the window or a call's video
//   software  no GPU at all: everything drawn by the processor. Always works, uses more CPU in calls
// Read before the app is ready, because both have to be decided before the first window. The X11 window
// needs a command-line switch, so the app starts itself again with it.
const GRAPHICS_MODES = ['auto', 'x11', 'software'];
const X11_SWITCH = '--ozone-platform=x11';

function savedGraphics() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')) || {};
    return GRAPHICS_MODES.includes(s.graphics) ? s.graphics : 'auto';
  } catch (e) {
    return 'auto';
  }
}

// Start again: after an update, or to draw another way. An AppImage is started from its file, not from the
// folder it mounted (which goes away when this process ends). `keepLink`: the ubex-chat:// link this process
// was started for goes along (the X11 restart of a link click, which then reaches the open window); an update's
// restart does not reopen an old link.
function relaunch(extraArgs, keepLink) {
  const args = process.argv.slice(1).filter((a) => (keepLink || !a.startsWith('ubex-chat://')) && a !== X11_SWITCH);
  const opts = { args: [...args, ...(extraArgs || [])] };
  if (process.env.APPIMAGE) opts.execPath = process.env.APPIMAGE;
  app.relaunch(opts);
  app.exit(0);
}

const GRAPHICS = savedGraphics();
const onWayland = process.platform === 'linux' && /wayland/i.test(process.env.XDG_SESSION_TYPE || '');
if (GRAPHICS === 'software') app.disableHardwareAcceleration();
const needsX11 = GRAPHICS === 'x11' && onWayland && !process.argv.includes(X11_SWITCH);

if (needsX11) {
  relaunch([X11_SWITCH], true);
} else if (!app.requestSingleInstanceLock()) {
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
        // (1.5.1) Full speed while minimized or covered. Electron's default throttles a hidden
        // page, and on Windows a minimized or covered window IS hidden: measured here, a 100 ms
        // timer fired 13 times in 12 s instead of 120, and Chromium slows it to about once a
        // minute after five. The call engine runs on timers (the ring repeating, connecting,
        // recovering, the sockets reconnecting), so a minimized app rang once and went quiet,
        // and calls answered from it were slow to connect. Chat and call apps turn this off.
        backgroundThrottling: false,
      },
    });
    win.once('ready-to-show', () => win.show());
    // The taskbar highlight asked for by a notification (ubex:attention) ends when you look.
    win.on('focus', () => win.flashFrame(false));
    wireContents(win.webContents);
    wireHealth(win);
    win.loadURL(startUrl || APP_URL);
    return win;
  }

  // ── Health (1.5.2) ───────────────────────────────────────────────────────────────────
  // What the web page cannot report itself, because it is the thing that is stuck or gone: the window not
  // responding (and for how long), its page crashing, the GPU or a media process crashing (video freezes in
  // calls). Kept in userData/health.json until the web app asks for them (ubexDesktop.healthEvents, read by
  // its shared/app-health.js and sent to the admin panel's Debug). A hung window offers Wait / Reload after
  // HANG_ASK_MS instead of leaving the person to kill the app; a crashed page is loaded again.
  const HANG_ASK_MS = 10000;
  const healthFile = () => path.join(app.getPath('userData'), 'health.json');

  function readHealth() {
    try {
      const list = JSON.parse(fs.readFileSync(healthFile(), 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function metricsLines() {
    const lines = [];
    try {
      const byType = {};
      app.getAppMetrics().forEach((m) => {
        const t = byType[m.type] || (byType[m.type] = { mem: 0, cpu: 0, n: 0 });
        t.mem += (m.memory && m.memory.workingSetSize) || 0;
        t.cpu += (m.cpu && m.cpu.percentCPUUsage) || 0;
        t.n += 1;
      });
      Object.keys(byType).forEach((k) => {
        const t = byType[k];
        lines.push(`${k}${t.n > 1 ? ` x${t.n}` : ''}: ${Math.round(t.mem / 1024)} MB, CPU ${Math.round(t.cpu)}%`);
      });
    } catch (e) {}
    try {
      const g = app.getGPUFeatureStatus();
      lines.push(`GPU: compositing ${g.gpu_compositing}, video decode ${g.video_decode}, webgl ${g.webgl}`);
    } catch (e) {}
    if (gpuName) lines.push(`Graphics card: ${gpuName}`);
    lines.push(`Graphics: ${GRAPHICS}${GRAPHICS === 'x11' || process.argv.includes(X11_SWITCH) ? ' (X11 window)' : ''}, session ${process.env.XDG_SESSION_TYPE || process.platform}`);
    lines.push(`System: ${process.platform} ${process.getSystemVersion ? process.getSystemVersion() : ''}, ${Math.round(require('os').totalmem() / 1073741824)} GB RAM, ${Math.round(require('os').freemem() / 1048576)} MB free`);
    lines.push(`Desktop app ${app.getVersion()}, Electron ${process.versions.electron}, Chrome ${process.versions.chrome}`);
    return lines;
  }

  function pageOf(contents) {
    try {
      return contents && !contents.isDestroyed() ? new URL(contents.getURL()).pathname : '';
    } catch (e) {
      return '';
    }
  }

  // The renderer and driver Chromium actually draws with ("NVIDIA GeForce RTX 4090/PCIe/SSE2", or "llvmpipe" /
  // "NV194" when the NVIDIA driver is not the one in use), read once the GPU process has started.
  let gpuName = '';
  // Under Wayland 'complete' can come back without the renderer (Debug, 2026-10-20: a hang report with no
  // card at all), so then the basic info names the card by vendor, and Linux says which NVIDIA driver runs.
  const VENDORS = { 4318: 'NVIDIA', 4098: 'AMD', 32902: 'Intel' };
  function nvidiaDriver() {
    try {
      const m = fs.readFileSync('/proc/driver/nvidia/version', 'utf8').match(/Kernel Module\s+(?:for \S+\s+)?([\d.]+)/);
      return m ? `NVIDIA proprietary driver ${m[1]}` : 'NVIDIA proprietary driver';
    } catch (e) {
      return '';
    }
  }
  function nameOf(info) {
    const aux = (info && info.auxAttributes) || {};
    const dev = ((info && info.gpuDevice) || []).find((d) => d.active) || ((info && info.gpuDevice) || [])[0] || {};
    const driver = [dev.driverVendor, dev.driverVersion].filter(Boolean).join(' ');
    const card = aux.glRenderer || (VENDORS[dev.vendorId] ? `${VENDORS[dev.vendorId]} card` : '');
    return [card, driver ? `driver ${driver}` : ''].filter(Boolean).join(', ');
  }
  // Some systems never answer 'complete' (Settings → Graphics waited forever): give up after 3 s.
  function withinSeconds(promise, s) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(''), s * 1000))]);
  }
  function readGpu() {
    return withinSeconds(app.getGPUInfo('complete').then(nameOf).catch(() => ''), 3)
      .then((name) => name || app.getGPUInfo('basic').then(nameOf).catch(() => ''))
      .then((name) => {
        const nv = process.platform === 'linux' ? nvidiaDriver() : '';
        gpuName = [name, nv && name.indexOf(nv) === -1 ? nv : ''].filter(Boolean).join('; ').slice(0, 200);
        return gpuName;
      });
  }

  function recordHealth(title, details, extra) {
    const list = readHealth().slice(-49);
    list.push({
      at: new Date().toISOString(),
      title,
      details: [...(details || []), ...windowLines(), ...metricsLines(), '', 'What the desktop app saw before it (oldest first):', ...timelineLines(40)],
      ...(extra || {}),
      reported: false,
    });
    try {
      fs.writeFileSync(healthFile(), JSON.stringify(list));
    } catch (e) {}
  }

  // ── Timeline (1.5.6) ─────────────────────────────────────────────────────────────────
  // What happened to the window and its processes, kept in memory (the last TIMELINE_MAX) and copied into every
  // health record, so a report says what led up to it: the window shown, hidden, focused, minimised or full
  // screen, dialogs and the screen-share picker opening and closing, the computer sleeping and waking, the
  // page loading, input reaching it, warnings and errors in its console, processes ending. Never content.
  const TIMELINE_MAX = 120;
  const timeline = [];
  const clockOf = (ms) => new Date(ms).toISOString().substring(11, 23);
  const maskText = (s) => String(s || '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>').replace(/\s+/g, ' ').slice(0, 160);

  function note(text) {
    timeline.push({ at: Date.now(), text: maskText(text) });
    if (timeline.length > TIMELINE_MAX) timeline.shift();
  }

  function timelineLines(n) {
    return timeline.slice(-n).map((e) => `${clockOf(e.at)}  ${e.text}`);
  }

  // What the main window and its page were doing (also written every few seconds to run.json, below).
  const live = {
    hungSince: 0, // the window stopped responding (Electron's 'unresponsive'), not yet back
    dialog: '', // a message box over the window ('hang', 'gpu')
    picker: false, // the screen-share picker open (modal: the window behind it takes no clicks)
    sharing: '', // a screen-share request in progress: 'sources' while the system lists them
    lastMouse: 0,
    lastKey: 0,
    inputsWhileHung: 0,
    pageAnsweredAt: 0, // the page last answered a ping from here (it runs JavaScript)
    pagePingSince: 0, // a ping is waiting for its answer since then
    pageSilentNoted: false,
    asleepAt: 0,
    gpuStatus: '',
  };

  function ago(ms) {
    if (!ms) return 'never';
    const s = (Date.now() - ms) / 1000;
    return s < 120 ? `${s.toFixed(1)} s ago` : `${Math.round(s / 60)} min ago`;
  }

  function windowLines() {
    const w = mainWindow;
    if (!w || w.isDestroyed()) return ['Window: none'];
    const flags = [];
    try {
      flags.push(w.isVisible() ? 'visible' : 'hidden');
      if (w.isFocused()) flags.push('focused');
      if (w.isMinimized()) flags.push('minimised');
      if (w.isFullScreen()) flags.push('full screen');
      if (!w.isEnabled()) flags.push('DISABLED (takes no clicks: a modal window or dialog is over it)');
      const b = w.getBounds();
      flags.push(`${b.width}x${b.height}`);
    } catch (e) {}
    const lines = [`Window: ${flags.join(', ')}`];
    if (live.hungSince) lines.push(`Not responding since ${clockOf(live.hungSince)} (${ago(live.hungSince)}), clicks/keys sent to it meanwhile: ${live.inputsWhileHung}`);
    if (live.dialog) lines.push(`Dialog open over the window: ${live.dialog}`);
    if (live.picker) lines.push('Screen-share picker open (the window behind it takes no clicks)');
    if (live.sharing) lines.push(`Screen share request in progress: ${live.sharing}`);
    lines.push(`Last click reached the window: ${ago(live.lastMouse)}; last key: ${ago(live.lastKey)}`);
    lines.push(`Page last answered the desktop app: ${ago(live.pageAnsweredAt)}${live.pagePingSince ? `, waiting for an answer since ${ago(live.pagePingSince)}` : ''}`);
    const others = BrowserWindow.getAllWindows().filter((x) => x !== w && !x.isDestroyed());
    if (others.length) lines.push(`Other windows: ${others.map((x) => `${x.getTitle() || 'untitled'}${x.isVisible() ? '' : ' (hidden)'}`).join(', ')}`);
    return lines;
  }

  // ── This run, every few seconds (1.5.6) ───────────────────────────────────────────────
  // run.json says how this run was doing a moment ago. When the app is killed (the person closing a stuck window,
  // the system), nothing runs at the end, so the next start reads what the last one wrote: whether the window
  // was responding, disabled behind a dialog, receiving clicks, whether the page still answered, and the timeline.
  // `clean` is written when the app quits on its own.
  const runFile = () => path.join(app.getPath('userData'), 'run.json');
  const RUN_EVERY_MS = 5000;
  const runStarted = Date.now();
  let lastRunTick = Date.now();

  function writeRun(clean) {
    try {
      fs.writeFileSync(runFile(), JSON.stringify({
        started: runStarted, at: Date.now(), pid: process.pid, version: app.getVersion(), clean: !!clean,
        window: windowLines(), timeline: timelineLines(60),
      }));
    } catch (e) {}
  }

  function previousRun() {
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(runFile(), 'utf8'));
    } catch (e) {}
    if (!prev || prev.clean || !prev.at) return;
    let ex = null;
    try {
      ex = JSON.parse(fs.readFileSync(exitFile(), 'utf8'));
    } catch (e) {}
    // Quit, restarted or shut down on purpose just after its last record: not a problem.
    if (ex && Number(ex.at) >= prev.at - 1000 && Number(ex.at) - prev.at < 30000) return;
    const list = readHealth().slice(-49);
    list.push({
      at: new Date(prev.at).toISOString(),
      title: 'The desktop app was closed or killed without quitting',
      details: [
        `Its last record: ${new Date(prev.at).toISOString().replace('T', ' ').substring(0, 19)} UTC, ${Math.round((prev.at - prev.started) / 60000)} min after it started (version ${prev.version})`,
        'How it was then (from the desktop app itself, which keeps running when the page or the window is stuck):',
        ...(prev.window || []),
        '',
        'What the desktop app saw before it (oldest first):',
        ...(prev.timeline || []),
      ],
      page: '',
      reported: false,
    });
    try {
      fs.writeFileSync(healthFile(), JSON.stringify(list));
    } catch (e) {}
  }

  // Every RUN_EVERY_MS: run.json, the main process's own stalls (its timers late), and a ping to the page.
  function watchRun() {
    previousRun();
    writeRun(false);
    app.on('will-quit', () => writeRun(true));
    setInterval(() => {
      const now = Date.now();
      const late = now - lastRunTick - RUN_EVERY_MS;
      lastRunTick = now;
      // Not while the computer slept (its timers stop too).
      if (late > 3000 && late < 10 * 60 * 1000 && !live.asleepAt) {
        note(`main process blocked for ${(late / 1000).toFixed(1)} s`);
        recordHealth('The desktop app itself was blocked', [`Its main process did nothing for ${(late / 1000).toFixed(1)} s (the window takes no clicks and draws nothing meanwhile)`]);
      }
      pingPage();
      writeRun(false);
    }, RUN_EVERY_MS);
  }

  // Does the page still run JavaScript? A hung page never answers, and that is recorded once.
  function pingPage() {
    const w = mainWindow;
    if (!w || w.isDestroyed() || live.pagePingSince) {
      if (live.pagePingSince && Date.now() - live.pagePingSince > 15000 && !live.pageSilentNoted) {
        live.pageSilentNoted = true;
        note(`page has not answered for ${((Date.now() - live.pagePingSince) / 1000).toFixed(0)} s`);
      }
      return;
    }
    live.pagePingSince = Date.now();
    w.webContents
      .executeJavaScript('1', false)
      .then(() => {
        if (live.pageSilentNoted) note(`page answers again after ${((Date.now() - live.pagePingSince) / 1000).toFixed(1)} s`);
        live.pageSilentNoted = false;
        live.pageAnsweredAt = Date.now();
        live.pagePingSince = 0;
      })
      .catch(() => {
        live.pagePingSince = 0;
      });
  }

  function wireHealth(win) {
    const contents = win.webContents;
    // Windows: logging off or shutting down ends the session without a quit.
    win.on('session-end', () => recordExit('shutdown'));
    ['show', 'hide', 'minimize', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach((ev) => win.on(ev, () => note(`window ${ev}`)));
    win.on('focus', () => note('window focused'));
    win.on('blur', () => note('window lost focus'));
    contents.on('did-start-loading', () => note(`page loading ${pageOf(contents) || ''}`));
    contents.on('did-finish-load', () => note('page loaded'));
    contents.on('did-fail-load', (_e, code, desc, url, isMain) => { if (isMain) note(`page failed to load: ${code} ${desc}`); });
    contents.on('preload-error', (_e, _p, error) => note(`preload error: ${error && error.message}`));
    // Clicks and keys that reach the window (counted, never what was typed).
    contents.on('input-event', (_e, input) => {
      if (!input) return;
      if (input.type === 'mouseDown') live.lastMouse = Date.now();
      else if (input.type === 'keyDown' || input.type === 'rawKeyDown') live.lastKey = Date.now();
      else return;
      if (live.hungSince) {
        live.inputsWhileHung += 1;
        if (live.inputsWhileHung === 1 || live.inputsWhileHung % 10 === 0) note(`${input.type === 'mouseDown' ? 'click' : 'key'} while not responding (${live.inputsWhileHung})`);
      }
    });
    // The page's console warnings and errors, Chromium's own included (WebGL context lost, GPU stalls, media errors).
    contents.on('console-message', (e, level, message) => {
      const lv = e && typeof e.level === 'string' ? e.level : ['verbose', 'info', 'warning', 'error'][level];
      const text = e && typeof e.message === 'string' ? e.message : message;
      if (lv === 'warning' || lv === 'error') note(`console ${lv}: ${text}`);
    });

    let hungAt = 0;
    let asking = null; // the AbortController of the Wait / Reload box while it is open
    let askTimer = null;
    // (1.5.6) The box closes itself when the window comes back or its page is reloaded: before, it stayed open
    // over a window that already worked again, and the window took no clicks until it was answered.
    const closeAsk = (why) => {
      clearTimeout(askTimer);
      if (asking) {
        note(`"not responding" box closed by itself (${why})`);
        asking.abort();
        asking = null;
        live.dialog = '';
      }
    };
    win.on('unresponsive', () => {
      if (!hungAt) hungAt = Date.now();
      live.hungSince = hungAt;
      live.inputsWhileHung = 0;
      note('window not responding');
      clearTimeout(askTimer);
      askTimer = setTimeout(async () => {
        if (!hungAt || asking || win.isDestroyed()) return;
        const since = hungAt;
        const ctl = new AbortController();
        asking = ctl;
        live.dialog = 'Ubex Chat is not responding (Wait / Reload)';
        note('"not responding" box shown');
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Ubex Chat is not responding',
          message: 'Ubex Chat is not responding',
          detail: 'You can wait for it, or reload it. A call you are in will reconnect after a reload.',
          buttons: ['Wait', 'Reload'],
          defaultId: 0,
          cancelId: 0,
          signal: ctl.signal,
        });
        if (ctl.signal.aborted) return;
        asking = null;
        live.dialog = '';
        note(`"not responding" box answered: ${response === 1 ? 'Reload' : 'Wait'}`);
        if (response === 1 && !win.isDestroyed()) {
          recordHealth('The window stopped responding and was reloaded', [`Not responding for ${Math.round((Date.now() - since) / 1000)} s before Reload`],
            { page: pageOf(contents), duration: Date.now() - since });
          hungAt = 0;
          live.hungSince = 0;
          try { contents.forcefullyCrashRenderer(); } catch (e) {}
          contents.reload();
        }
      }, HANG_ASK_MS);
    });
    win.on('responsive', () => {
      closeAsk('the window responds again');
      if (!hungAt) return;
      const took = Date.now() - hungAt;
      hungAt = 0;
      live.hungSince = 0;
      note(`window responding again after ${(took / 1000).toFixed(1)} s`);
      recordHealth('The window stopped responding', [`Not responding for ${(took / 1000).toFixed(1)} s, then recovered`, `Clicks/keys sent to it meanwhile: ${live.inputsWhileHung}`],
        { page: pageOf(contents), duration: took });
    });
    contents.on('render-process-gone', (_event, details) => {
      if (!details || details.reason === 'clean-exit') return;
      note(`page process gone: ${details.reason}, exit code ${details.exitCode}`);
      closeAsk('the page crashed and is reloaded');
      const hungFor = hungAt ? Date.now() - hungAt : 0;
      hungAt = 0;
      live.hungSince = 0;
      recordHealth(`The page crashed (${details.reason})`, [`Exit code ${details.exitCode}${details.exitCode === 133 ? ' (SIGTRAP: Chromium stopped it on purpose after an internal check failed — often the GPU or the graphics driver)' : ''}`,
        hungFor ? `It had not been responding for ${(hungFor / 1000).toFixed(1)} s before` : 'It was responding until then'], { page: pageOf(contents) });
      setTimeout(() => {
        if (!win.isDestroyed()) contents.reload();
      }, 1000);
    });
  }

  // The GPU process failing again and again is the graphics driver (it is what freezes the window or a call's
  // video). The second time within half an hour, the app offers to stop using the GPU — once per run, and only
  // while it still is.
  const gpuFails = [];
  let gpuAsked = false;
  async function gpuFailed() {
    const now = Date.now();
    gpuFails.push(now);
    while (gpuFails.length && now - gpuFails[0] > 30 * 60 * 1000) gpuFails.shift();
    if (gpuFails.length < 2 || gpuAsked || GRAPHICS === 'software' || !mainWindow || mainWindow.isDestroyed()) return;
    gpuAsked = true;
    live.dialog = 'Graphics problem (Not now / Turn off and restart)';
    note('"graphics problem" box shown');
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Graphics problem',
      message: 'Ubex Chat\u2019s graphics keep failing on this computer',
      detail:
        'This usually comes from the graphics driver, and it can freeze the window or the video in calls. Ubex Chat can stop using the graphics card and draw everything itself instead. It restarts to do that; a call you are in reconnects.\n\nYou can change this later in Settings \u2192 Desktop app \u2192 Graphics.',
      buttons: ['Not now', 'Turn off and restart'],
      defaultId: 1,
      cancelId: 0,
    });
    live.dialog = '';
    note(`"graphics problem" box answered: ${response === 1 ? 'Turn off and restart' : 'Not now'}`);
    if (response !== 1) return;
    writeSettings({ graphics: 'software' });
    recordExit('quit');
    relaunch();
  }

  // Settings → Desktop app → Graphics: what is in use now, what is saved for the next start, and a restart.
  function setUpGraphics() {
    const fromApp = (event) => !!(event.senderFrame && isAppUrl(event.senderFrame.url));
    ipcMain.handle('ubex:graphics', async (event) => {
      if (!fromApp(event)) return null;
      await readGpu();
      let accelerated = GRAPHICS !== 'software';
      try {
        accelerated = String(app.getGPUFeatureStatus().gpu_compositing || '').indexOf('enabled') === 0;
      } catch (e) {}
      return {
        mode: GRAPHICS,
        saved: savedGraphics(),
        renderer: gpuName,
        session: process.env.XDG_SESSION_TYPE || '',
        x11: process.argv.includes(X11_SWITCH) || (process.platform === 'linux' && !onWayland),
        accelerated,
      };
    });
    ipcMain.handle('ubex:graphics-set', (event, mode) => {
      if (!fromApp(event) || !GRAPHICS_MODES.includes(mode)) return false;
      writeSettings({ graphics: mode });
      return true;
    });
    ipcMain.on('ubex:restart', (event) => {
      if (!fromApp(event)) return;
      note(`restarting to draw with graphics "${savedGraphics()}"`);
      writeRun(false);
      recordExit('quit');
      relaunch();
    });
  }

  // (1.5.3) How the app last ended on purpose: quit, or the computer shutting down / logging out. The web app
  // asks (ubexDesktop.lastExit) so a session that ended that way is not reported as "closed unexpectedly"
  // (SUPPORT-SECURITY-AUDIT.md L6).
  const exitFile = () => path.join(app.getPath('userData'), 'last-exit.json');
  function recordExit(why) {
    try {
      fs.writeFileSync(exitFile(), JSON.stringify({ at: Date.now(), why }));
    } catch (e) {}
  }

  function setUpHealth() {
    app.on('before-quit', () => {
      note('quitting');
      recordExit('quit');
    });
    try {
      powerMonitor.on('shutdown', () => {
        note('computer shutting down');
        recordExit('shutdown');
      });
      powerMonitor.on('suspend', () => {
        live.asleepAt = Date.now();
        note('computer going to sleep');
        writeRun(false);
      });
      powerMonitor.on('resume', () => {
        note(`computer woke up${live.asleepAt ? ` after ${Math.round((Date.now() - live.asleepAt) / 60000)} min` : ''}`);
        live.asleepAt = 0;
        lastRunTick = Date.now();
      });
      powerMonitor.on('lock-screen', () => note('screen locked'));
      powerMonitor.on('unlock-screen', () => note('screen unlocked'));
    } catch (e) {}
    try {
      const { screen } = require('electron');
      const describe = (d) => `${d.size.width}x${d.size.height} at ${d.scaleFactor}x`;
      screen.on('display-added', (_e, d) => note(`screen added: ${describe(d)}`));
      screen.on('display-removed', (_e, d) => note(`screen removed: ${describe(d)}`));
      screen.on('display-metrics-changed', (_e, d, changed) => note(`screen changed (${(changed || []).join(', ')}): ${describe(d)}`));
    } catch (e) {}
    app.on('gpu-info-update', () => {
      try {
        const g = app.getGPUFeatureStatus();
        const now = `compositing ${g.gpu_compositing}, rasterization ${g.rasterization}, video decode ${g.video_decode}, webgl ${g.webgl}`;
        if (now !== live.gpuStatus) note(`GPU status: ${now}`);
        live.gpuStatus = now;
      } catch (e) {}
    });
    watchRun();
    ipcMain.handle('ubex:last-exit', () => {
      try {
        return JSON.parse(fs.readFileSync(exitFile(), 'utf8'));
      } catch (e) {
        return null;
      }
    });
    app.on('child-process-gone', (_event, details) => {
      if (!details) return;
      note(`${details.type}${details.name ? ` (${details.name})` : ''} process ended: ${details.reason}, exit code ${details.exitCode}`);
      if (details.reason === 'clean-exit') return;
      const what = details.type === 'GPU' ? 'The GPU process crashed' : `A ${details.name || details.type} process crashed`;
      recordHealth(`${what} (${details.reason})`, [`Type ${details.type}${details.serviceName ? `, ${details.serviceName}` : ''}, exit code ${details.exitCode}`],
        { page: mainWindow ? pageOf(mainWindow.webContents) : '' });
      if (details.type === 'GPU') gpuFailed();
    });
    // What has not been sent yet; the web app sends them and they are marked.
    ipcMain.handle('ubex:health-events', () => {
      const list = readHealth();
      const fresh = list.filter((e) => !e.reported);
      if (fresh.length) {
        try {
          fs.writeFileSync(healthFile(), JSON.stringify(list.map((e) => ({ ...e, reported: true })).slice(-50)));
        } catch (e) {}
      }
      return fresh.map(({ reported, ...e }) => e);
    });
  }

  // Ubex Chat links stay in the app (a meeting or board opened in a new tab gets its own window);
  // everything else goes to the person's browser.
  function wireContents(contents) {
    contents.setWindowOpenHandler(({ url, frameName }) => {
      // (1.5.7) The call in a window of its own (the web app's Realtime/CallPopout.js): an empty window of the app's
      // page that the page draws the call into, kept over other apps. Only this name, only empty.
      if (frameName === 'ubex-call' && (url === 'about:blank' || url === '') && isAppUrl(contents.getURL())) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            title: 'Call · Ubex Chat',
            alwaysOnTop: true,
            autoHideMenuBar: true,
            minWidth: 360,
            minHeight: 260,
            backgroundColor: background(),
            icon: path.join(__dirname, 'build/icon.png'),
          },
        };
      }
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
    live.picker = true;
    note(`screen-share picker opened (${sources.length} screens and windows)`);
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
        live.picker = false;
        note(`screen-share picker closed: ${source ? (source.id.startsWith('screen:') ? 'a screen chosen' : 'a window chosen') : 'cancelled'}`);
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
        // A meeting keeps running while its window is behind another one (see createWindow).
        backgroundThrottling: false,
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
      webPreferences.backgroundThrottling = false;
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
      const asked = Date.now();
      live.sharing = 'asking the system for the screens and windows';
      note('screen share asked: listing screens and windows');
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
        });
        note(`screen share: ${sources.length} sources after ${((Date.now() - asked) / 1000).toFixed(1)} s`);
        live.sharing = '';
        if (!sources.length) return callback({});
        const parent = BrowserWindow.getFocusedWindow() || mainWindow;
        const source = sources.length === 1 ? sources[0] : await pickSource(parent, sources);
        if (!source) return callback({});
        const streams = { video: source };
        // Windows can share what the computer is playing along with the screen.
        if (process.platform === 'win32' && request.audioRequested) streams.audio = 'loopback';
        callback(streams);
        note('screen share started');
      } catch (e) {
        live.sharing = '';
        note(`screen share failed: ${e && e.message}`);
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

  // (1.5.4) Installing an .rpm or .deb update. electron-updater does it with a blocking spawnSync of
  // `pkexec dnf install …` while the window is still open, so the whole app froze until the password was
  // typed and dnf had finished (dnf refreshes its package lists first, often a minute) — and looked hung
  // for good when the password window opened behind it. Here the same install runs in the background: the
  // window keeps working, the banner says it is installing, and the app restarts itself when it is done.
  // Cancelling the password leaves the app running with the update still ready.
  let downloadedFile = '';

  function packageType() {
    try {
      return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
    } catch (e) {
      return '';
    }
  }

  function hasCommand(cmd) {
    try {
      require('child_process').execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }

  function installLinuxPackage() {
    if (process.platform !== 'linux' || process.env.APPIMAGE || !downloadedFile || !fs.existsSync(downloadedFile)) return false;
    const type = packageType();
    if ((type !== 'rpm' && type !== 'deb') || !hasCommand('pkexec')) return false;
    const file = `'${downloadedFile.replace(/'/g, `'\\''`)}'`;
    const script =
      type === 'rpm'
        ? hasCommand('dnf')
          ? `dnf install --nogpgcheck -y ${file}`
          : `rpm -Uvh --replacepkgs ${file}`
        : `dpkg -i ${file} || apt-get install -f -y`;
    // (1.5.8) What to run by hand when the password window cannot open: shown in the banner to copy.
    const command = type === 'rpm' ? `sudo dnf install ${file}` : `sudo apt install ${file}`;
    setUpdateState({ state: 'installing', failed: '', detail: '', command });
    let child;
    const started = Date.now();
    try {
      // stderr kept: pkexec and dnf say there why they stopped (1.5.8; before, it went nowhere).
      child = require('child_process').spawn('pkexec', ['/bin/sh', '-c', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      setUpdateState({ state: 'ready', failed: 'error', detail: String((e && e.message) || e).slice(0, 300) });
      return true;
    }
    let said = '';
    if (child.stderr) child.stderr.on('data', (d) => { said = (said + d).slice(-4000); });
    child.on('error', (e) => setUpdateState({ state: 'ready', failed: 'error', detail: String((e && e.message) || e).slice(0, 300) }));
    note(`installing the update (${type}), asking for the password`);
    child.on('exit', (code) => {
      const took = Date.now() - started;
      note(`update install ended: code ${code} after ${(took / 1000).toFixed(1)} s`);
      if (code === 0) {
        writeRun(false);
        recordExit('quit');
        relaunch();
        return;
      }
      // pkexec: 126 the password window was closed, 127 not authorised — or, within a moment and with no window
      // ever shown, no password window could open at all (no authentication agent for this app): 'nowindow'.
      const text = said.trim();
      const nowindow = (code === 126 || code === 127) && (took < 2500 || /authentication agent|no session|not authorized/i.test(text));
      const failed = nowindow ? 'nowindow' : code === 126 || code === 127 ? 'cancelled' : 'error';
      const detail = text.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
      setUpdateState({ state: 'ready', failed, detail });
      recordHealth('The update did not install', [
        `Version ${updateState.version}, ${type} package ${path.basename(downloadedFile)}`,
        `pkexec exit code ${code} after ${(took / 1000).toFixed(1)} s (${failed})`,
        `What it said: ${text.slice(-1500) || 'nothing'}`,
      ]);
    });
    return true;
  }

  // (1.5.8) The downloaded package opened by the system's own installer (GNOME Software, Discover…), which asks
  // for the password itself: the way in when pkexec cannot show its window. True when it opened.
  async function openUpdatePackage() {
    if (process.platform !== 'linux' || !downloadedFile || !fs.existsSync(downloadedFile)) return false;
    note('opening the update package with the system installer');
    const err = await shell.openPath(downloadedFile);
    if (err) note(`could not open the package: ${err}`);
    return !err;
  }

  function setUpUpdates() {
    ipcMain.handle('ubex:update-state', () => updateState);
    ipcMain.handle('ubex:update-open-package', () => openUpdatePackage());
    ipcMain.on('ubex:update-install', () => {
      if (!updater || updateState.state !== 'ready') return;
      note(`"Restart to update" clicked (${updateState.version})`);
      if (installLinuxPackage()) return;
      updater.quitAndInstall(false, true);
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
    updater.on('update-downloaded', (info) => {
      downloadedFile = (info && info.downloadedFile) || '';
      setUpdateState({ state: 'ready', version: info.version, percent: 100, failed: '' });
    });
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
    // (1.5.5 on) The page closes one it no longer needs: a call's "Call from X" once the ring stops.
    ipcMain.on('ubex:notify-close', (event, tag) => {
      if (!windowOf(event)) return;
      const note = shown.get(String(tag || ''));
      if (note) {
        shown.delete(String(tag));
        note.close();
      }
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
    setUpHealth();
    setUpGraphics();
    // Once the GPU process is up, so the first health report already names the card and driver.
    setTimeout(readGpu, 5000);
    mainWindow = createWindow(appUrlFromArgs(process.argv));
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    setUpUpdates();
  });

  app.on('window-all-closed', () => app.quit());
}
