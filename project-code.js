// (1.5.9) A project's code on this computer: the web app's Code button (Projects/ProjectCode.jsx) asks the desktop app
// to keep a folder for each of a project's GitHub repositories, to get the code into it (a git clone the first time,
// a pull after that), to open it, and to save a repository as a ZIP.
//
// The page never names a path: it names a project and a repository, and the folder is the one the person picked in
// this app's own folder window, remembered in project-code.json in the app's data folder — so a page could not point
// git at a folder of its choosing. Git runs with the person's own GitHub token (from the server's POST /projects/code,
// a few hours' life), handed to git through its environment for that one command: it is not in the command line
// other programs can see, and it is never written into the repository's settings. The repository's remote is the
// plain https://github.com/<owner>/<name>.git, so pulling from a terminal later uses the person's own git login.
//
// A pull only fast-forwards. Changes made in the folder that clash with it stop it with git's own message, and
// nothing is overwritten.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const KEY = /^[A-Za-z0-9-]{1,64}\|[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const GIT_TIMEOUT = 15 * 60 * 1000;

function validBranch(b) {
  return typeof b === 'string' && /^[A-Za-z0-9._\/-]{1,200}$/.test(b) && !b.startsWith('-') && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock');
}

// github.com/<owner>/<name> from any of the ways a remote is written (https, ssh, with or without .git).
function repoOfRemote(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : '';
}

