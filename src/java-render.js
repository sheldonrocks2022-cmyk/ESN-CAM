'use strict'

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { Authflow, Titles } = require('prismarine-auth')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(error => {
        if (error) reject(error)
        else if (!port) reject(new Error('Could not allocate a local viewer port.'))
        else resolve(port)
      })
    })
  })
}



function installMineflayer262TeamCompat(stage) {
  try {
    const mineflayerEntry = require.resolve('mineflayer')
    const teamModule = require.resolve(path.join(path.dirname(mineflayerEntry), 'lib', 'team.js'))
    const originalLoader = require(teamModule)

    if (originalLoader.__esnSafe262) return

    const safeLoader = registry => {
      const Team = originalLoader(registry)
      const originalParseMessage = Team.prototype.parseMessage

      Team.prototype.parseMessage = function (value) {
        // Minecraft 26.2 may omit scoreboard-team display/prefix/suffix
        // components. The current Mineflayer fork passes undefined into
        // prismarine-chat, which crashes while reading msg.type.
        if (value === undefined || value === null) {
          return originalParseMessage.call(this, '')
        }
        return originalParseMessage.call(this, value)
      }

      return Team
    }

    safeLoader.__esnSafe262 = true
    require.cache[teamModule].exports = safeLoader
    stage('COMPAT', 'installed safe Minecraft 26.2 team component parser')
  } catch (error) {
    stage('COMPAT_WARN', 'could not install team parser guard: ' + (error?.message || error))
  }
}

function waitForStableFile(filePath, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let lastSize = -1
    let stableChecks = 0

    const timer = setInterval(() => {
      try {
        if (fs.existsSync(filePath)) {
          const size = fs.statSync(filePath).size
          if (size > 1024) {
            if (size === lastSize) stableChecks += 1
            else stableChecks = 0
            lastSize = size
            if (stableChecks >= 3) {
              clearInterval(timer)
              resolve(size)
              return
            }
          }
        }
      } catch {}

      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('Timed out waiting for the Java renderer to produce an MP4.'))
      }
    }, 750)
  })
}



async function probeViewerHttp(port, stage) {
  const base = 'http://127.0.0.1:' + port
  for (const asset of ['/', '/index.js']) {
    try {
      const response = await fetch(base + asset)
      const body = await response.arrayBuffer()
      stage(
        'VIEWER_HTTP',
        asset + ' -> HTTP ' + response.status + ', ' + body.byteLength + ' bytes'
      )
      if (!response.ok) {
        throw new Error('Viewer asset ' + asset + ' returned HTTP ' + response.status)
      }
      if (asset === '/index.js' && body.byteLength < 1000) {
        throw new Error('Viewer browser bundle /index.js is missing or unexpectedly small (' + body.byteLength + ' bytes)')
      }
    } catch (error) {
      stage('VIEWER_HTTP_ERROR', String(error?.message || error).slice(0, 700))
      throw error
    }
  }
}

