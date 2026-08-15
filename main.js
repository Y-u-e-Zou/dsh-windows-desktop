// DeepSeek Harness desktop shell (Electron main process)
// ======================================================
// - single-instance lock
// - starts `dsh web` in the background if it is not already running
//   (uses Electron's bundled Node + the shipped dsh runtime => no Node.js needed)
// - native window + system tray (close-to-tray)
// - manual "Check for Updates": offers a one-click update of @deepseek-ai/dsh
// - the version shown everywhere (title / tray / menu) follows the Harness version

'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = 3080;
const WEB_URL = `http://${HOST}:${PORT}`;
const REGISTRY_LATEST = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest';

let win = null;
let tray = null;
let serverProc = null;   // the dsh process we started (if any)
let quitting = false;
let updateCheckRunning = false;
let updating = false;
let currentAccountId = null;   // active account id (null = signed out)

// ---------------------------------------------------------------- utilities

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Raw TCP probe: immune to system proxy settings.
function portOpen(port, host = HOST, timeout = 1500) {
  return new Promise(resolve => {
    const s = new net.Socket();
    let done = false;
    s.setTimeout(timeout);
    s.once('connect', () => { if (!done) { done = true; resolve(true); } s.destroy(); });
    s.once('error', () => { if (!done) { done = true; resolve(false); } });
    s.once('timeout', () => { if (!done) { done = true; resolve(false); } s.destroy(); });
    s.connect(port, host);
  });
}

async function waitForPort(port, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portOpen(port)) return true;
    await sleep(300);
  }
  return false;
}

// ------------------------------------------------- resolve node + dsh CLI

function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
    }
  }
  return null;
}

function findDshBinJs() {
  const base = path.join(process.env.LOCALAPPDATA || process.env.HOME || '', 'npm-cache', '_npx');
  let candidates = [];
  try {
    for (const entry of fs.readdirSync(base)) {
      const p = path.join(base, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(p)) candidates.push({ p, mtime: fs.statSync(p).mtimeMs });
    }
  } catch (e) { /* ignore */ }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? candidates[0].p : null;
}

// Locate the dsh runtime dir, newest-first: user-writable updated copy,
// then the bundled (installer) copy, then the dev-mode copy.
function dshRuntimeRoot() {
  const candidates = [
    path.join(app.getPath('userData'), 'dsh-runtime'),   // updated copy (writable)
    path.join(process.resourcesPath, 'dsh-runtime'),     // bundled in installer
    path.join(__dirname, 'dsh-runtime'),                 // dev mode (npm start)
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return c;
    } catch (e) { /* ignore */ }
  }
  return null;
}

function resolveLaunchCommand() {
  // 1) A local dsh runtime (bundled or updated): run it with Electron's own
  //    Node (ELECTRON_RUN_AS_NODE), so the target machine needs no Node.js.
  const runtime = dshRuntimeRoot();
  const localBin = runtime ? path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null;
  if (localBin && fs.existsSync(localBin)) {
    return { file: process.execPath, args: ['--expose-internals', localBin, 'web', '--port', String(PORT)], runAsNode: true };
  }

  // 2) Dev mode (npm start): system Node + npx-cached dsh.
  const node = findOnPath('node');
  if (!node) return null;
  const bin = findDshBinJs();
  if (bin) return { file: node, args: ['--expose-internals', bin, 'web', '--port', String(PORT)], runAsNode: false };

  // fallback: npm's bundled npx
  const npxCli = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (fs.existsSync(npxCli)) {
    return { file: node, args: [npxCli, '--yes', '@deepseek-ai/dsh', 'web', '--port', String(PORT)], runAsNode: false };
  }
  return null;
}

