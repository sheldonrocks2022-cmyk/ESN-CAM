'use strict'

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
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


async function startBrowserViewerBridge(bot, { port, firstPerson = true, viewDistance = 6 }, stage) {
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
    socket.emit('version', bot.version)

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
  let originalBotVersion
  let viewerClose
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
    await wait(2500)

    stage('RENDERER', 'starting Chromium + SwiftShader browser renderer')

    stage('BROWSER_MODULES', 'loading Puppeteer and Chromium')
    const puppeteer = require('puppeteer-core')
    const chromiumModule = require('@sparticuz/chromium')
    const chromium = chromiumModule.default || chromiumModule

    // Prismarine Viewer 1.33.0 has 26.1 rendering assets. The ESN SMP
    // protocol client remains 26.2; only the browser viewer is told to use
    // the compatible 26.1 asset set.
    originalBotVersion = bot.version
    if (bot.version === '26.2') {
      bot.version = '26.1'
      stage('VIEWER_ASSETS', 'using 26.1 viewer assets for the 26.2 world stream')
    }

    const viewerPort = await getFreePort()
    viewerClose = await startBrowserViewerBridge(bot, {
      port: viewerPort,
      firstPerson: true,
      viewDistance: 6
    }, stage)
    await wait(750)

    chromium.setGraphicsMode = true
    const executablePath = await chromium.executablePath()
    const chromiumArgs = [
      ...chromium.args,
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage'
    ]

    const args = await puppeteer.defaultArgs({
      args: chromiumArgs,
      headless: 'shell'
    })

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

    page.on('pageerror', error => {
      stage('PAGE_ERROR', String(error?.message || error).slice(0, 500))
    })
    page.on('console', message => {
      const type = message.type()
      if (type === 'error' || type === 'warning') {
        stage('BROWSER_' + type.toUpperCase(), message.text().slice(0, 500))
      }
    })

    await page.goto('http://127.0.0.1:' + viewerPort + '/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    await page.waitForSelector('canvas', { timeout: 20000 })
    await wait(6000)

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
    const frameDir = path.join(outputDir, 'frames-' + Date.now())
    fs.mkdirSync(frameDir, { recursive: true })
    const output = path.join(outputDir, 'java-render-' + Date.now() + '.mp4')

    const frames = 40
    const fps = 10
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
    try { if (bot && originalBotVersion) bot.version = originalBotVersion } catch {}
    try { bot?.quit('ESN CAM render test complete') } catch {}
  }
}

module.exports = { testJavaRender }