async function startBrowserViewerBridge(bot, { port, firstPerson = true, viewDistance = 6, viewerVersion }, stage) {
  // Do NOT require prismarine-viewer/lib/mineflayer here. That module imports
  // the package's full server-side Viewer/Entities stack, which pulls native
  // canvas/GL code into CogitHost even though the actual rendering happens in
  // Chromium. We only need WorldView + the static browser bundle + socket.io.
  stage('VIEWER_BRIDGE', 'loading lightweight world-stream bridge')

  const EventEmitter = require('node:events')
  const http = require('node:http')
  const express = require('express')
  const socketIO = require('socket.io')
  const { setupRoutes } = require('prismarine-viewer/lib/common')
  const { WorldView } = require('prismarine-viewer/viewer/lib/worldView')

  const app = express()
  const server = http.createServer(app)
  const io = socketIO(server, { path: '/socket.io' })

  // Serve a minimal root and inject Prismarine Viewer's compiled browser
  // bundle directly from Puppeteer. Keeping the URL at "/" preserves the
  // viewer's expected "/socket.io" path while avoiding a fragile script tag.
  app.get('/', (req, res) => {
    res.type('html').send(
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>ESN CAM Viewer</title>' +
      '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>' +
      '</head><body></body></html>'
    )
  })

  setupRoutes(app, '')

  // Keep the secure texture proxy from Prismarine Viewer's normal server so
  // player skins/capes still render in Chromium.
  app.get('/texture/:hash([0-9a-f]+)', async (req, res) => {
    try {
      const texture = await fetch('https://textures.minecraft.net/texture/' + req.params.hash)
      if (!texture.ok) return res.sendStatus(texture.status === 404 ? 404 : 502)
      res.type('png').send(Buffer.from(await texture.arrayBuffer()))
    } catch {
      res.sendStatus(502)
    }
  })

  const sockets = new Set()
  const worldViews = new Map()
  const primitives = {}
  bot.viewer = new EventEmitter()

  bot.viewer.erase = id => {
    delete primitives[id]
    for (const socket of sockets) socket.emit('primitive', { id })
  }
  bot.viewer.drawBoxGrid = (id, start, end, color = 'aqua') => {
    primitives[id] = { type: 'boxgrid', id, start, end, color }
    for (const socket of sockets) socket.emit('primitive', primitives[id])
  }
  bot.viewer.drawLine = (id, points, color = 0xff0000) => {
    primitives[id] = { type: 'line', id, points, color }
    for (const socket of sockets) socket.emit('primitive', primitives[id])
  }
  bot.viewer.drawPoints = (id, points, color = 0xff0000, size = 5) => {
    primitives[id] = { type: 'points', id, points, color, size }
    for (const socket of sockets) socket.emit('primitive', primitives[id])
  }

  io.on('connection', socket => {
    sockets.add(socket)
    socket.emit('version', viewerVersion || bot.version)

    const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket)
    worldViews.set(socket.id, worldView)

    Promise.resolve(worldView.init(bot.entity.position)).catch(error => {
      stage('VIEWER_WORLD_WARN', String(error?.message || error).slice(0, 300))
    })

    worldView.on('blockClicked', (block, face, button) => {
      bot.viewer.emit('blockClicked', block, face, button)
    })

    for (const id in primitives) socket.emit('primitive', primitives[id])

    const botPosition = () => {
      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true }
      if (firstPerson) packet.pitch = bot.entity.pitch
      socket.emit('position', packet)
      Promise.resolve(worldView.updatePosition(bot.entity.position)).catch(() => {})
    }

    bot.on('move', botPosition)
    worldView.listenToBot(bot)
    botPosition()

    socket.on('disconnect', () => {
      bot.removeListener('move', botPosition)
      try { worldView.removeListenersFromBot(bot) } catch {}
      worldViews.delete(socket.id)
      sockets.delete(socket)
    })
  })

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })

  stage('VIEWER_BRIDGE', 'listening on 127.0.0.1:' + port)

  const close = async () => {
    for (const [socketId, worldView] of worldViews) {
      const socket = [...sockets].find(item => item.id === socketId)
      try { worldView.removeListenersFromBot(bot) } catch {}
      try { socket?.disconnect(true) } catch {}
    }
    worldViews.clear()
    sockets.clear()
    try { io.close() } catch {}
    await new Promise(resolve => server.close(() => resolve())).catch(() => {})
  }

  bot.viewer.close = close
  return close
}


function removePathSafe(target, stage, label) {
  try {
    if (!fs.existsSync(target)) return 0
    const stat = fs.statSync(target)
    let bytes = stat.isFile() ? stat.size : 0
    if (stat.isDirectory()) {
      const walk = dir => {
        let total = 0
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const child = path.join(dir, entry.name)
          try {
            if (entry.isDirectory()) total += walk(child)
            else total += fs.statSync(child).size
          } catch {}
        }
        return total
      }
      bytes = walk(target)
    }
    fs.rmSync(target, { recursive: true, force: true })
    stage('STORAGE_CLEAN', label + ' freed about ' + Math.round(bytes / 1024 / 1024) + ' MB')
    return bytes
  } catch (error) {
    stage('STORAGE_WARN', label + ': ' + String(error?.message || error).slice(0, 300))
    return 0
  }
}


