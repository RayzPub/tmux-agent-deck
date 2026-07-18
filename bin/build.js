const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const distDir = path.join(PROJECT_ROOT, 'public', 'dist');

// Helper to get maximum mtime of files in a directory recursively
function getMaxMtime(dirPath) {
  let maxMtime = 0;
  if (!fs.existsSync(dirPath)) return maxMtime;

  const stat = fs.statSync(dirPath);
  if (stat.isFile()) {
    return stat.mtimeMs;
  }

  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const mtime = getMaxMtime(fullPath);
      if (mtime > maxMtime) {
        maxMtime = mtime;
      }
    }
  } catch (e) {
    // Ignore read errors
  }
  return maxMtime;
}

// Check if build is needed
function checkNeedsBuild() {
  const distIndex = path.join(PROJECT_ROOT, 'public', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    return true; // No build exists
  }

  const distMtime = fs.statSync(distIndex).mtimeMs;

  const sources = [
    path.join(PROJECT_ROOT, 'public', 'js', 'app.js'),
    path.join(PROJECT_ROOT, 'public', 'js', 'modules'),
    path.join(PROJECT_ROOT, 'public', 'css', 'style.css'),
    path.join(PROJECT_ROOT, 'public', 'css', 'invite-modal.css'),
    path.join(PROJECT_ROOT, 'public', 'index.html'),
    path.join(PROJECT_ROOT, 'public', 'login.html'),
    path.join(PROJECT_ROOT, 'public', 'register.html'),
  ];

  for (const src of sources) {
    if (fs.existsSync(src)) {
      const srcMtime = getMaxMtime(src);
      if (srcMtime > distMtime) {
        return true; // Source file is newer than build
      }
    }
  }

  return false;
}

async function performBuild(force = false) {
  // Check if esbuild is available
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (err) {
    console.warn('⚠️ esbuild not found. Skipping build and falling back to raw assets.');
    return false;
  }

  if (!force && !checkNeedsBuild()) {
    console.log('✨ dist assets are up-to-date. Skipping build.');
    return true;
  }

  console.log(force ? '🚀 Running forced production build...' : '🔄 Source files modified. Rebuilding assets...');
  const startTime = Date.now();

  try {
    // 1. Clean dist directory
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
    fs.mkdirSync(distDir, { recursive: true });

    // 2. Build JavaScript
    const jsResult = await esbuild.build({
      entryPoints: [path.join(PROJECT_ROOT, 'public', 'js', 'app.js')],
      bundle: true,
      minify: true,
      sourcemap: true,
      outdir: distDir,
      entryNames: '[name]-[hash]',
      metafile: true,
    });

    // 3. Build CSS
    const cssResult = await esbuild.build({
      entryPoints: [
        path.join(PROJECT_ROOT, 'public', 'css', 'style.css'),
        path.join(PROJECT_ROOT, 'public', 'css', 'invite-modal.css')
      ],
      bundle: true,
      minify: true,
      outdir: distDir,
      entryNames: '[name]-[hash]',
      metafile: true,
    });

    // 4. Helper to find hashed filenames
    const getHashedName = (outputs, originalName) => {
      for (const outputPath in outputs) {
        const filename = path.basename(outputPath);
        if (filename.startsWith(originalName + '-') && !outputPath.endsWith('.map')) {
          return filename;
        }
      }
      throw new Error(`Failed to find hashed file for ${originalName}`);
    };

    const appHashed = getHashedName(jsResult.metafile.outputs, 'app');
    const styleHashed = getHashedName(cssResult.metafile.outputs, 'style');
    const inviteModalHashed = getHashedName(cssResult.metafile.outputs, 'invite-modal');

    console.log(`📦 Hashed app.js -> ${appHashed}`);
    console.log(`📦 Hashed style.css -> ${styleHashed}`);
    console.log(`📦 Hashed invite-modal.css -> ${inviteModalHashed}`);

    // 5. Read and transform HTML files
    const htmlFiles = ['index.html', 'login.html', 'register.html'];
    for (const file of htmlFiles) {
      const srcPath = path.join(PROJECT_ROOT, 'public', file);
      if (!fs.existsSync(srcPath)) continue;

      let html = fs.readFileSync(srcPath, 'utf8');

      // Replace references with hashed ones
      html = html.replace('/css/style.css', `/dist/${styleHashed}`);
      html = html.replace('/css/invite-modal.css', `/dist/${inviteModalHashed}`);
      html = html.replace('/js/app.js', `/dist/${appHashed}`);

      const destPath = path.join(distDir, file);
      fs.writeFileSync(destPath, html, 'utf8');
      console.log(`📄 Transformed ${file} -> public/dist/${file}`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✨ Build completed successfully in ${duration}s!`);
    return true;
  } catch (error) {
    console.error('❌ Build failed:', error);
    if (require.main === module) {
      process.exit(1);
    }
    return false;
  }
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  performBuild(force);
} else {
  module.exports = {
    buildIfNeeded: () => performBuild(false),
    forceBuild: () => performBuild(true)
  };
}
