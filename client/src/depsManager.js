const fs = require('fs');
const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');
const { spawn, execFileSync } = require('child_process');
const { CONFIG_DIR, hasCommand } = require('./config');

let autoInstallStarted = false;

function getConfigRequire() {
  try {
    return Module.createRequire(path.join(CONFIG_DIR, 'package.json'));
  } catch (_) {
    return null;
  }
}

function getConfigPkgDir(pkgName) {
  return path.join(CONFIG_DIR, 'node_modules', ...pkgName.split('/'));
}

/**
 * Two-tier CommonJS optional dependency loader:
 * 1) Standard Node resolution (hits repo node_modules for host-admin or global installs)
 * 2) ~/.ccnow/node_modules via createRequire
 */
function tryRequireOptional(pkgName) {
  try {
    return require(pkgName);
  } catch (_) {}

  try {
    const cfgReq = getConfigRequire();
    if (cfgReq) return cfgReq(pkgName);
  } catch (_) {}

  return null;
}

/**
 * Resolve an ESM specifier (including ESM-only packages with "import"-only exports maps)
 * from ~/.ccnow/node_modules as a file:// URL.
 */
function resolveOptionalEsmUrl(specifier) {
  // 1) Try standard CJS resolve first (works for dual CJS/ESM packages)
  try {
    const cfgReq = getConfigRequire();
    if (cfgReq) {
      const resolved = cfgReq.resolve(specifier);
      if (resolved) return pathToFileURL(resolved).href;
    }
  } catch (_) {}

  // 2) Manual ESM exports-map resolution for ESM-only packages (e.g. @botiverse/oar)
  try {
    const parts = specifier.split('/');
    const pkgName = specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    const subpath = specifier.startsWith('@')
      ? (parts.length > 2 ? './' + parts.slice(2).join('/') : '.')
      : (parts.length > 1 ? './' + parts.slice(1).join('/') : '.');

    const pkgDir = getConfigPkgDir(pkgName);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return null;

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const exportsMap = pkgJson.exports;
    let relTarget = null;

    if (exportsMap && typeof exportsMap === 'object') {
      const pickImport = (entry) => {
        if (!entry) return null;
        if (typeof entry === 'string') return entry;
        if (typeof entry === 'object') return entry.import || entry.default || null;
        return null;
      };

      if (exportsMap[subpath] !== undefined) {
        relTarget = pickImport(exportsMap[subpath]);
      } else {
        // Wildcard pattern match (e.g. "./runtimes/*": { "import": "./dist/runtimes/*/index.js" })
        for (const [pattern, entry] of Object.entries(exportsMap)) {
          const starIdx = pattern.indexOf('*');
          if (starIdx === -1) continue;
          const prefix = pattern.slice(0, starIdx);
          const suffix = pattern.slice(starIdx + 1);
          if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
            const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
            const rawTarget = pickImport(entry);
            if (rawTarget) {
              relTarget = rawTarget.replace('*', matched);
              break;
            }
          }
        }
      }
    }

    if (!relTarget && subpath === '.') {
      relTarget = pkgJson.module || pkgJson.main || './index.js';
    }

    if (relTarget) {
      const fullPath = path.resolve(pkgDir, relTarget);
      if (fs.existsSync(fullPath)) {
        return pathToFileURL(fullPath).href;
      }
    }
  } catch (_) {}

  return null;
}

function isPackageAvailable(pkgName) {
  // 1) Check CONFIG_DIR/node_modules/<pkg>/package.json directly (works for ESM-only & CJS)
  if (fs.existsSync(path.join(getConfigPkgDir(pkgName), 'package.json'))) {
    return true;
  }

  // 2) Check standard Node resolution (including walking up from __dirname for ESM-only packages)
  try {
    require.resolve(pkgName);
    return true;
  } catch (_) {}

  try {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'node_modules', ...pkgName.split('/'), 'package.json');
      if (fs.existsSync(candidate)) return true;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (_) {}

  return false;
}

/**
 * Ensure ~/.ccnow/package.json exists so sequential `npm install --prefix ~/.ccnow`
 * persists each installed package instead of pruning previous ones.
 */
function ensureConfigPackageJson() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const pkgPath = path.join(CONFIG_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({ name: 'ccnow-agent-deps', version: '1.0.0', private: true }, null, 2),
      'utf8'
    );
  }
}