function findSystemChromium(stage) {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    process.env.CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/headless_shell',
    '/snap/bin/chromium'
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        stage('SYSTEM_BROWSER', 'using ' + candidate)
        return candidate
      }
    } catch {}
  }

  for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'headless_shell']) {
    try {
      const found = spawnSync('which', [name], { encoding: 'utf8' })
      const resolved = String(found.stdout || '').trim()
      if (found.status === 0 && resolved && fs.existsSync(resolved)) {
        stage('SYSTEM_BROWSER', 'using ' + resolved)
        return resolved
      }
    } catch {}
  }

  stage('SYSTEM_BROWSER', 'no host Chromium/Chrome binary found')
  return null
}

function freeSpaceMb(target = os.tmpdir()) {
  try {
    fs.mkdirSync(target, { recursive: true })
    const stat = fs.statfsSync(target)
    return Math.floor(Number(stat.bavail) * Number(stat.bsize) / 1024 / 1024)
  } catch {
    return null
  }
}

function cleanupSafeCaches(stage) {
  let freed = 0
  const home = process.env.HOME || path.join(__dirname, '..')
  const safeCaches = [
    path.join(home, '.npm', '_cacache'),
    path.join(home, '.cache', 'puppeteer'),
    path.join(home, '.cache', 'chromium'),
    path.join(home, '.cache', 'chrome-headless-shell')
  ]

  for (const target of safeCaches) {
    if (fs.existsSync(target)) {
      freed += removePathSafe(target, stage, 'safe package/browser cache')
    }
  }

  return freed
}

function selectChromiumTemp(stage) {
  const root = path.join(__dirname, '..')
  const candidates = [
    path.join(root, '.esn-cam-tmp'),
    path.join(process.env.HOME || root, '.esn-cam-tmp'),
    '/tmp/esn-cam',
    '/dev/shm/esn-cam'
  ]

  const unique = [...new Set(candidates)]
  let best = null

  for (const target of unique) {
    const freeMb = freeSpaceMb(target)
    stage(
      'STORAGE_CANDIDATE',
      target + ': ' + (freeMb == null ? 'unknown free space' : freeMb + ' MB free')
    )
    if (freeMb != null && (!best || freeMb > best.freeMb)) {
      best = { target, freeMb }
    }
  }

  return best
}

function cleanupRenderStorage(stage) {
  let freed = 0
  const renderRoot = path.join(__dirname, '..', 'recordings', 'java-render-tests')

  try {
    if (fs.existsSync(renderRoot)) {
      for (const entry of fs.readdirSync(renderRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('frames-')) {
          freed += removePathSafe(path.join(renderRoot, entry.name), stage, 'old failed render frames')
        }
      }
    }
  } catch (error) {
    stage('STORAGE_WARN', 'render cleanup scan: ' + String(error?.message || error).slice(0, 300))
  }

  // @sparticuz/chromium extracts its executable into the OS temp directory.
  // Old crash leftovers are safe to remove and can consume a large part of a
  // small container quota.
  const tempRoot = os.tmpdir()
  for (const name of ['chromium', 'swiftshader', 'lib', 'fonts']) {
    const target = path.join(tempRoot, name)
    if (fs.existsSync(target)) {
      freed += removePathSafe(target, stage, 'stale Chromium temp ' + name)
    }
  }

  for (const stale of [
    path.join(__dirname, '..', '.esn-cam-tmp', 'chromium'),
    path.join(__dirname, '..', '.esn-cam-tmp', 'swiftshader'),
    path.join(__dirname, '..', '.esn-cam-tmp', 'fonts'),
    path.join(__dirname, '..', '.esn-cam-tmp', 'al2023')
  ]) {
    if (fs.existsSync(stale)) {
      freed += removePathSafe(stale, stage, 'stale ESN Chromium extraction')
    }
  }

  stage('STORAGE', 'automatic cleanup freed about ' + Math.round(freed / 1024 / 1024) + ' MB')
}

