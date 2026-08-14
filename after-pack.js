// after-pack.js - electron-builder afterPack hook
// electron-builder excludes node_modules from extraResources, so this copies
// the full dsh-runtime and update-tools directories into the packaged
// resources after the app is packed (but before the installer is built).

'use strict';

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const resourcesDir = path.join(appOutDir, 'resources');

  for (const dir of ['dsh-runtime', 'update-tools']) {
    const src = path.join(packager.projectDir, dir);
    const dst = path.join(resourcesDir, dir);
    if (!fs.existsSync(src)) {
      console.log(`[after-pack] WARN: ${src} not found, skipping`);
      continue;
    }
    console.log(`[after-pack] copying ${dir} -> ${dst} ...`);
    fs.cpSync(src, dst, { recursive: true });
  }
  console.log('[after-pack] done.');
};