function startServer(dshHome) {
  const cmd = resolveLaunchCommand();
  if (!cmd) return null;

  const logPath = path.join(app.getPath('userData'), 'dsh-server.log');
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (e) { /* ignore */ }

  const env = cmd.runAsNode
    ? Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
    : process.env;
  if (dshHome) env.DSH_HOME = dshHome;
  if (cmd.runAsNode) env.DSH_APP_DIR = path.dirname(process.execPath);   // picker default = install location

  // Open the log synchronously so spawn gets a valid fd: a freshly-created
  // WriteStream has fd:null and makes spawn throw ERR_INVALID_ARG_VALUE.
  let child;
  try {
    const logFd = fs.openSync(logPath, 'a');
    try {
      child = spawn(cmd.file, cmd.args, {
        cwd: process.env.DSH_WORKSPACE || app.getPath('home'),   // workspace root for dsh
        env,
        windowsHide: true,              // no console flash on Windows
        stdio: ['ignore', logFd, logFd],
      });
    } finally {
      try { fs.closeSync(logFd); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    // last resort: run without capturing output
    try {
      child = spawn(cmd.file, cmd.args, {
        cwd: process.env.DSH_WORKSPACE || app.getPath('home'),
        env,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (e2) { return null; }
  }
  child.on('error', () => { /* handled by waitForPort timeout */ });
  return child;
}

function stopServer() {
  if (serverProc && !serverProc.killed) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        serverProc.kill('SIGTERM');
      }
    } catch (e) { /* ignore */ }
  }
  serverProc = null;
}

// Kill any leftover process listening on our port (e.g. a stray dsh server),
// so a fresh server can bind. Skips our own process.
function killPortOwner(port) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('netstat', ['-ano'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { resolve(); return; }
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve());
    child.on('exit', () => {
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue;
        const pid = line.trim().split(/\s+/).pop();
        if (/^\d+$/.test(pid) && Number(pid) !== process.pid) {
          try { spawn('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
        }
        break;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------- updates

function dshVersion() {
  const r = dshRuntimeRoot();
  if (!r) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(r, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  } catch (e) { return null; }
}

// The single version the app presents = the Harness (dsh) version.
function appTitle() {
  const v = dshVersion();
  return v ? `DSH-Windows桌面版 ${v}` : 'DSH-Windows桌面版';
}

function npmCliPath() {
  const candidates = [
    path.join(process.resourcesPath, 'update-tools', 'npm', 'bin', 'npm-cli.js'),
    path.join(__dirname, 'update-tools', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

// Compare two semver-ish versions, handling "0.1.0-rc.6" style prereleases.
function compareVersions(a, b) {
  function parse(v) {
    const [core, ...rest] = String(v).split('-');
    const nums = core.split('.').map(n => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: rest.join('-') };
  }
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] > B.nums[i] ? 1 : -1;
  }
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;    // release > prerelease
  if (!B.pre) return -1;
  const at = A.pre.split('.'), bt = B.pre.split('.');
  for (let i = 0; i < Math.max(at.length, bt.length); i++) {
    const x = at[i], y = bt[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = parseInt(x, 10), yn = parseInt(y, 10);
    if (!isNaN(xn) && !isNaN(yn)) return xn > yn ? 1 : -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

async function latestDshVersion() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(REGISTRY_LATEST, { signal: ctrl.signal });
    if (!res.ok) throw new Error('registry HTTP ' + res.status);
    const j = await res.json();
    return j.version;
  } finally {
    clearTimeout(timer);
  }
}

// Re-apply the PowerShell folder picker after any dsh (re)install: npm
// install restores the koffi-backed Win32 picker, whose native binding can
// crash under Electron's built-in Node. This rewrites the native picker to
// open the .NET FolderBrowserDialog via powershell instead of koffi.
const POWERSHELL_PICKER_FN = `
/**
 * Electron-friendly Win32 picker: open the .NET FolderBrowserDialog in a
 * powershell child instead of the koffi-backed worker, whose native binding
 * can crash under Electron's built-in Node (ELECTRON_RUN_AS_NODE). The
 * initial directory is $env:DSH_APP_DIR (the shell's install location).
 */
function pickWin32ViaPowerShell(signal) {
	const script = [
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"Add-Type -AssemblyName System.Windows.Forms",
		"$f = New-Object System.Windows.Forms.Form",
		"$f.TopMost = $true",
		"$f.ShowInTaskbar = $false",
		"$f.WindowState = 'Minimized'",
		"$f.Show()",
		"$d = New-Object System.Windows.Forms.FolderBrowserDialog",
		"$d.Description = 'Select Workspace Directory'",
		"$d.ShowNewFolderButton = $true",
		"if ($env:DSH_APP_DIR -and (Test-Path $env:DSH_APP_DIR)) { $d.SelectedPath = $env:DSH_APP_DIR }",
		"$r = $d.ShowDialog($f)",
		"if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
		"$f.Close()"
	].join("; ");
	return new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"]
		});
		let out = "";
		let err = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { err += d; });
		const onAbort = () => { try { child.kill(); } catch { /* ignore */ } };
		signal.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("exit", (code) => {
			signal.removeEventListener("abort", onAbort);
			if (signal.aborted) { resolve(null); return; }
			if (code !== 0) { reject(new Error(err.trim() || 'powershell exited ' + code)); return; }
			const selected = out.trim();
			resolve(selected === "" ? null : selected);
		});
	});
}
`;

function applyNativePickerPatch(runtimeRoot) {
  const pickerPath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'index.js');
  try {
    let content = fs.readFileSync(pickerPath, 'utf8');
    if (content.includes('pickWin32ViaPowerShell')) return;   // already patched
    const sig = 'async function pickNativeDirectory(signal, internals = {}) {';
    if (!content.includes(sig)) return;
    content = content.replace(
      'if (platform === "win32") return await (internals.pickWin32Dialog ?? pickWin32Directory)(signal);',
      'if (platform === "win32") return await (internals.pickWin32Dialog ?? pickWin32ViaPowerShell)(signal);'
    );
    content = content.replace(sig, POWERSHELL_PICKER_FN + sig);
    fs.writeFileSync(pickerPath, content, 'utf8');
  } catch (e) { /* ignore */ }
}

// Re-apply our dsh tweaks after any dsh (re)install: npm install restores the
// default tool descriptions and permission confirmation copy. Keeps (1) the
// recycle-bin deletion guidance in the pwsh tool and (2) the strong
// Full-access warning in the permission confirmation dialog.
function applyDshTweaks(runtimeRoot) {
  // (1) move-to-垃圾箱 deletion guidance
  try {
    const pwshPath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-tool-pwsh', 'lib', 'index.js');
    let c = fs.readFileSync(pwshPath, 'utf8');
    if (!c.includes('垃圾箱')) {
      const old = 'not a command failure. " + (backgroundEnabled ?';
      const neo = 'not a command failure. When deleting files or directories, do NOT permanently delete them. Instead, move them into a folder named 垃圾箱 inside the session workspace (create it first with New-Item -ItemType Directory -Force (Join-Path (Get-Location) "垃圾箱") if missing), using Move-Item with a timestamp suffix to avoid name collisions. Only use Remove-Item (permanent delete) when the user explicitly asks for permanent removal. " + (backgroundEnabled ?';
      if (c.includes(old)) { c = c.replace(old, neo); fs.writeFileSync(pwshPath, c, 'utf8'); }
    }
  } catch (e) { /* ignore */ }

  // (2) strong Full-access warning copy
  try {
    const permPath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-permission-presets', 'lib', 'client.js');
    let c = fs.readFileSync(permPath, 'utf8');
    if (!c.includes('太可怕了')) {
      const old = '\t\t\t"confirm.title": "确认启用 Full access？",\n\t\t\t"confirm.description": "启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。",\n\t\t\t"confirm.acknowledge": "我已了解风险，并愿意继续",\n\t\t\t"confirm.cancel": "取消",\n\t\t\t"confirm.enable": "启用 Full access"';
      const neo = '\t\t\t"confirm.title": "⚠️ 高风险警告：确认启用 Full access？",\n\t\t\t"confirm.description": "Full access 是一个高风险选项，非专业人士不建议使用。启用后 AI 将不受任何限制，可能读写、覆盖甚至删除你电脑里的所有文件（有把整个电脑文件删光的风险）。",\n\t\t\t"confirm.acknowledge": "我已了解风险，并愿意继续",\n\t\t\t"confirm.cancel": "太可怕了，那我不用这个模式了",\n\t\t\t"confirm.enable": "没问题，我是专家，会控制预防这种情况"';
      if (c.includes(old)) { c = c.replace(old, neo); fs.writeFileSync(permPath, c, 'utf8'); }
    }
  } catch (e) { /* ignore */ }

  // (3) strong Full-access warning in the in-conversation permission switch
  try {
    const convPath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js');
    let c = fs.readFileSync(convPath, 'utf8');
    if (!c.includes('太可怕了')) {
      const old = '\t\t\t"access.confirm.title": "确认启用 Full access？",\n\t\t\t"access.confirm.description": "启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。",\n\t\t\t"access.confirm.acknowledge": "我已了解风险，并愿意继续",\n\t\t\t"access.confirm.cancel": "取消",\n\t\t\t"access.confirm.enable": "启用 Full access"';
      const neo = '\t\t\t"access.confirm.title": "⚠️ 高风险警告：确认启用 Full access？",\n\t\t\t"access.confirm.description": "Full access 是一个高风险选项，非专业人士不建议使用。启用后 AI 将不受任何限制，可能读写、覆盖甚至删除你电脑里的所有文件（有把整个电脑文件删光的风险）。",\n\t\t\t"access.confirm.acknowledge": "我已了解风险，并愿意继续",\n\t\t\t"access.confirm.cancel": "太可怕了，那我不用这个模式了",\n\t\t\t"access.confirm.enable": "没问题，我是专家，会控制预防这种情况"';
      if (c.includes(old)) { c = c.replace(old, neo); fs.writeFileSync(convPath, c, 'utf8'); }
    }
  } catch (e) { /* ignore */ }
}

async function performUpdate(targetVersion) {
  const npmCli = npmCliPath();
  if (!npmCli) throw new Error('update tooling not found in this installation');

  // 1) stop the server we manage
  stopServer();

  // 2) ensure a writable runtime copy in userData (keep the bundled one pristine)
  const udRuntime = path.join(app.getPath('userData'), 'dsh-runtime');
  if (!fs.existsSync(path.join(udRuntime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    const bundled = path.join(process.resourcesPath, 'dsh-runtime');
    if (fs.existsSync(bundled)) fs.cpSync(bundled, udRuntime, { recursive: true });
  }

  // 3) install the new dsh into that writable runtime
  await new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
    const child = spawn(process.execPath, [
      npmCli, 'install', '--prefix', udRuntime,
      `@deepseek-ai/dsh@${targetVersion}`,
      '--no-audit', '--no-fund', '--loglevel=error',
    ], {
      cwd: udRuntime,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const cap = s => { tail = (tail + s.toString()).slice(-1000); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(tail || `npm install exited ${code}`))));
  });

  // 3.5) pin the browse directory picker (native's koffi worker crashes under Electron's Node)
  applyNativePickerPatch(udRuntime);
  applyDshTweaks(udRuntime);

  // 4) restart the server with the updated runtime, refresh the UI + version
  serverProc = startServer(currentAccountHome());
  await waitForPort(PORT, 60000);
  applyVersionDisplays();
  if (win) win.webContents.reload();
}

async function checkForUpdates(manual = false) {
  if (updateCheckRunning || updating) return;
  updateCheckRunning = true;
  try {
    const cur = dshVersion();
    const latest = await latestDshVersion();
    if (!cur || !latest) throw new Error('could not determine current/latest version');

    if (compareVersions(latest, cur) > 0) {
      const r = await dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: `DSH-Windows桌面版 ${latest} 可用`,
        detail: `当前版本 ${cur}，是否更新？`,
        buttons: ['立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) {
        updating = true;
        try {
          await performUpdate(latest);
          await dialog.showMessageBox({ type: 'info', title: 'Harness Update', message: `Updated to ${latest}.` });
        } catch (e) {
          await dialog.showMessageBox({ type: 'error', title: 'Update Failed', message: String((e && e.message) || e) });
          serverProc = startServer(currentAccountHome());   // try to recover
        } finally {
          updating = false;
        }
      }
    } else if (manual) {
      await dialog.showMessageBox({ type: 'info', title: 'Harness Update', message: `You are up to date (${cur}).` });
    }
  } catch (e) {
    if (manual) {
      await dialog.showMessageBox({ type: 'warning', title: 'Update Check Failed', message: String((e && e.message) || e) });
    }
  } finally {
    updateCheckRunning = false;
  }
}

// ---------------------------------------------------------------- credentials

function accountIdFromKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

function accountHome(accountId) {
  return path.join(app.getPath('home'), '.dsh-accounts', accountId);
}

function currentAccountHome() {
  return currentAccountId ? accountHome(currentAccountId) : undefined;
}

function statePath() {
  return path.join(app.getPath('userData'), 'account-state.json');
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { return {}; }
}

function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch (e) { /* ignore */ }
}

function readCredentialKey(credFile) {
  try {
    const raw = fs.readFileSync(credFile, 'utf8');
    const m = raw.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\r\n]+)/);
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}

function legacyApiKey() {
  return readCredentialKey(path.join(app.getPath('home'), '.dsh', '.credentials.yaml'));
}

function readAccountKey(accountId) {
  return readCredentialKey(path.join(accountHome(accountId), '.credentials.yaml'));
}

function writeAccountKey(accountId, key) {
  const home = accountHome(accountId);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.yaml'), `DEEPSEEK_API_KEY: ${key}\n`, 'utf8');
}

// one-time migration of legacy ~/.dsh data when the same key first logs in
function migrateLegacyIfMatch(accountId, key) {
  const home = accountHome(accountId);
  if (fs.existsSync(path.join(home, 'sessions'))) return;
  if (!key || legacyApiKey() !== key) return;
  const legacy = path.join(app.getPath('home'), '.dsh');
  for (const sub of ['sessions', 'storages']) {
    const s = path.join(legacy, sub);
    const d = path.join(home, sub);
    try { if (fs.existsSync(s)) fs.cpSync(s, d, { recursive: true }); } catch (e) { /* ignore */ }
  }
  try {
    const set = path.join(legacy, 'settings.yaml');
    if (fs.existsSync(set)) fs.copyFileSync(set, path.join(home, 'settings.yaml'));
  } catch (e) { /* ignore */ }
}

async function startWithAccount(accountId) {
  const key = readAccountKey(accountId);
  if (!key) return false;
  stopServer();
  await killPortOwner(PORT);
  serverProc = startServer(accountHome(accountId));
  if (!serverProc) return false;
  const ok = await waitForPort(PORT, 60000);
  if (ok) {
    currentAccountId = accountId;
    writeState({ accountId });
    return true;
  }
  return false;
}

async function loginWithKey(key) {
  const accountId = accountIdFromKey(key);
  migrateLegacyIfMatch(accountId, key);
  writeAccountKey(accountId, key);
  return startWithAccount(accountId);
}

async function submitLogin(key) {
  if (!key) return;
  const ok = await loginWithKey(key);
  if (!ok) {
    await dialog.showMessageBox({ type: 'error', title: 'Harness', message: '登录失败：服务未能启动，请检查 API Key 后重试。' });
    return;
  }
  if (win) win.loadURL(WEB_URL);
  applyVersionDisplays();
}

async function logout() {
  const r = await dialog.showMessageBox({
    type: 'question',
    title: 'Harness',
    message: '确定要注销账户吗？',
    detail: '将退出当前 API 账号并关闭窗口，聊天记录会保留在该账号下。',
    buttons: ['注销', '取消'],
    defaultId: 1,
    cancelId: 1,
  });
  if (r.response !== 0) return;

  stopServer();
  currentAccountId = null;
  writeState({});
  if (!win) createWindow();
  win.loadFile('login.html');
  win.show();

  await dialog.showMessageBox({ type: 'info', title: 'Harness', message: '已退出登录。' });
}

async function switchApiKey() {
  const cur = currentAccountId ? readAccountKey(currentAccountId) : '';
  if (!win) createWindow();
  win.loadFile('login.html', { query: cur ? { key: cur } : {} });
  win.show();
  win.focus();
}

// ---------------------------------------------------------------- windows

function iconPath(size) {
  const p = path.join(__dirname, 'assets', size === 32 ? 'tray.png' : 'icon.png');
  return fs.existsSync(p) ? p : null;
}

function createWindow() {
  const icon = iconPath(256);
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 600,
    title: appTitle(),
    backgroundColor: '#0b0e14',
    icon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // keep our versioned title (don't let the page <title> overwrite it)
  win.on('page-title-updated', (e) => e.preventDefault());

  // open external links in the default browser, never inside the shell
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // login page navigation (dsh-login:// and dsh-open://)
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('dsh-login://')) {
      e.preventDefault();
      submitLogin(decodeURIComponent(url.slice('dsh-login://'.length)));
    } else if (url.startsWith('dsh-open://')) {
      e.preventDefault();
      shell.openExternal(decodeURIComponent(url.slice('dsh-open://'.length)));
    }
  });

  // closing hides to tray instead of quitting
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });

  // initial content depends on login state
  if (currentAccountId) {
    win.loadURL(WEB_URL);
  } else {
    win.loadFile('login.html');
  }
}