module.exports = function setUpProjectCode({ ipcMain, dialog, shell, app, isAppUrl, window: getWindow, note }) {
  const fromApp = (event) => !!(event.senderFrame && isAppUrl(event.senderFrame.url));
  const storeFile = () => path.join(app.getPath('userData'), 'project-code.json');

  function readStore() {
    try {
      const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (e) {
      return {};
    }
  }
  function writeStore(data) {
    try {
      fs.writeFileSync(storeFile(), JSON.stringify(data, null, 1));
    } catch (e) {}
  }
  const folderOf = (key) => {
    const p = readStore()[key];
    return typeof p === 'string' && path.isAbsolute(p) ? p : '';
  };
  function remember(key, folder) {
    const data = readStore();
    if (folder) data[key] = folder;
    else delete data[key];
    writeStore(data);
  }

  // git with the token for github.com only, for this one command. `token` may be empty (status reads).
  function git(args, { cwd, token } = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', LC_ALL: 'C' };
    if (token) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    }
    return new Promise((resolve) => {
      execFile('git', args, { cwd, env, timeout: GIT_TIMEOUT, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim();
        resolve({ ok: !error, code: error ? (error.code === 'ENOENT' ? 'missing' : error.killed ? 'timeout' : error.code) : 0, output });
      });
    });
  }

  let gitVersion = null;
  async function gitInstalled() {
    if (gitVersion === null) {
      const r = await git(['--version']);
      gitVersion = r.ok ? r.output.replace(/^git version\s*/i, '') : '';
    }
    return gitVersion;
  }

  // What is in a folder: missing | empty | other (files, not a repository) | repo (with its GitHub repository,
  // branch and how many files are changed).
  async function describe(folder) {
    if (!folder) return { path: '', state: 'none' };
    let entries;
    try {
      entries = fs.readdirSync(folder);
    } catch (e) {
      return { path: folder, state: 'missing' };
    }
    if (!entries.includes('.git')) return { path: folder, state: entries.length ? 'other' : 'empty' };
    const remote = await git(['config', '--get', 'remote.origin.url'], { cwd: folder });
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder });
    const status = await git(['status', '--porcelain'], { cwd: folder });
    return {
      path: folder,
      state: 'repo',
      repo: repoOfRemote(remote.output),
      branch: branch.ok ? branch.output : '',
      changed: status.ok ? status.output.split('\n').filter(Boolean).length : 0,
    };
  }

  async function status(key) {
    const info = await describe(folderOf(key));
    return { ...info, git: await gitInstalled() };
  }

  async function clone(repo, branch, target, token) {
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (e) {
      return { ok: false, message: `The folder could not be made: ${e.message}` };
    }
    const r = await git(['clone', '--branch', branch, '--', `https://github.com/${repo}.git`, target], { token });
    return r.ok
      ? { ok: true, action: 'cloned', message: `Got ${repo} (${branch}) into ${target}.`, output: r.output }
      : { ok: false, message: r.code === 'timeout' ? 'Getting the code took too long and was stopped.' : 'Git could not get the code.', output: r.output };
  }

  async function pull(folder, branch, current, token) {
    const steps = [];
    const run = async (args) => {
      const r = await git(args, { cwd: folder, token });
      steps.push(`$ git ${args.join(' ')}\n${r.output}`.trim());
      return r;
    };
    let r = await run(['fetch', 'origin', branch]);
    if (!r.ok) return { ok: false, message: 'Git could not fetch from GitHub.', output: steps.join('\n\n') };
    if (current !== branch) {
      const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: folder });
      r = await run(local.ok ? ['switch', branch] : ['switch', '-c', branch, '--track', `origin/${branch}`]);
      if (!r.ok) return { ok: false, message: `Git could not switch to ${branch}. Changes in the folder may be in the way.`, output: steps.join('\n\n') };
    }
    r = await run(['merge', '--ff-only', `origin/${branch}`]);
    if (!r.ok) {
      return {
        ok: false,
        message: 'The folder has its own changes or commits that clash with GitHub, so nothing was changed. Sort them out with git, then pull again.',
        output: steps.join('\n\n'),
      };
    }
    const fresh = /Already up to date/i.test(r.output);
    return { ok: true, action: fresh ? 'up-to-date' : 'pulled', message: fresh ? `Already up to date with ${branch}.` : `Pulled the latest ${branch}.`, output: steps.join('\n\n') };
  }

  ipcMain.handle('ubex:code-status', async (event, key) => {
    if (!fromApp(event) || !KEY.test(String(key))) return null;
    return status(key);
  });

  ipcMain.handle('ubex:code-pick', async (event, key) => {
    if (!fromApp(event) || !KEY.test(String(key))) return null;
    const win = getWindow();
    const repo = key.split('|')[1];
    const res = await dialog.showOpenDialog(win || undefined, {
      title: `Folder for ${repo}`,
      buttonLabel: 'Use this folder',
      defaultPath: folderOf(key) || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return status(key);
    let folder = res.filePaths[0];
    // A folder of other things (~/Projects): the repository goes into a folder of its own name inside it.
    const info = await describe(folder);
    if (info.state === 'other') folder = path.join(folder, repo.split('/')[1]);
    remember(key, folder);
    note('project code: folder chosen');
    return status(key);
  });

  ipcMain.handle('ubex:code-forget', (event, key) => {
    if (!fromApp(event) || !KEY.test(String(key))) return false;
    remember(key, '');
    return true;
  });

  ipcMain.handle('ubex:code-open', async (event, key) => {
    if (!fromApp(event) || !KEY.test(String(key))) return false;
    const folder = folderOf(key);
    return !!folder && (await shell.openPath(folder)) === '';
  });

  // Get the code: a clone into the folder when it has none yet, a pull when it is the repository.
  ipcMain.handle('ubex:code-sync', async (event, req) => {
    const { key, branch, token } = req || {};
    if (!fromApp(event) || !KEY.test(String(key)) || !validBranch(branch) || !TOKEN.test(String(token))) {
      return { ok: false, message: 'That request could not be used.' };
    }
    const repo = key.split('|')[1];
    if (!(await gitInstalled())) {
      return { ok: false, code: 'no-git', message: 'Git is not installed on this computer. Install it (git-scm.com), or download the code as a ZIP.' };
    }
    const folder = folderOf(key);
    if (!folder) return { ok: false, code: 'no-folder', message: 'Choose a folder first.' };
    const info = await describe(folder);
    let result;
    if (info.state === 'missing' || info.state === 'empty') result = await clone(repo, branch, folder, token);
    else if (info.state === 'repo') {
      if (info.repo !== repo.toLowerCase()) {
        result = { ok: false, message: `That folder holds ${info.repo || 'another repository'}, not ${repo}. Choose another folder.` };
      } else result = await pull(folder, branch, info.branch, token);
    } else {
      // Files but no repository (a ZIP unpacked there, say): git will not clone over them.
      result = { ok: false, message: 'That folder already has files that are not this repository. Choose an empty folder, or the folder that holds your copy.' };
    }
    note(`project code: ${result.ok ? result.action : 'get code failed'}`);
    return { ...result, status: await status(key) };
  });

  // The repository at a branch, as the ZIP GitHub makes, saved where the person chooses.
  ipcMain.handle('ubex:code-download', async (event, req) => {
    const { repo, branch, token } = req || {};
    if (!fromApp(event) || !REPO.test(String(repo)) || !validBranch(branch) || !TOKEN.test(String(token))) {
      return { ok: false, message: 'That request could not be used.' };
    }
    const name = `${repo.split('/')[1]}-${branch.replace(/[\/]/g, '-')}.zip`;
    const res = await dialog.showSaveDialog(getWindow() || undefined, {
      title: `Download ${repo}`,
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
    try {
      // GitHub answers with a redirect to a short-lived download link; fetch drops the token when it follows it.
      const reply = await fetch(`https://api.github.com/repos/${repo}/zipball/${branch}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Ubex-Chat-Desktop' },
      });
      if (!reply.ok || !reply.body) {
        return { ok: false, message: reply.status === 404 ? 'GitHub says your account cannot read that repository or branch.' : `GitHub answered ${reply.status}.` };
      }
      const part = `${res.filePath}.part`;
      await pipeline(Readable.fromWeb(reply.body), fs.createWriteStream(part));
      fs.renameSync(part, res.filePath);
      shell.showItemInFolder(res.filePath);
      note('project code: ZIP downloaded');
      return { ok: true, path: res.filePath };
    } catch (e) {
      try {
        fs.unlinkSync(`${res.filePath}.part`);
      } catch (x) {}
      return { ok: false, message: `The download failed: ${e.message}` };
    }
  });
};
