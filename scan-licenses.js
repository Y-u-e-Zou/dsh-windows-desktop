// 扫描 dsh-runtime/node_modules 各包的 license 字段，统计分布并列出非 MIT/ISC/Apache 的包
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'dsh-runtime', 'node_modules');
const counts = {};
const nonMIT = [];

function collectPackage(pkgDir, name) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    let lic = pj.license;
    if (lic && typeof lic === 'object') lic = lic.type;
    if (!lic) lic = '(无 license 字段)';
    counts[lic] = (counts[lic] || 0) + 1;
    if (!/MIT|ISC|Apache|BSD|0BSD|Unlicense|WTFPL|Public/i.test(String(lic))) {
      nonMIT.push(name + '  ->  ' + lic);
    }
  } catch (e) { /* ignore */ }
}

let total = 0;
for (const entry of fs.readdirSync(root)) {
  const p = path.join(root, entry);
  if (entry.startsWith('@')) {
    for (const sub of fs.readdirSync(p)) {
      collectPackage(path.join(p, sub), entry + '/' + sub);
      total++;
    }
  } else {
    collectPackage(p, entry);
    total++;
  }
}

console.log('=== 扫描包总数: ' + total + ' ===');
console.log('=== license 分布 ===');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(v + '\t' + k);
}
console.log('=== 非 MIT/ISC/Apache 类（需人工确认）: ' + nonMIT.length + ' 个 ===');
for (const s of nonMIT) console.log(s);
