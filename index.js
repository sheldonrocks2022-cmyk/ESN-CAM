'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = __dirname
const RUNTIME_DIR = path.join(ROOT, '.node22-runtime')
const VIEWER_DIR = path.join(ROOT, '.viewer-node22')
const NODE22 = path.join(RUNTIME_DIR, 'node_modules', 'node', 'bin', 'node')
const NPM_CLI = path.join(RUNTIME_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js')
const VIEWER_MODULES = path.join(VIEWER_DIR, 'node_modules')

function exists(file) {
  try { return fs.existsSync(file) } catch { return false }
}

function run(command, args, env = process.env) {
  return spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env })
}

function startCam() {
  console.log('[ESN CAM] Starting ESN CAM...')
  require('./src/index')
}

function childEnv() {
  return {
    ...process.env,
    PATH: path.join(RUNTIME_DIR, 'node_modules', '.bin') + path.delimiter + (process.env.PATH || ''),
    NODE_PATH: VIEWER_MODULES + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '')
  }
}

if (!/^v22\./.test(process.version)) {
  console.log('[ESN CAM] CogitHost Node:', process.version)
  console.log('[ESN CAM] Preparing private Node 22 LTS runtime...')

  if (!exists(NODE22) || !exists(NPM_CLI)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(path.join(RUNTIME_DIR, 'package.json'), JSON.stringify({
      name: 'esn-cam-node22-runtime',
      private: true,
      dependencies: { node: '22', npm: '10' }
    }, null, 2))

    const bootstrap = run('npm', ['install', '--prefix', RUNTIME_DIR, '--no-audit', '--no-fund'])
    if (bootstrap.status !== 0 || !exists(NODE22) || !exists(NPM_CLI)) {
      console.error('[ESN CAM] Private Node 22 setup failed. Starting CAM with host Node.')
      startCam()
      return
    }
  }

  console.log('[ESN CAM] Private Node 22 runtime ready.')
  const child = run(NODE22, [__filename], childEnv())
  process.exit(child.status == null ? 1 : child.status)
}

console.log('[ESN CAM] Running under private Node 22:', process.version)

fs.mkdirSync(VIEWER_DIR, { recursive: true })

function findHostBrowser() {
  const direct = [
    process.env.CHROME_EXECUTABLE_PATH,
    process.env.CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/headless_shell',
    '/snap/bin/chromium'
  ].filter(Boolean)

  for (const candidate of direct) {
    try { if (fs.existsSync(candidate)) return candidate } catch {}
  }

  for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'headless_shell']) {
    try {
      const found = spawnSync('which', [name], { encoding: 'utf8' })
      const resolved = String(found.stdout || '').trim()
      if (found.status === 0 && resolved && fs.existsSync(resolved)) return resolved
    } catch {}
  }
  return null
}

const hostBrowser = findHostBrowser()
const viewerPackage = {
  name: 'esn-cam-viewer-runtime',
  private: true,
  dependencies: {
    'prismarine-viewer': '1.33.0',
    'puppeteer-core': '25.11.0',
    ...(hostBrowser ? {} : { '@sparticuz/chromium': '153.0.0' })
  }
}

if (hostBrowser) {
  console.log('[ESN CAM] Host Chromium/Chrome detected: ' + hostBrowser)
  console.log('[ESN CAM] Packaged Chromium is not needed; removing it to save disk.')
  for (const stale of [
    path.join(VIEWER_MODULES, '@sparticuz', 'chromium'),
    path.join(VIEWER_MODULES, '@sparticuz', 'chromium-min')
  ]) {
    try { fs.rmSync(stale, { recursive: true, force: true }) } catch {}
  }
} else {
  console.log('[ESN CAM] No host Chromium detected; packaged Chromium fallback will be installed.')
}

// ESN CAM records Java entirely inside Chromium. The lightweight world-stream
// bridge does not import Prismarine Viewer's server-side Entities/Viewer stack,
// so none of the native canvas/headless-GL packages are needed on CogitHost.
for (const legacyModule of ['node-canvas-webgl', 'gl', 'canvas']) {
  const legacyPath = path.join(VIEWER_MODULES, legacyModule)
  if (exists(legacyPath)) {
    try {
      fs.rmSync(legacyPath, { recursive: true, force: true })
      console.log('[ESN CAM] Removed legacy native viewer module: ' + legacyModule)
    } catch (error) {
      console.warn('[ESN CAM] Could not remove legacy viewer module ' + legacyModule + ': ' + error.message)
    }
  }
}
fs.writeFileSync(path.join(VIEWER_DIR, 'package.json'), JSON.stringify(viewerPackage, null, 2))

const missing = Object.keys(viewerPackage.dependencies).filter(name => {
  try { require.resolve(name, { paths: [VIEWER_DIR] }); return false } catch { return true }
})

if (missing.length) {
  console.log('[ESN CAM] Installing viewer stack under Node 22...')
  const install = run(NODE22, [NPM_CLI, 'install', '--prefix', VIEWER_DIR, '--no-audit', '--no-fund', '--foreground-scripts'], childEnv())
  if (install.status !== 0) console.error('[ESN CAM] Viewer install failed. CAM will still start.')
}

console.log('[ESN CAM] Viewer dependency result:')
for (const name of Object.keys(viewerPackage.dependencies)) {
  let ok = false
  try { require.resolve(name, { paths: [VIEWER_DIR] }); ok = true } catch {}
  console.log('[ESN CAM] ' + name + ': ' + (ok ? 'YES' : 'NO'))
}

startCam()