function showWindow() {
  if (!win) createWindow();   // loads Harness or the login page based on state
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

let helpWin = null;
function showHelp() {
  if (helpWin && !helpWin.isDestroyed()) { helpWin.show(); helpWin.focus(); return; }
  helpWin = new BrowserWindow({
    width: 680,
    height: 740,
    parent: win || undefined,
    title: '帮助',
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    icon: iconPath(256),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  helpWin.loadFile('help.html');
  helpWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  helpWin.on('closed', () => { helpWin = null; });
}

let petWin = null;
let petAlarm = null;      // { hour, minute }
let petTimerEnd = null;   // timestamp (ms)

function showPet() {
  if (petWin && !petWin.isDestroyed()) {
    petWin.show();
    return;
  }
  petWin = new BrowserWindow({
    width: 230,
    height: 310,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('dsh-pet://alarm')) { e.preventDefault(); setPetAlarm(); }
    else if (url.startsWith('dsh-pet://timer')) { e.preventDefault(); setPetTimer(); }
  });
  petWin.loadFile('pet.html');
  petWin.on('closed', () => { petWin = null; });
}

// Menu toggle: show/hide the pet window (does NOT destroy it).
function togglePet() {
  if (petWin && !petWin.isDestroyed()) {
    if (petWin.isVisible()) { petWin.hide(); } else { petWin.show(); }
    return;
  }
  showPet();
}

function promptText(title, placeholder) {
  return new Promise((resolve) => {
    const pwin = new BrowserWindow({
      width: 380, height: 220,
      parent: petWin || win || undefined,
      modal: !!(petWin || win),
      resizable: false, minimizable: false,
      title, autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:20px;background:#1e222d;color:#e6e8ee}
h3{margin:0 0 8px;font-size:15px}
input{width:100%;box-sizing:border-box;padding:9px;font-size:14px;border:1px solid #3a4152;border-radius:6px;background:#151821;color:#e6e8ee;outline:none;margin-bottom:12px}
.btns{text-align:right}
button{padding:7px 14px;margin-left:8px;border:0;border-radius:6px;cursor:pointer;font-size:13px}
#ok{background:#4d6bfe;color:#fff}#cancel{background:#2a3140;color:#cfd4dd}
</style></head><body>
<h3>${title}</h3>
<input id="v" type="text" placeholder="${placeholder}">
<div class="btns"><button id="cancel">取消</button><button id="ok">确定</button></div>
<script>
document.getElementById('ok').onclick=function(){location.href='dsh-input://'+encodeURIComponent(document.getElementById('v').value.trim())};
document.getElementById('cancel').onclick=function(){location.href='dsh-input://__cancel__'};
document.getElementById('v').focus();
</script></body></html>`;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; if (!pwin.isDestroyed()) pwin.destroy(); resolve(v); } };
    pwin.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith('dsh-input://')) {
        e.preventDefault();
        const v = decodeURIComponent(url.slice('dsh-input://'.length));
        finish(v === '__cancel__' ? null : v);
      }
    });
    pwin.on('closed', () => finish(null));
    pwin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

function syncPetStatus() {
  if (!petWin || petWin.isDestroyed()) return;
  let text = '';
  if (petAlarm) text = '闹钟 ' + ('0' + petAlarm.hour).slice(-2) + ':' + ('0' + petAlarm.minute).slice(-2);
  if (petTimerEnd) {
    const left = Math.max(0, Math.round((petTimerEnd - Date.now()) / 60000));
    text += (text ? ' | ' : '') + '倒计时 ' + left + ' 分';
  }
  petWin.webContents.executeJavaScript(`window.__setStatus && window.__setStatus(${JSON.stringify(text)});`).catch(() => {});
}

async function setPetAlarm() {
  const v = await promptText('设定闹钟', '例如 14:30');
  if (!v) return;
  const m = v.match(/^(\d{1,2})[:：]?(\d{2})$/);
  if (!m) { await dialog.showMessageBox({ type: 'warning', title: '闹钟', message: '时间格式不对，请输入如 14:30' }); return; }
  const hour = parseInt(m[1], 10), minute = parseInt(m[2], 10);
  if (hour > 23 || minute > 59) { await dialog.showMessageBox({ type: 'warning', title: '闹钟', message: '时间超出范围' }); return; }
  petAlarm = { hour, minute };
  syncPetStatus();
  showPet();
}

async function setPetTimer() {
  const v = await promptText('设定倒计时', '例如 10（分钟）');
  if (!v) return;
  const mins = parseInt(v, 10);
  if (isNaN(mins) || mins <= 0) { await dialog.showMessageBox({ type: 'warning', title: '倒计时', message: '请输入正数分钟' }); return; }
  petTimerEnd = Date.now() + mins * 60000;
  syncPetStatus();
  showPet();
}

function triggerPetRing(label) {
  showPet();
  let n = 0;
  const beep = setInterval(() => {
    try { shell.beep(); } catch (e) { /* ignore */ }
    if (++n >= 5) clearInterval(beep);
  }, 350);
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.executeJavaScript(`window.__ring && window.__ring(${JSON.stringify(label)});`).catch(() => {});
  }
}

function startPetClock() {
  setInterval(() => {
    const now = new Date();
    if (petAlarm && now.getHours() === petAlarm.hour && now.getMinutes() === petAlarm.minute && now.getSeconds() === 0) {
      const label = '闹钟';
      petAlarm = null;
      triggerPetRing(label);
      syncPetStatus();
    }
    if (petTimerEnd && now.getTime() >= petTimerEnd) {
      const label = '倒计时';
      petTimerEnd = null;
      triggerPetRing(label);
      syncPetStatus();
    }
    if (petTimerEnd && now.getSeconds() === 0) syncPetStatus();
  }, 1000);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: appTitle(), enabled: false },
    { type: 'separator' },
    { label: '显示主窗口', click: () => showWindow() },
    { label: '检查更新', click: () => checkForUpdates(true) },
    { label: '切换账号（API Key）', click: () => switchApiKey() },
    { label: '注销账户', click: () => logout() },
    { label: '申请 API（注册账户）', click: () => shell.openExternal('https://platform.deepseek.com/') },
    { label: '桌面精灵', click: () => togglePet() },
    { label: '帮助', click: () => showHelp() },
    { label: '在浏览器中打开', click: () => shell.openExternal(WEB_URL) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
}

function installAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Harness',
      submenu: [
        { label: appTitle(), enabled: false },
        { type: 'separator' },
        { label: '检查更新', click: () => checkForUpdates(true) },
        { label: '切换账号（API Key）', click: () => switchApiKey() },
        { label: '注销账户', click: () => logout() },
        { label: '申请 API（注册账户）', click: () => shell.openExternal('https://platform.deepseek.com/') },
        { label: '桌面精灵', click: () => togglePet() },
        { label: '帮助', click: () => showHelp() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
  ]));
}

function applyVersionDisplays() {
  if (win) win.setTitle(appTitle());
  if (tray) {
    tray.setToolTip(appTitle());
    tray.setContextMenu(buildTrayMenu());
  }
}

function createTray() {
  const p = iconPath(32);
  const img = p ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.on('double-click', () => showWindow());
  applyVersionDisplays();
}

// ---------------------------------------------------------------- startup

async function onReady() {
  installAppMenu();
  createTray();

  // 1) resume the last account
  let loggedIn = false;
  const state = readState();
  if (state.accountId) {
    loggedIn = await startWithAccount(state.accountId);
  }

  // 2) first run: migrate the legacy ~/.dsh key
  if (!loggedIn) {
    const legacyKey = legacyApiKey();
    if (legacyKey) loggedIn = await loginWithKey(legacyKey);
  }

  // 3) create the window (loads Harness if logged in, else the login page)
  createWindow();

  // 4) desktop pet alarm/timer clock
  startPetClock();
}

app.setAppUserModelId('com.dsh.windows.desktop');

// Allow overriding the user-data dir (portable use, or tests). Default is %APPDATA%.
if (process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USER_DATA);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(onReady);
}

// stop the server we started, but leave an externally-started one alone
app.on('before-quit', () => {
  quitting = true;
  stopServer();
});

app.on('window-all-closed', () => {
  // keep running in the tray on Windows; quit on other platforms
  if (process.platform !== 'win32') app.quit();
});