async function testJavaRender(config, onMsaCode, onStage) {
  const stage = (name, detail = '') => {
    console.log(`[Java render] ${name}${detail ? ': ' + detail : ''}`)
    if (typeof onStage === 'function') Promise.resolve(onStage(name, detail)).catch(() => {})
  }

  stage('AUTH', 'authenticating the working Java profile')
  const flow = new Authflow('ESN-JAVA-CAM-RENDER', config.profilesFolder, {
    flow: 'sisu',
    authTitle: Titles.MinecraftJava,
    deviceType: 'Win32'
  }, data => {
    stage('MICROSOFT_DEVICE_CODE', 'waiting for user authorization')
    if (typeof onMsaCode === 'function') Promise.resolve(onMsaCode(data)).catch(() => {})
  })

  const authResult = await flow.getMinecraftJavaToken({
    fetchEntitlements: true,
    fetchProfile: true
  })

  const profile = authResult?.profile
  if (!authResult?.token || !profile?.name || !profile?.id) {
    throw new Error('Java render test could not obtain the working Minecraft Java profile/token.')
  }

  installMineflayer262TeamCompat(stage)
  const mineflayer = require('mineflayer')
  const session = {
    accessToken: authResult.token,
    selectedProfile: profile,
    availableProfile: [profile]
  }

  const authenticatedJava = (client, options) => {
    client.session = session
    client.username = profile.name
    options.username = profile.name
    options.accessToken = authResult.token
    options.haveCredentials = true
    client.emit('session', session)
    options.connect(client)
  }

  const botOptions = {
    host: config.host,
    username: profile.name,
    auth: authenticatedJava,
    version: '26.2'
  }
  if (config.port) botOptions.port = config.port

  let bot
  let browser
  let viewerClose
  let frameDir
  let transportFailure = null
  let persistentBotError
  let persistentClientError
  let persistentKicked
  let persistentEnd
  try {
    stage('CONNECT', `joining ${config.host}`)
    bot = mineflayer.createBot(botOptions)

    // Minecraft 26.2 can send scoreboard-team components that this Mineflayer
    // fork does not parse safely yet. The render worker does not use team
    // metadata, so disable only those packet handlers before packets arrive.
    for (const packetName of ['scoreboard_team', 'teams']) {
      const count = bot?._client?.listenerCount(packetName) || 0
      if (count > 0) {
        bot._client.removeAllListeners(packetName)
        stage('COMPAT', `disabled ${packetName} handler (${count}) for render mode`)
      }
    }

    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => finish(new Error('Java render test timed out before spawn.')), 45000)

      const cleanup = () => {
        clearTimeout(timer)
        bot?.removeListener('spawn', onSpawn)
        bot?.removeListener('kicked', onKicked)
        bot?.removeListener('error', onError)
        bot?.removeListener('end', onEnd)
      }

      const finish = error => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }

      const onSpawn = () => finish()
      const onKicked = reason => finish(new Error('Server kicked Java CAM: ' + (typeof reason === 'string' ? reason : JSON.stringify(reason))))
      const onError = error => finish(error)
      const onEnd = reason => finish(new Error('Java CAM disconnected before render: ' + (reason || 'unknown')))

      bot.once('spawn', onSpawn)
      bot.once('kicked', onKicked)
      bot.once('error', onError)
      bot.once('end', onEnd)
    })

    stage('SPAWN', `joined as ${bot.username || profile.name}`)

    // Keep permanent post-spawn transport listeners. The temporary startup
    // listeners above are removed once spawn succeeds; without replacements,
    // a later EventEmitter "error" can terminate Node before Discord receives
    // any useful failure message.
    const failTransport = (label, detail) => {
      const message = String(detail?.message || detail || 'unknown').slice(0, 1200)
      if (!transportFailure) transportFailure = new Error(label + ': ' + message)
      stage(label, message)
    }

    persistentBotError = error => failTransport('MINECRAFT_ERROR', error)
    persistentClientError = error => failTransport('PROTOCOL_ERROR', error)
    persistentKicked = reason => failTransport(
      'KICKED',
      typeof reason === 'string' ? reason : JSON.stringify(reason)
    )
    persistentEnd = reason => failTransport('DISCONNECTED', reason || 'connection ended')

    bot.on('error', persistentBotError)
    bot.on('kicked', persistentKicked)
    bot.on('end', persistentEnd)
    bot?._client?.on?.('error', persistentClientError)

    stage('SETTLE', 'checking that the Java session stays stable after spawn')
    await wait(3000)
    if (transportFailure) throw transportFailure

    cleanupRenderStorage(stage)

    stage('RENDERER', 'starting Chromium + SwiftShader browser renderer')

    if (transportFailure) throw transportFailure
    stage('BROWSER_MODULES', 'loading Puppeteer')
    const puppeteer = require('puppeteer-core')

    // Prefer a browser already present on the host. This avoids unpacking the
    // large @sparticuz/chromium binary into /tmp on small-disk containers.
    let executablePath = findSystemChromium(stage)
    let chromiumArgs = []

    if (!executablePath) {
      stage('STORAGE_PREP', 'checking writable locations for Chromium extraction')

      let best = selectChromiumTemp(stage)
      if (!best || best.freeMb < 300) {
        cleanupSafeCaches(stage)
        best = selectChromiumTemp(stage)
      }

      if (!best || best.freeMb < 300) {
        const detail = best
          ? best.freeMb + ' MB free at best location ' + best.target
          : 'no writable storage location could be measured'
        throw new Error(
          'CogitHost still does not have enough writable space for fallback Chromium: ' +
          detail +
          '. ESN CAM needs about 300 MB available during browser extraction.'
        )
      }

      fs.mkdirSync(best.target, { recursive: true })
      process.env.TMPDIR = best.target
      process.env.TMP = best.target
      process.env.TEMP = best.target

      stage(
        'STORAGE_SELECTED',
        best.target + ' with ' + best.freeMb + ' MB free; Chromium temp redirected here'
      )

      stage('BROWSER_FALLBACK', 'using packaged Chromium because no system browser was found')
      const chromiumModule = require('@sparticuz/chromium')
      const chromium = chromiumModule.default || chromiumModule
      chromium.setGraphicsMode = true
      executablePath = await chromium.executablePath()
      chromiumArgs = chromium.args
    }

    // Keep the live Mineflayer connection on Minecraft 26.2 at all times.
    // Only the Chromium viewer is told to use Prismarine Viewer's compatible
    // 26.1 asset pack. Mutating bot.version after spawn can destabilize the
    // protocol session and cause an immediate disconnect.
    const viewerVersion = bot.version === '26.2' ? '26.1' : bot.version
    stage(
      'VIEWER_ASSETS',
      'Minecraft session stays on ' + bot.version + '; browser assets use ' + viewerVersion
    )

    if (transportFailure) throw transportFailure
    const viewerPort = await getFreePort()
    viewerClose = await startBrowserViewerBridge(bot, {
      port: viewerPort,
      firstPerson: true,
      viewDistance: 6,
      viewerVersion
    }, stage)
    await wait(750)
    await probeViewerHttp(viewerPort, stage)

    chromiumArgs = [
      ...chromiumArgs,
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]

    const args = await puppeteer.defaultArgs({
      args: chromiumArgs,
      headless: 'shell'
    })

    if (transportFailure) throw transportFailure
    stage('BROWSER', 'launching headless Chromium with SwiftShader')
    browser = await puppeteer.launch({
      args,
      defaultViewport: {
        width: 640,
        height: 360,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        isLandscape: true
      },
      executablePath,
      headless: 'shell'
    })

    const page = await browser.newPage()

    // Prove that the browser itself has a working software WebGL context before
    // loading Prismarine Viewer. This keeps native headless-gl completely out of
    // the render path and gives a useful error if SwiftShader is unavailable.
    const preflight = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 32
      canvas.height = 32
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
      if (!gl) return { ok: false, reason: 'Chromium could not create a WebGL context' }
      let renderer = 'unknown'
      try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info')
        renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
      } catch {}
      return { ok: true, renderer }
    })
    if (!preflight.ok) {
      throw new Error('Chromium SwiftShader preflight failed: ' + preflight.reason)
    }
    stage('WEBGL_PREFLIGHT', 'ready via ' + preflight.renderer)

    const browserFaults = []

    page.on('pageerror', error => {
      const detail = String(error?.stack || error?.message || error).slice(0, 1200)
      browserFaults.push('PAGE_ERROR: ' + detail)
      stage('PAGE_ERROR', detail)
    })
    page.on('console', message => {
      const type = message.type()
      if (type === 'error' || type === 'warning') {
        const detail = message.text().slice(0, 1000)
        browserFaults.push('BROWSER_' + type.toUpperCase() + ': ' + detail)
        stage('BROWSER_' + type.toUpperCase(), detail)
      }
    })
    page.on('requestfailed', request => {
      const detail = request.url() + ' :: ' + (request.failure()?.errorText || 'request failed')
      browserFaults.push('REQUEST_FAILED: ' + detail)
      stage('REQUEST_FAILED', detail.slice(0, 1000))
    })
    page.on('response', response => {
      const url = response.url()
      if (response.status() >= 400 && url.startsWith('http://127.0.0.1:' + viewerPort)) {
        const detail = 'HTTP ' + response.status() + ' ' + url
        browserFaults.push('HTTP_ERROR: ' + detail)
        stage('HTTP_ERROR', detail)
      }
    })

    stage('VIEWER_PAGE', 'opening ESN browser viewer shell')
    const nav = await page.goto('http://127.0.0.1:' + viewerPort + '/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    stage('VIEWER_PAGE', 'HTML loaded with HTTP ' + (nav?.status?.() ?? 'unknown'))

    const viewerPackageRoot = path.dirname(require.resolve('prismarine-viewer/package.json'))
    const viewerBundlePath = path.join(viewerPackageRoot, 'public', 'index.js')
    const viewerWorkerPath = path.join(viewerPackageRoot, 'public', 'worker.js')

    if (!fs.existsSync(viewerBundlePath)) {
      throw new Error('Prismarine Viewer browser bundle is missing: ' + viewerBundlePath)
    }
    if (!fs.existsSync(viewerWorkerPath)) {
      throw new Error('Prismarine Viewer worker bundle is missing: ' + viewerWorkerPath)
    }

    const bundleBytes = fs.statSync(viewerBundlePath).size
    const workerBytes = fs.statSync(viewerWorkerPath).size
    stage(
      'VIEWER_BUNDLE',
      'bundle ' + Math.round(bundleBytes / 1024) + ' KB; worker ' +
      Math.round(workerBytes / 1024) + ' KB'
    )

    // Do not use page.addScriptTag({ content }). That waits for the entire
    // Prismarine bundle's synchronous startup to finish, which can stall on
    // small hosted CPUs while the 61 MB worker boots. Append an external
    // script element and return immediately so Node keeps control of the test.
    await page.evaluate((src) => {
      window.__esnViewerBoot = { loaded: false, error: null }
      const script = document.createElement('script')
      script.src = src
      script.async = true
      script.onload = () => { window.__esnViewerBoot.loaded = true }
      script.onerror = () => { window.__esnViewerBoot.error = 'Failed to load ' + src }
      document.body.appendChild(script)
    }, 'http://127.0.0.1:' + viewerPort + '/index.js')

    stage('VIEWER_START', 'viewer bundle requested asynchronously; waiting for canvas')

    let canvasHandle = null
    try {
      canvasHandle = await Promise.race([
        page.waitForSelector('canvas', { timeout: 45000 }),
        wait(46000).then(() => {
          throw new Error('Viewer startup watchdog expired after 46 seconds')
        })
      ])
    } catch (error) {
      const boot = await Promise.race([
        page.evaluate(() => ({
          boot: window.__esnViewerBoot || null,
          hasCanvas: !!document.querySelector('canvas'),
          title: document.title,
          scripts: [...document.scripts].map(script => script.src || '[inline]')
        })).catch(inspectError => ({ inspectError: String(inspectError?.message || inspectError) })),
        wait(3000).then(() => ({ inspectError: 'browser main thread was unresponsive' }))
      ])

      stage('VIEWER_BOOT_FAILED', JSON.stringify(boot).slice(0, 1200))
      throw new Error(
        'Prismarine Viewer did not create a canvas before the startup watchdog expired. ' +
        String(error?.message || error) +
        (browserFaults.length
          ? ' | Browser faults: ' + browserFaults.slice(-6).join(' | ')
          : '')
      )
    }

    if (!canvasHandle) {
      throw new Error('Prismarine Viewer canvas handle was unexpectedly empty.')
    }

    stage('VIEWER_CANVAS', 'Prismarine Viewer created its WebGL canvas')
    stage('VIEWER_WORKER', 'allowing the large Minecraft meshing worker to initialize')
    await wait(8000)

    const webgl = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')
      if (!canvas) return { ok: false, reason: 'canvas missing' }
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
      if (!gl) return { ok: false, reason: 'WebGL context missing' }
      let renderer = 'unknown'
      try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info')
        renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
      } catch {}
      return { ok: true, renderer, width: canvas.width, height: canvas.height }
    })

    if (!webgl.ok) {
      throw new Error('Chromium launched, but SwiftShader WebGL was unavailable: ' + (webgl.reason || 'unknown'))
    }
    stage('WEBGL', 'ready via ' + webgl.renderer)

    const outputDir = path.join(__dirname, '..', 'recordings', 'java-render-tests')
    frameDir = path.join(outputDir, 'frames-' + Date.now())
    fs.mkdirSync(frameDir, { recursive: true })
    const output = path.join(outputDir, 'java-render-' + Date.now() + '.mp4')

    const frames = 40
    const fps = 10
    if (transportFailure) throw transportFailure
    stage('CAPTURE', 'capturing ' + frames + ' real Minecraft frames')

    const canvas = await page.$('canvas')
    if (!canvas) throw new Error('Viewer canvas disappeared before capture.')

    for (let i = 0; i < frames; i++) {
      const framePath = path.join(frameDir, 'frame-' + String(i).padStart(4, '0') + '.png')
      await canvas.screenshot({ path: framePath, type: 'png' })
      await wait(100)
    }

    const ffmpeg = spawnSync('ffmpeg', [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(frameDir, 'frame-%04d.png'),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      output
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })

    if (ffmpeg.status !== 0 || !fs.existsSync(output)) {
      throw new Error('FFmpeg could not encode the Chromium render: ' + String(ffmpeg.stderr || '').slice(-900))
    }

    const size = fs.statSync(output).size
    if (size < 1024) throw new Error('Chromium render produced an empty MP4.')

    stage('PASS', 'browser-rendered ' + size + ' bytes')

    return {
      ok: true,
      username: bot.username || profile.name,
      version: originalBotVersion || bot.version || '26.2',
      host: config.host,
      port: config.port || 'SRV/default',
      output,
      size,
      renderer: webgl.renderer
    }
  } finally {
    try { await browser?.close() } catch {}
    try { await viewerClose?.() } catch {}
    try {
      if (frameDir && fs.existsSync(frameDir)) {
        fs.rmSync(frameDir, { recursive: true, force: true })
      }
    } catch {}
    try {
      if (bot) {
        if (persistentBotError) bot.removeListener('error', persistentBotError)
        if (persistentKicked) bot.removeListener('kicked', persistentKicked)
        if (persistentEnd) bot.removeListener('end', persistentEnd)
        if (persistentClientError) bot?._client?.removeListener?.('error', persistentClientError)
      }
    } catch {}
    try { bot?.quit('ESN CAM render test complete') } catch {}
  }
}

module.exports = { testJavaRender }
