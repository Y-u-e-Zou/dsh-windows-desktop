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
  // Re-apply shell tweaks to whichever runtime this launch uses, so a
  // reinstall or runtime refresh never loses them (idempotent checks).
  try {
    const rt = dshRuntimeRoot();
    if (rt) { applyNativePickerPatch(rt); applyDshTweaks(rt); }
  } catch (e) { /* ignore */ }

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
// recycle-bin deletion guidance in the pwsh tool, (2)/(3) the strong
// Full-access warnings in the permission dialogs, and (4) the
// permission-denial two-option rule (manual steps + optional temporary
// elevation) that replaces auto-escalation with sandbox_permissions.
function applyDshTweaks(runtimeRoot) {
  // (1) move-to-垃圾箱 deletion guidance
  try {
    const pwshPath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-tool-pwsh', 'lib', 'index.js');
    let c = fs.readFileSync(pwshPath, 'utf8');
    if (!c.includes('垃圾箱')) {
      const old = 'not a command failure. " + (backgroundEnabled ?';
      const neo = 'not a command failure. When deleting files or directories, do NOT permanently delete them. Instead, move them into a folder named 垃圾箱 inside the session workspace (create it first with New-Item -ItemType Directory -Force (Join-Path (Get-Location) \\"垃圾箱\\") if missing), using Move-Item with a timestamp suffix to avoid name collisions. Only use Remove-Item (permanent delete) when the user explicitly asks for permanent removal. " + (backgroundEnabled ?';
      if (c.includes(old)) { c = c.replace(old, neo); fs.writeFileSync(pwshPath, c, 'utf8'); }
    }
  } catch (e) { /* ignore */ }

  // (2) strong Full-access warning copy — 0.1.1-rc.1 renamed Full access→完全权限
  //     and agent→智能体, so the old anchors drifted. Both confirm blocks now have
  //     their own marker and anchor.
  try {
    const permPath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-permission-presets', 'lib', 'client.js');
    let c = fs.readFileSync(permPath, 'utf8');
    let changed = false;
    // (2a) new-session default permission dialog (zh dict)
    if (!c.includes('后续新会话中的 AI')) {
      const old = '\t\t\t"confirm.title": "确认启用完全权限？",\n\t\t\t"confirm.description": "启用完全权限后，新会话将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。",\n\t\t\t"confirm.acknowledge": "我已了解风险，并愿意继续",\n\t\t\t"confirm.cancel": "取消",\n\t\t\t"confirm.enable": "启用完全权限"';
      const neo = '\t\t\t"confirm.title": "⚠️ 高风险警告：确认启用完全权限？",\n\t\t\t"confirm.description": "完全权限是一个高风险选项，非专业人士不建议使用。启用后，后续新会话中的 AI 将不受任何限制，可能读写、覆盖甚至删除你电脑里的所有文件（有把整个电脑文件删光的风险）。",\n\t\t\t"confirm.acknowledge": "我已了解风险，并愿意继续",\n\t\t\t"confirm.cancel": "太可怕了，那我不用这个模式了",\n\t\t\t"confirm.enable": "没问题，我是专家，会控制预防这种情况"';
      if (c.includes(old)) { c = c.replace(old, neo); changed = true; }
    }
    // (2b) current-session popup gate (accessZh dict)
    if (!c.includes('当前会话的 AI')) {
      const old = '\t\t\t"confirm.title": "确认启用完全权限？",\n\t\t\t"confirm.description": "启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。",\n\t\t\t"confirm.acknowledge": "我已了解风险，并愿意继续",\n\t\t\t"confirm.cancel": "取消",\n\t\t\t"confirm.enable": "启用完全权限"';
      const neo = '\t\t\t"confirm.title": "⚠️ 高风险警告：确认启用完全权限？",\n\t\t\t"confirm.description": "完全权限是一个高风险选项，非专业人士不建议使用。启用后，当前会话的 AI 将不受任何限制，可能读写、覆盖甚至删除你电脑里的所有文件（有把整个电脑文件删光的风险）。",\n\t\t\t"confirm.acknowledge": "我已了解风险，并愿意继续",\n\t\t\t"confirm.cancel": "太可怕了，那我不用这个模式了",\n\t\t\t"confirm.enable": "没问题，我是专家，会控制预防这种情况"';
      if (c.includes(old)) { c = c.replace(old, neo); changed = true; }
    }
    if (changed) fs.writeFileSync(permPath, c, 'utf8');
  } catch (e) { /* ignore */ }

  // (3) strong Full-access warning in the in-conversation permission switch
  //     (0.1.1-rc.1 renamed Full access→完全权限 / agent→智能体)
  try {
    const convPath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js');
    let c = fs.readFileSync(convPath, 'utf8');
    if (!c.includes('太可怕了')) {
      const old = '\t\t\t"access.confirm.title": "确认启用完全权限？",\n\t\t\t"access.confirm.description": "启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。",\n\t\t\t"access.confirm.acknowledge": "我已了解风险，并愿意继续",\n\t\t\t"access.confirm.cancel": "取消",\n\t\t\t"access.confirm.enable": "启用完全权限"';
      const neo = '\t\t\t"access.confirm.title": "⚠️ 高风险警告：确认启用完全权限？",\n\t\t\t"access.confirm.description": "完全权限是一个高风险选项，非专业人士不建议使用。启用后，当前会话中的 AI 将不受任何限制，可能读写、覆盖甚至删除你电脑里的所有文件（有把整个电脑文件删光的风险）。",\n\t\t\t"access.confirm.acknowledge": "我已了解风险，并愿意继续",\n\t\t\t"access.confirm.cancel": "太可怕了，那我不用这个模式了",\n\t\t\t"access.confirm.enable": "没问题，我是专家，会控制预防这种情况"';
      if (c.includes(old)) { c = c.replace(old, neo); fs.writeFileSync(convPath, c, 'utf8'); }
    }
  } catch (e) { /* ignore */ }

  // (4) permission-denial rule: instead of auto-escalating with
  //     sandbox_permissions, present ① manual steps and ② optional temporary
  //     elevation, and only escalate after the user explicitly picks ②.
  try {
    const pwshRulePath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-tool-pwsh', 'lib', 'index.js');
    let c = fs.readFileSync(pwshRulePath, 'utf8');
    if (!c.includes('手动方案')) {
      const old = 'When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents.';
      const neo = 'When a command is denied and a wider mode would let it succeed, do NOT retry it with `sandbox_permissions` on your own. Stop and answer with two options side by side: ① 手动方案 (manual path) — explain exactly which step was denied and why it needs wider access, then give the complete command or steps the user can run themselves in their own terminal, so no elevation is needed; ② 临时提权 (temporary elevation) — state which `sandbox_permissions` level (`workspace-write` or `danger-full-access`) and the exact command you would retry, and only retry it with `sandbox_permissions` plus a one-sentence `justification` after the user explicitly chooses this option. Default to waiting for the user\'s choice — do not escalate proactively, and present both options before asking for approval.';
      if (c.includes(old)) { c = c.replace(old, neo); fs.writeFileSync(pwshRulePath, c, 'utf8'); }
    }
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- update hardening

// Files our runtime patches rewrite. After every update the CommonJS ones are
// syntax-checked again (the ESM browser bundles can't be parsed by `--check`
// and are covered by the boot probe instead).
function patchedFiles(runtimeRoot) {
  return [
    path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-tool-pwsh', 'lib', 'index.js'),
    path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'index.js'),
    path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-permission-presets', 'lib', 'client.js'),
    path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'),
  ];
}

function readDshPackageVersion(runtimeRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  } catch (e) { return null; }
}

