// dist.bat helper: compare the bundled dsh-runtime with the installed app's
// runtime and print REFRESH when the installed copy is newer (or the bundled
// one is missing entirely), so dist.bat can auto-mirror it before packaging.
// Prints KEEP otherwise. rc-style prereleases are compared correctly.
const fs = require('fs');
const path = require('path');

function readVersion(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).version; } catch (e) { return null; }
}

function compare(a, b) {
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
  if (!A.pre) return 1;
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

const bundledPath = 'dsh-runtime/node_modules/@deepseek-ai/dsh/package.json';
const instRoot = path.join(process.env.APPDATA, 'dsh-windows-desktop', 'dsh-runtime');
const instBin = path.join(instRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const bundled = readVersion(bundledPath);
const installed = fs.existsSync(instBin) ? readVersion(path.join(instRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')) : null;

if (installed && (!bundled || compare(installed, bundled) > 0)) {
  console.log('REFRESH');
} else {
  console.log('KEEP');
}