/**
 * Synchronously install a single lightweight package into ~/.ccnow/node_modules (e.g. ws on Node < 21).
 */
function installPackageSync(pkgName) {
  if (!hasCommand('npm')) return false;
  try {
    ensureConfigPackageJson();
    console.log(`📦 [ccnow-agent] Installing required fallback dependency '${pkgName}' into ${CONFIG_DIR}...`);
    execFileSync('npm', ['install', '--prefix', CONFIG_DIR, '--save', '--no-audit', '--no-fund', pkgName], {
      stdio: 'ignore',
      timeout: 60000
    });
    return isPackageAvailable(pkgName);
  } catch (_) {
    return false;
  }
}

/**
 * Asynchronously install a single optional package into ~/.ccnow/node_modules without blocking startup.
 */
function installPackageAsync(pkgName) {
  return new Promise((resolve) => {
    if (!hasCommand('npm')) return resolve({ pkg: pkgName, ok: false, reason: 'npm not found' });
    try {
      ensureConfigPackageJson();
    } catch (err) {
      return resolve({ pkg: pkgName, ok: false, reason: err.message });
    }

    const child = spawn(
      'npm',
      ['install', '--prefix', CONFIG_DIR, '--save', '--no-audit', '--no-fund', pkgName],
      { stdio: 'ignore', env: { ...process.env, npm_config_loglevel: 'error' } }
    );

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ pkg: pkgName, ok: false, reason: 'timeout' });
    }, 120000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = code === 0 && isPackageAvailable(pkgName);
      resolve({ pkg: pkgName, ok, code });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ pkg: pkgName, ok: false, reason: err.message });
    });
  });
}

function getMissingOptionalDeps() {
  const missing = [];
  const nodeMajor = parseInt(String(process.versions.node || '0').split('.')[0], 10) || 0;

  if (nodeMajor >= 24 && !isPackageAvailable('@botiverse/oar')) {
    missing.push('@botiverse/oar');
  }
  if (!isPackageAvailable('node-pty')) {
    missing.push('node-pty');
  }
  return missing;
}

/**
 * Non-blocking background installer for optional enhancements (@botiverse/oar, node-pty).
 */
function ensureOptionalDepsInBackground() {
  if (autoInstallStarted || process.env.CCNOW_SKIP_AUTO_INSTALL === '1') return;
  autoInstallStarted = true;

  const missing = getMissingOptionalDeps();
  if (missing.length === 0 || !hasCommand('npm')) return;

  console.log(`📦 [ccnow-agent] Installing optional enhancements in background (${missing.join(', ')}) -> ${CONFIG_DIR}/node_modules`);

  (async () => {
    for (const pkg of missing) {
      const res = await installPackageAsync(pkg);
      if (res.ok) {
        console.log(`✅ [ccnow-agent] Optional dependency '${pkg}' installed and ready.`);
      } else {
        console.log(`ℹ️ [ccnow-agent] Optional dependency '${pkg}' skipped (${res.reason || `exit ${res.code}`}); fallback mode remains active.`);
      }
    }
  })();
}

/**
 * Explicit CLI `ccnow-agent setup` runner with progress output.
 */
async function runSetupCommand() {
  const missing = getMissingOptionalDeps();
  console.log(`📁 Config directory: ${CONFIG_DIR}`);
  console.log(`   - @botiverse/oar: ${isPackageAvailable('@botiverse/oar') ? '✅ installed' : '⚪ missing'}`);
  console.log(`   - node-pty:       ${isPackageAvailable('node-pty') ? '✅ installed' : '⚪ missing'}`);

  if (missing.length === 0) {
    console.log('✨ All optional dependencies are already available.');
    return;
  }
  if (!hasCommand('npm')) {
    console.error('❌ npm not found in PATH; cannot auto-install optional dependencies.');
    process.exit(1);
  }
  for (const pkg of missing) {
    console.log(`⬇️ Installing ${pkg} into ${CONFIG_DIR}/node_modules ...`);
    const res = await installPackageAsync(pkg);
    console.log(res.ok ? `✅ ${pkg} installed.` : `⚠️ ${pkg} failed (${res.reason || `exit ${res.code}`}), fallback remains active.`);
  }
}

module.exports = {
  tryRequireOptional,
  resolveOptionalEsmUrl,
  isPackageAvailable,
  installPackageSync,
  installPackageAsync,
  getMissingOptionalDeps,
  ensureOptionalDepsInBackground,
  runSetupCommand
};