function checkJsSyntax(file) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ['--check', file], {
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (e) { return resolve(false); }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

// Of the files we patch, only the ones whose ORIGINAL already passes `--check`
// (CommonJS) can be syntax-verified afterwards; the ESM browser bundles are
// excluded rather than misreported as broken.
async function verifiableJsFiles(runtimeRoot) {
  const out = [];
  for (const f of patchedFiles(runtimeRoot)) {
    if (!fs.existsSync(f)) continue;
    if (await checkJsSyntax(f)) out.push(f);
  }
  return out;
}

async function verifyPatchedFiles(files) {
  const bad = [];
  for (const f of files) {
    if (!(await checkJsSyntax(f))) bad.push(path.basename(f));
  }
  if (bad.length) throw new Error('patched files failed syntax check: ' + bad.join(', '));
}

function findFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0));
    srv.listen(0, HOST, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Boot the freshly installed runtime on a throwaway port: proves the new tree
// is complete and its built-in plugin stack loads BEFORE the live server is
// switched to it. Uses the same DSH_HOME / workspace / app-dir env as a real
// launch, so the actual web profile (including third-party plugins) is
// exercised too. The probe process is killed afterwards.
function probeRuntimeBoot(runtimeRoot) {
  const bin = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return new Promise((resolve) => {
    findFreePort().then((port) => {
      if (!port) return resolve({ ok: false, tail: 'no free port' });
      let child;
      try {
        const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
        const home = currentAccountHome();
        if (home) env.DSH_HOME = home;
        env.DSH_APP_DIR = path.dirname(process.execPath);
        child = spawn(process.execPath, ['--expose-internals', bin, 'web', '--port', String(port)], {
          cwd: process.env.DSH_WORKSPACE || app.getPath('home'),
          env,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (e) { return resolve({ ok: false, tail: String((e && e.message) || e) }); }
      let settled = false;
      let tail = '';
      const cap = (s) => { tail = (tail + s.toString()).slice(-1000); };
      child.stderr.on('data', cap);
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        if (ok) {
          try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
        }
        resolve({ ok, tail: ok ? '' : tail });
      };
      const poll = setInterval(() => {
        portOpen(port).then((ok) => { if (ok) finish(true); });
      }, 500);
      const timer = setTimeout(() => finish(false), 30000);
      child.on('error', () => finish(false));
      child.on('exit', () => finish(false));
    });
  });
}

async function verifyUpdatedRuntime(runtimeRoot, targetVersion) {
  const bin = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(bin)) throw new Error('installed runtime is incomplete (bin.js missing)');
  const v = readDshPackageVersion(runtimeRoot);
  if (!v) throw new Error('installed runtime is incomplete (dsh package.json unreadable)');
  if (v !== targetVersion) throw new Error('installed version mismatch: expected ' + targetVersion + ', got ' + v);
  const probe = await probeRuntimeBoot(runtimeRoot);
  if (!probe.ok) throw new Error('installed runtime failed to boot on a test port' + (probe.tail ? ': ' + probe.tail : ''));
}

async function performUpdate(targetVersion) {
  const npmCli = npmCliPath();
  if (!npmCli) throw new Error('update tooling not found in this installation');

  // 等进度窗口完成加载并画出初始内容，再开始后续步骤（避免窗口空白阶段）
  await beginUpdateProgress(targetVersion);

  // 1) stop the server we manage
  updateProgressStage('stop', '正在停止后台 dsh 服务（主窗口页面会暂时不可用）');
  stopServer();

  // 2) snapshot the current writable runtime so a failed update can roll back
  const udRuntime = path.join(app.getPath('userData'), 'dsh-runtime');
  const backupDir = path.join(app.getPath('userData'), 'dsh-runtime.prev');
  const hadRuntime = fs.existsSync(path.join(udRuntime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  updateProgressStage('backup', '把当前运行时备份为 dsh-runtime.prev');
  if (hadRuntime) {
    try { await fs.promises.rm(backupDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    try {
      await fs.promises.rename(udRuntime, backupDir);
    } catch (e) {
      throw new Error('无法备份当前运行时（可能有程序占用），已取消更新：' + String((e && e.message) || e));
    }
  }

  try {
    // 2.5) baseline copy (keep the bundled one pristine) — 异步复制，不阻塞主进程，
    //      进度窗口在此期间也能正常刷新
    if (!fs.existsSync(path.join(udRuntime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
      const bundled = path.join(process.resourcesPath, 'dsh-runtime');
      if (fs.existsSync(bundled)) {
        updateProgressStage('install', '正在准备运行环境（复制基线运行时，约数秒到数十秒）…');
        await fs.promises.cp(bundled, udRuntime, { recursive: true });
      }
    }

    // 3) install the new dsh into that writable runtime
    updateProgressStage('install', '正在通过 npm 下载并安装，请耐心等待（视网速约 1-5 分钟）');
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

    // 3.4) validate the fresh tree (complete / right version / boots) BEFORE
    //      patching; remember which patched files are CommonJS-checkable
    updateProgressStage('verify', '校验版本号并试启动新运行时');
    const checkable = await verifiableJsFiles(udRuntime);
    await verifyUpdatedRuntime(udRuntime, targetVersion);

    // 3.5) pin the browse directory picker (native's koffi worker crashes under Electron's Node)
    updateProgressStage('patch', '重新应用壳子定制补丁');
    applyNativePickerPatch(udRuntime);
    applyDshTweaks(udRuntime);
    await verifyPatchedFiles(checkable);
  } catch (e) {
    // roll back: drop the broken copy and restore the snapshot (or let the
    // app fall back to the pristine bundled runtime when there was none)
    updateProgressFail('更新失败，正在回滚到上一个版本…');
    try {
      await fs.promises.rm(udRuntime, { recursive: true, force: true });
      if (hadRuntime) await fs.promises.rename(backupDir, udRuntime);
    } catch (e2) { /* ignore */ }
    const failMsg = 'update failed and was rolled back to the previous version: ' + String((e && e.message) || e);
    setTimeout(() => closeUpdateProgressWindow(), 1500);   // 让失败状态可见片刻，随后弹出错误弹窗
    throw new Error(failMsg);
  }

  // success: drop the snapshot
  if (hadRuntime) { try { await fs.promises.rm(backupDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

  // 3.6) keep third-party profile plugins in lockstep with the new harness
  updateProgressStage('plugins', '通过 pnpm 同步第三方插件（约 1-2 分钟）');
  const pluginSync = await syncProfilePlugins(udRuntime);
  const pluginWarnings = pluginSync && !pluginSync.ok ? [`第三方插件同步失败：${pluginSync.error}`] : [];

  // 4) restart the server with the updated runtime, refresh the UI + version
  updateProgressStage('restart', '重启 dsh 服务并刷新界面（最多等待 60 秒）');
  serverProc = startServer(currentAccountHome());
  await waitForPort(PORT, 60000);
  applyVersionDisplays();
  closeUpdateProgressWindow();
  if (win) win.webContents.reload();
  return pluginWarnings;
}

// Sync the current account's third-party `web`-profile plugins (dependencies
// that also appear in `dsh.profile.bundles`) through the dsh CLI's pnpm
// forwarder, so a harness upgrade never leaves stale plugins behind. The CLI
// reconciles `dsh.profile.bundles` against the installed state afterwards.
async function syncProfilePlugins(runtimeRoot) {
  const home = currentAccountHome();
  if (!home) return { ok: true, synced: false, reason: 'no-account' };
  const profileDir = path.join(home, 'profiles', 'web');
  const manifestPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return { ok: true, synced: false, reason: 'no-profile' };

  let targets;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const deps = Object.keys(manifest.dependencies || {});
    const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
    targets = deps.filter((d) => bundles.includes(d));
  } catch (e) {
    return { ok: false, error: 'could not read profile manifest: ' + String((e && e.message) || e) };
  }
  if (!targets.length) return { ok: true, synced: false, reason: 'no-plugins' };

  // pnpm 11 auto-selects only releases at least `minimumReleaseAge` (default 3
  // days) old — brand-new plugin releases would be silently skipped. Clear it
  // so the sync can reach the latest versions.
  const wsPath = path.join(profileDir, 'pnpm-workspace.yaml');
  try {
    let ws = fs.readFileSync(wsPath, 'utf8');
    const re = /^(\s*)minimumReleaseAge:\s*(\S.*)?$/m;
    if (re.test(ws)) ws = ws.replace(re, '$1minimumReleaseAge: 0');
    else ws = ws.replace(/\s+$/, '') + '\nminimumReleaseAge: 0\n';
    fs.writeFileSync(wsPath, ws, 'utf8');
  } catch (e) { /* ignore */ }

  const bin = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(bin)) return { ok: false, error: 'dsh CLI not found in runtime' };

  try {
    await new Promise((resolve, reject) => {
      const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home });
      const child = spawn(process.execPath, ['--expose-internals', bin, 'plugin', '--profile', 'web', 'update', ...targets], {
        cwd: profileDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let tail = '';
      const cap = (s) => { tail = (tail + s.toString()).slice(-1000); };
      child.stdout.on('data', cap);
      child.stderr.on('data', cap);
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(tail || `pnpm update exited ${code}`))));
    });
    return { ok: true, synced: true, targets };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------- update progress window

// 更新期间的小进度窗口：主窗口页面依赖 dsh 服务渲染，更新第一步会停服务、
// 页面随即"假死"。本窗口是独立的 BrowserWindow，实时显示当前更新阶段。
let updateProgressWin = null;
let updateProgressSuppressed = false;   // 用户手动关闭后，本次更新不再弹出

const UPDATE_PROGRESS_STAGES = [
  { key: 'stop', label: '停止后台服务' },
  { key: 'backup', label: '备份当前运行时' },
  { key: 'install', label: '' },        // 文案包含目标版本号，开始更新时填充
  { key: 'verify', label: '校验新版本完整性' },
  { key: 'patch', label: '应用定制补丁' },
  { key: 'plugins', label: '同步第三方插件' },
  { key: 'restart', label: '重启服务并刷新界面' },
];

let updateProgressState = null;   // { version, failed, sub, stages: [{key,label,status}] }

function beginUpdateProgress(version) {
  updateProgressState = {
    version,
    failed: false,
    sub: '',
    stages: UPDATE_PROGRESS_STAGES.map((s) => ({
      key: s.key,
      label: s.key === 'install' ? `下载并安装 Harness ${version}（视网速约 1-5 分钟）` : s.label,
      status: 'pending',
    })),
  };
  showUpdateProgressWindow();
  // 等窗口真正加载并画出初始内容再继续，避免"空白窗口"阶段；
  // 2 秒兜底超时，保证任何情况下都不卡住更新流程。
  return new Promise((resolve) => {
    const w = updateProgressWin;
    if (!w) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; pushUpdateProgress(); resolve(); } };
    if (w.webContents.isLoading()) {
      w.webContents.once('did-finish-load', finish);
      setTimeout(finish, 2000);
    } else {
      finish();
    }
  });
}

function updateProgressStage(key, sub) {
  if (!updateProgressState) return;
  const st = updateProgressState.stages;
  const idx = st.findIndex((s) => s.key === key);
  if (idx < 0) return;
  for (let i = 0; i < st.length; i++) st[i].status = i < idx ? 'done' : 'pending';
  st[idx].status = 'doing';
  updateProgressState.sub = sub || '';
  pushUpdateProgress();
}

function updateProgressFail(sub) {
  if (!updateProgressState) return;
  updateProgressState.failed = true;
  for (const s of updateProgressState.stages) if (s.status === 'doing') s.status = 'fail';
  updateProgressState.sub = sub || '';
  pushUpdateProgress();
}

function showUpdateProgressWindow() {
  if (updateProgressWin || updateProgressSuppressed) return;
  updateProgressWin = new BrowserWindow({
    width: 430,
    height: 320,
    parent: win || undefined,
    title: 'Harness 更新中',
    autoHideMenuBar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0b0e14',
    icon: iconPath(256),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  updateProgressWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  updateProgressWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildUpdateProgressHtml(updateProgressState)));
  updateProgressWin.webContents.once('did-finish-load', pushUpdateProgress);
  updateProgressWin.on('closed', () => { updateProgressWin = null; updateProgressSuppressed = true; });
}

function pushUpdateProgress() {
  if (!updateProgressWin || updateProgressWin.isDestroyed() || !updateProgressState) return;
  updateProgressWin.webContents.executeJavaScript(`window.__progress(${JSON.stringify(updateProgressState)});`).catch(() => {});
}

function closeUpdateProgressWindow() {
  updateProgressState = null;
  if (updateProgressWin && !updateProgressWin.isDestroyed()) {
    try { updateProgressWin.destroy(); } catch (e) { /* ignore */ }
  }
  updateProgressWin = null;
  updateProgressSuppressed = false;   // 下次更新重新允许弹出
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildUpdateProgressHtml(state) {
  // 初始状态直接烙进 HTML：窗口首次绘制就有完整内容，不依赖 JS 推送
  const version = (state && state.version) || '';
  const rows = (state && state.stages ? state.stages : [])
    .map((s) => `<div class="stage st-pending"><span class="dot"></span><span>${escHtml(s.label)}</span></div>`)
    .join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>更新进度</title>
<style>
body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#0b0e14;color:#e8e8e8;margin:0;padding:16px 18px;user-select:none}
h1{font-size:14px;margin:0 0 2px;font-weight:600;color:#ffc966}
.sub{font-size:11px;color:#9aa0a6;margin-bottom:12px;min-height:15px}
.stage{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:13px;line-height:18px}
.dot{flex:none;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:10px}
.st-pending{color:#6b7280}
.st-pending .dot{background:#1c222b}
.st-doing{color:#ffc966;font-weight:600}
.st-doing .dot{background:rgba(255,176,32,.18);animation:pulse 1.2s ease-in-out infinite}
.st-done{color:#9aa0a6}
.st-done .dot{background:rgba(74,222,128,.16);color:#4ade80}
.st-fail{color:#f87171;font-weight:600}
.st-fail .dot{background:rgba(248,113,113,.18);color:#f87171}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
</style>
</head>
<body>
<h1 id="h">正在更新 Harness ${escHtml(version)}</h1>
<div class="sub" id="sub"></div>
<div id="stages">${rows}</div>
<script>
window.__progress = function (s) {
  s = s || {};
  document.getElementById('h').textContent = s.failed ? '更新失败' : ('正在更新 Harness ' + (s.version || ''));
  document.getElementById('sub').textContent = s.sub || '';
  var box = document.getElementById('stages');
  box.innerHTML = '';
  (s.stages || []).forEach(function (st) {
    var row = document.createElement('div');
    var cls = st.status === 'done' ? 'st-done' : (st.status === 'doing' ? 'st-doing' : (st.status === 'fail' ? 'st-fail' : 'st-pending'));
    row.className = 'stage ' + cls;
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.textContent = st.status === 'done' ? '✓' : (st.status === 'doing' ? '●' : (st.status === 'fail' ? '✕' : ''));
    var label = document.createElement('span');
    label.textContent = st.label;
    row.appendChild(dot);
    row.appendChild(label);
    box.appendChild(row);
  });
};
</script>
</body>
</html>`;
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
        detail: `当前版本 ${cur}，是否更新？\n\n更新 Harness 后会自动同步升级第三方插件。`,
        buttons: ['立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) {
        updating = true;
        try {
          const pluginWarnings = (await performUpdate(latest)) || [];
          let msg = `Updated to ${latest}.`;
          if (pluginWarnings.length) msg += `\n\n⚠️ ${pluginWarnings.join('\n⚠️ ')}`;
          await dialog.showMessageBox({ type: pluginWarnings.length ? 'warning' : 'info', title: 'Harness Update', message: msg });
        } catch (e) {
          await dialog.showMessageBox({ type: 'error', title: 'Update Failed', message: String((e && e.message) || e) });
          serverProc = startServer(currentAccountHome());   // try to recover
        } finally {
          updating = false;
          closeUpdateProgressWindow();
        }
      }
    } else if (manual) {
      const runtime = dshRuntimeRoot();
      const sync = runtime ? await syncProfilePlugins(runtime) : null;
      let msg = `You are up to date (${cur}).`;
      if (sync && sync.synced) msg += `\n\n第三方插件已同步：${sync.targets.join('、')}。完全重启 Harness 后生效。`;
      else if (sync && !sync.ok) msg += `\n\n⚠️ 第三方插件同步失败：${sync.error}`;
      await dialog.showMessageBox({ type: sync && !sync.ok ? 'warning' : 'info', title: 'Harness Update', message: msg });
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

// ---------------------------------------------------------------- peak-hour banner

// 界面最顶部的常驻提示条：高峰时段 token 价格贵，提醒节省 token。
// 由壳子在主窗口每次完成页面加载后注入；main.js 不随 harness 更新被覆盖，永久生效。
const PEAK_BANNER_ID = 'dsh-peak-banner';
const PEAK_BANNER_TEXT = '高峰时段（北京时间 9:00 - 12:00、14:00 - 18:00）token 价格贵，请节省 token';
const PEAK_BANNER_LINK_TEXT = '在浏览器中查看具体价格';
const PEAK_BANNER_LINK_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const PEAK_BANNER_CSS = `
#${PEAK_BANNER_ID}{flex:none;box-sizing:border-box;width:100%;min-height:26px;display:flex;align-items:center;justify-content:center;gap:8px;padding:3px 12px;background:linear-gradient(90deg,rgba(255,176,32,.14),rgba(255,176,32,.24),rgba(255,176,32,.14));color:var(--dsw-alias-label-primary,#e8e8e8);border-bottom:1px solid rgba(255,176,32,.35);font-size:12px;line-height:18px;letter-spacing:.2px;user-select:none;text-align:center}
#${PEAK_BANNER_ID} .dsh-peak-text{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${PEAK_BANNER_ID} .dsh-peak-link{flex:none;color:#ffc966;text-decoration:underline;text-underline-offset:2px;cursor:pointer;white-space:nowrap}
#${PEAK_BANNER_ID} .dsh-peak-link:hover{color:#ffd98f}
#${PEAK_BANNER_ID} .dsh-peak-close{flex:none;width:18px;height:18px;border:none;background:transparent;color:inherit;opacity:.6;cursor:pointer;border-radius:4px;padding:0;font-size:14px;line-height:18px;display:grid;place-items:center}
#${PEAK_BANNER_ID} .dsh-peak-close:hover{opacity:1;background:rgba(255,255,255,.14)}
body{display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important;margin:0!important}
#root{flex:1 1 0%!important;min-height:0!important;height:auto!important}
`;

function injectPeakBanner(wc) {
  wc.insertCSS(PEAK_BANNER_CSS).catch(() => {});
  const id = JSON.stringify(PEAK_BANNER_ID);
  const text = JSON.stringify(PEAK_BANNER_TEXT);
  const linkText = JSON.stringify(PEAK_BANNER_LINK_TEXT);
  const linkUrl = JSON.stringify(PEAK_BANNER_LINK_URL);
  wc.executeJavaScript(`(() => {
    if (document.getElementById(${id})) return;
    const bar = document.createElement('div');
    bar.id = ${id};
    const label = document.createElement('span');
    label.className = 'dsh-peak-text';
    label.textContent = ${text};
    const link = document.createElement('a');
    link.className = 'dsh-peak-link';
    link.textContent = ${linkText};
    link.href = ${linkUrl};
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = '在默认浏览器中打开 DeepSeek API 价格文档';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'dsh-peak-close';
    close.title = '本次会话不再显示';
    close.setAttribute('aria-label', '关闭提示条');
    close.textContent = '\\u00d7';
    close.addEventListener('click', () => bar.remove());
    bar.appendChild(label);
    bar.appendChild(link);
    bar.appendChild(close);
    document.body.prepend(bar);
  })();`).catch(() => {});
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

  // inject the peak-hour reminder banner after every full load of the web GUI
  win.webContents.on('did-finish-load', () => {
    try {
      if (!win || win.isDestroyed()) return;
      if (win.webContents.getURL().startsWith(WEB_URL)) injectPeakBanner(win.webContents);
    } catch (e) { /* ignore */ }
  });

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

// ---------------------------------------------------------------- help / custom diff list

// 当前版本相对原版 Harness 的定制改动清单（只保留"当前"差异，条目过时即删除——
// 帮助窗口直接渲染此清单，不记录历史）。改任何补丁或壳子功能时同步更新这里：
// 运行时补丁条目带 verify，帮助窗口打开时按活跃 runtime 实测是否生效。
const CUSTOM_MODIFICATIONS = [
  {
    id: 'accounts',
    title: '多账号隔离',
    detail: '每个 API Key 使用独立的数据目录，聊天记录互不可见。',
  },
  {
    id: 'app-update',
    title: '应用内检查更新',
    detail: '菜单「检查更新」可直接查询并一键升级 Harness 本体，并自动把 profile 中的第三方插件同步升级到最新版本（Harness 已是最新时也会同步插件）；更新前自动备份运行时，安装后先做完整性校验与试启动，失败自动回滚到更新前版本，升级后自动重新应用全部定制。',
  },
  {
    id: 'update-progress',
    title: '更新进度窗口',
    detail: '点击「立即更新」后弹出小窗口，实时显示更新阶段（停止服务→备份→下载安装→校验→打补丁→同步插件→重启服务），下载安装期间不再"无提示假死"；可手动关闭，更新结束自动关闭。',
  },
  {
    id: 'pet',
    title: '桌面精灵',
    detail: '桌面鲸鱼娘小精灵：置顶显示本地时间，支持闹钟与倒计时。',
  },
  {
    id: 'peak-banner',
    title: '高峰时段提示条',
    detail: '界面最顶部常驻提示「高峰时段（北京时间 9:00 - 12:00、14:00 - 18:00）token 价格贵」，提醒节省 token；提示后附链接「在浏览器中查看具体价格」，点击在默认浏览器打开 DeepSeek API 价格文档；右侧 × 可临时关闭（仅本次会话，下次打开仍显示）。',
  },
  {
    id: 'picker',
    title: '目录选择器（PowerShell 版）',
    detail: '设置工作区时改用 Windows 原生文件夹框，绕开部分机器上会崩溃的 koffi 原生组件，默认定位到安装目录。',
    verify: { file: 'node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/index.js', marker: 'pickWin32ViaPowerShell' },
  },
  {
    id: 'recycle-bin',
    title: '删除保护（垃圾箱）',
    detail: 'AI 删除文件/目录时移到工作区内的 垃圾箱 文件夹，而非彻底删除；需要时可从该文件夹恢复。',
    verify: { file: 'node_modules/@deepseek-ai/dsh-tool-pwsh/lib/index.js', marker: '垃圾箱' },
  },
  {
    id: 'full-access-warning',
    title: 'Full access 高风险警告',
    detail: '启用完全权限（Full access）时弹出强警告文案，需明确确认（新会话默认权限设置、当前会话弹窗、聊天内切换三处）。',
    verify: [
      { file: 'node_modules/@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js', marker: '太可怕了' },
      { file: 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', marker: '太可怕了' },
    ],
  },
  {
    id: 'permission-two-options',
    title: '权限申请双选项规则',
    detail: 'agent 遇到权限被拒时，先给出「① 手动方案 ② 临时提权」两个选项，经你明确选择后才提权重试，而不是自动重试提权。',
    verify: { file: 'node_modules/@deepseek-ai/dsh-tool-pwsh/lib/index.js', marker: '手动方案' },
  },
  {
    id: 'auto-reapply',
    title: '启动自动重打定制',
    detail: '每次启动都会把全部定制补丁重新应用到当前运行时，保证 Harness 升级后定制不丢。',
  },
];

// 帮助窗口展示前，对带 verify 的条目按当前活跃 runtime 实测是否生效。
function modificationStatus() {
  const runtime = dshRuntimeRoot();
  const allVerified = (v) => {
    const list = Array.isArray(v) ? v : [v];
    return list.every(({ file, marker }) => {
      try {
        const p = path.join(runtime || '', file);
        return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes(marker);
      } catch (e) { return false; }
    });
  };
  return CUSTOM_MODIFICATIONS.map((item) => ({
    id: item.id,
    title: item.title,
    detail: item.detail,
    verified: item.verify ? allVerified(item.verify) : undefined,
  }));
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
  helpWin.loadFile('help.html', {
    query: {
      mods: JSON.stringify(modificationStatus()),
      ver: dshVersion() || '',
    },
  });
  helpWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  helpWin.on('closed', () => { helpWin = null; });
}

// ---------------------------------------------------------------- installed skills

// Mirror the default roots of @deepseek-ai/dsh-skill-filesystem (rank order):
// project `.dsh/skills`, project `.agents/skills`, user `$DSH_HOME/skills`,
// legacy `~/.dsh/skills`, and shared `~/.agents/skills`. The workspace comes
// from DSH_WORKSPACE / the shell cwd / its parent / the user home.
function skillWorkspaces() {
  const home = app.getPath('home');
  const out = [];
  const add = (p) => { if (p && typeof p === 'string') out.push(p); };
  add(process.env.DSH_WORKSPACE);
  add(process.cwd());
  try { add(path.resolve(__dirname, '..')); } catch (e) { /* ignore */ }
  add(home);
  return out;
}

function skillRoots() {
  const home = app.getPath('home');
  const roots = [];
  for (const ws of skillWorkspaces()) {
    roots.push(path.join(ws, '.dsh', 'skills'));
    roots.push(path.join(ws, '.agents', 'skills'));
  }
  if (currentAccountId) roots.push(path.join(accountHome(currentAccountId), 'skills'));
  roots.push(path.join(home, '.dsh', 'skills'));
  roots.push(path.join(home, '.agents', 'skills'));

  const seen = new Set();
  return roots.filter((r) => {
    let k;
    try { k = path.resolve(r).toLowerCase(); } catch (e) { k = r.toLowerCase(); }
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function yamlLib() {
  try {
    const runtime = dshRuntimeRoot();
    if (runtime) {
      const p = path.join(runtime, 'node_modules', 'yaml');
      if (fs.existsSync(p)) return require(p);
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Minimal fallback when the `yaml` package is unavailable in the runtime.
function fallbackFrontmatter(body) {
  const name = (body.match(/^\s*name:\s*["']?([^"'\r\n]+)/m) || [])[1];
  const dm = body.match(/^\s*description:\s*(?:["']([^"']*)["']|(.*))?/m);
  let description = '';
  if (dm) description = (dm[1] !== undefined ? dm[1] : (dm[2] || '')).trim();
  if (/^[>|][-]?$/.test(description)) {
    const rest = body.slice(body.indexOf(dm[0]) + dm[0].length);
    const lines = rest.split(/\r?\n/).filter((l) => l.trim() !== '' && /^\s+/.test(l));
    description = lines.map((l) => l.trim()).join(' ');
  }
  return { name: name ? name.trim() : null, description };
}

function readSkillFrontmatter(mdPath) {
  let text;
  try { text = fs.readFileSync(mdPath, 'utf8'); } catch (e) { return null; }
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const yaml = yamlLib();
  let fm = null;
  if (yaml) { try { fm = yaml.parse(m[1]); } catch (e) { fm = null; } }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return fallbackFrontmatter(m[1]);
  const name = typeof fm.name === 'string' ? fm.name : null;
  const description = typeof fm.description === 'string' ? fm.description : '';
  if (!name) return fallbackFrontmatter(m[1]);
  return { name, description };
}

function scanSkills() {
  const results = [];
  const seen = new Set();
  for (const root of skillRoots()) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      let mdPath = null;
      let kind = '目录';
      if (ent.isDirectory()) {
        const p = path.join(root, ent.name, 'SKILL.md');
        if (fs.existsSync(p)) mdPath = p;
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md') && ent.name.toLowerCase() !== 'skill.md') {
        mdPath = path.join(root, ent.name);
        kind = '单文件';
      }
      if (!mdPath) continue;
      const fm = readSkillFrontmatter(mdPath);
      if (!fm || !fm.name) continue;
      const key = fm.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ name: fm.name, description: fm.description || '', kind, root, path: mdPath });
    }
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function buildSkillsHtml(skills) {
  const items = skills.map((s) => `
    <div class="card">
      <div class="head"><span class="name">${escapeHtml(s.name)}</span><span class="kind">${escapeHtml(s.kind)}</span></div>
      <div class="desc">${escapeHtml(s.description) || '<em>（无描述）</em>'}</div>
      <div class="src" title="${escapeHtml(s.path)}">${escapeHtml(s.path)}</div>
    </div>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>已装 Skills</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #0b0e14; color: #e6e9ef; }
  header { position: sticky; top: 0; padding: 14px 18px; background: #0b0e14;
           border-bottom: 1px solid #1c2230; display: flex; gap: 12px; align-items: center; }
  header h1 { font-size: 16px; margin: 0; white-space: nowrap; }
  .count { color: #8b93a7; font-size: 13px; white-space: nowrap; }
  #q { flex: 1; min-width: 120px; padding: 8px 12px; border-radius: 8px; border: 1px solid #2a3245;
       background: #12161f; color: #e6e9ef; font-size: 14px; outline: none; }
  #q:focus { border-color: #4d7cfe; }
  main { padding: 16px 18px 28px; display: flex; flex-direction: column; gap: 12px; }
  .card { background: #12161f; border: 1px solid #1c2230; border-radius: 10px; padding: 12px 14px; }
  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .name { font-weight: 600; font-size: 14.5px; color: #7aa2ff; }
  .kind { font-size: 12px; color: #8b93a7; border: 1px solid #2a3245; border-radius: 6px; padding: 1px 7px; white-space: nowrap; }
  .desc { margin-top: 6px; font-size: 13px; line-height: 1.6; color: #c6ccd8; white-space: pre-wrap; }
  .src { margin-top: 8px; font-size: 11.5px; color: #6b7385; word-break: break-all; }
  .empty { color: #8b93a7; text-align: center; padding: 40px 0; }
</style>
</head>
<body>
<header>
  <h1>已装 Skills</h1>
  <span class="count">共 ${skills.length} 个</span>
  <input id="q" type="search" placeholder="搜索名称或功能…" autofocus>
</header>
<main id="list">${items || '<div class="empty">没有发现任何 skill</div>'}</main>
<script>
  var q = document.getElementById('q');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  q.addEventListener('input', function () {
    var t = q.value.trim().toLowerCase();
    var n = 0;
    cards.forEach(function (c) {
      var hit = !t || c.textContent.toLowerCase().indexOf(t) !== -1;
      c.style.display = hit ? '' : 'none';
      if (hit) n++;
    });
    document.querySelector('.count').textContent = '共 ' + cards.length + ' 个 · 显示 ' + n + ' 个';
  });
</script>
</body>
</html>`;
}

let skillsWin = null;
function showSkills() {
  const skills = scanSkills();
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(buildSkillsHtml(skills));
  if (skillsWin && !skillsWin.isDestroyed()) {
    skillsWin.loadURL(url);
    skillsWin.show(); skillsWin.focus();
    return;
  }
  skillsWin = new BrowserWindow({
    width: 780,
    height: 840,
    parent: win || undefined,
    title: '已装 Skills',
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    icon: iconPath(256),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  skillsWin.loadURL(url);
  skillsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  skillsWin.on('closed', () => { skillsWin = null; });
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
    { label: '查看已装 Skills', click: () => showSkills() },
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
        { label: '查看已装 Skills', click: () => showSkills() },
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
