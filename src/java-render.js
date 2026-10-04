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


function blockRenderStyle(name = '') {
  const n = String(name).toLowerCase()

  const colors = {
    black: 0x202124, blue: 0x3155a4, brown: 0x70452b, cyan: 0x2b9da9,
    gray: 0x777777, green: 0x3f7f3f, light_blue: 0x6eaee8,
    light_gray: 0xaaaaaa, lime: 0x72b943, magenta: 0xb24fb5,
    orange: 0xd87f33, pink: 0xd8899b, purple: 0x7b3f98,
    red: 0xa33b35, white: 0xe8e8e8, yellow: 0xd9c647
  }

  for (const [key, value] of Object.entries(colors)) {
    if (n.startsWith(key + '_') || n.includes('_' + key + '_')) return { color: value, opacity: 1 }
  }

  if (n.includes('water')) return { color: 0x315fae, opacity: 0.55 }
  if (n.includes('lava')) return { color: 0xe46d1d, opacity: 0.8 }
  if (n.includes('grass') || n.includes('moss')) return { color: 0x5c8f45, opacity: 1 }
  if (n.includes('leaves') || n.includes('vine')) return { color: 0x477a3b, opacity: 0.92 }
  if (n.includes('dirt') || n.includes('mud')) return { color: 0x76543a, opacity: 1 }
  if (n.includes('sand') || n.includes('sandstone')) return { color: 0xc9b77b, opacity: 1 }
  if (n.includes('snow') || n.includes('quartz')) return { color: 0xe8e8e8, opacity: 1 }
  if (n.includes('ice')) return { color: 0x9fd5ea, opacity: 0.72 }
  if (n.includes('glass')) return { color: 0xa9dce8, opacity: 0.38 }
  if (n.includes('deepslate') || n.includes('blackstone')) return { color: 0x414247, opacity: 1 }
  if (n.includes('stone') || n.includes('cobble') || n.includes('andesite')) return { color: 0x777a78, opacity: 1 }
  if (n.includes('granite')) return { color: 0x9b6755, opacity: 1 }
  if (n.includes('diorite')) return { color: 0xb9b7b0, opacity: 1 }
  if (n.includes('brick') || n.includes('terracotta')) return { color: 0x9b5545, opacity: 1 }
  if (n.includes('oak') || n.includes('wood') || n.includes('plank') || n.includes('log')) return { color: 0x8a6842, opacity: 1 }
  if (n.includes('spruce')) return { color: 0x60482e, opacity: 1 }
  if (n.includes('birch')) return { color: 0xc8b985, opacity: 1 }
  if (n.includes('copper')) return { color: 0xb56f50, opacity: 1 }
  if (n.includes('gold')) return { color: 0xd6b739, opacity: 1 }
  if (n.includes('diamond')) return { color: 0x54c6c2, opacity: 1 }
  if (n.includes('emerald')) return { color: 0x43a85b, opacity: 1 }
  if (n.includes('redstone')) return { color: 0xb53a31, opacity: 1 }
  if (n.includes('coal')) return { color: 0x303236, opacity: 1 }
  if (n.includes('netherrack') || n.includes('nether_brick')) return { color: 0x713c3b, opacity: 1 }
  if (n.includes('end_stone')) return { color: 0xd5d39b, opacity: 1 }
  if (n.includes('obsidian')) return { color: 0x29223a, opacity: 1 }
  if (n.includes('bedrock')) return { color: 0x3c3c3c, opacity: 1 }

  return { color: 0x8a8a86, opacity: 1 }
}

function isRenderableBlock(block) {
  if (!block || !block.name) return false
  const n = String(block.name).toLowerCase()
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return false
  if (n.includes('water') || n.includes('lava')) return true
  if (block.boundingBox === 'empty') return false
  return true
}

function buildLightweightScene(bot, stage) {
  const { Vec3 } = require('vec3')
  const center = bot.entity.position.floored()
  const radius = 13
  const down = 8
  const up = 10
  const cache = new Map()
  const key = (x, y, z) => x + ',' + y + ',' + z

  stage(
    'SCENE_SCAN',
    'reading nearby Minecraft blocks around ' + center.x + ', ' + center.y + ', ' + center.z
  )

  for (let x = center.x - radius; x <= center.x + radius; x++) {
    for (let z = center.z - radius; z <= center.z + radius; z++) {
      for (let y = center.y - down; y <= center.y + up; y++) {
        let block = null
        try { block = bot.blockAt(new Vec3(x, y, z), false) } catch {}
        cache.set(key(x, y, z), block)
      }
    }
  }

  const directions = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0],
    [0, -1, 0], [0, 0, 1], [0, 0, -1]
  ]

  const groups = new Map()
  let visible = 0

  for (const [coord, block] of cache) {
    if (!isRenderableBlock(block)) continue
    const [x, y, z] = coord.split(',').map(Number)

    let exposed = false
    for (const [dx, dy, dz] of directions) {
      const neighbor = cache.get(key(x + dx, y + dy, z + dz))
      if (!isRenderableBlock(neighbor)) {
        exposed = true
        break
      }
    }
    if (!exposed) continue

    const style = blockRenderStyle(block.name)
    const groupKey = style.color + ':' + style.opacity
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        color: style.color,
        opacity: style.opacity,
        positions: []
      })
    }
    groups.get(groupKey).positions.push([x, y, z])
    visible++
  }

  const entities = []
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || entity === bot.entity || !entity.position) continue
    const dx = entity.position.x - center.x
    const dy = entity.position.y - center.y
    const dz = entity.position.z - center.z
    if (Math.abs(dx) > radius || Math.abs(dz) > radius || Math.abs(dy) > 16) continue
    entities.push({
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      width: Math.max(0.35, Number(entity.width) || 0.6),
      height: Math.max(0.35, Number(entity.height) || 1.8)
    })
  }

  const scene = {
    groups: [...groups.values()],
    entities,
    camera: {
      x: bot.entity.position.x,
      y: bot.entity.position.y + 1.62,
      z: bot.entity.position.z,
      yaw: Number(bot.entity.yaw) || 0,
      pitch: Number(bot.entity.pitch) || 0
    },
    center: { x: center.x, y: center.y, z: center.z },
    visible
  }

  stage(
    'SCENE_READY',
    visible + ' exposed blocks in ' + scene.groups.length + ' material groups; ' +
    entities.length + ' nearby entities'
  )

  if (visible < 20) {
    throw new Error(
      'ESN lightweight renderer could not see enough loaded Minecraft blocks near the Java CAM.'
    )
  }

  return scene
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

    // Prismarine Viewer's 61 MB meshing worker hard-freezes Chromium on
    // this CogitHost container. Build a small real-world block snapshot from
    // Mineflayer instead, then render it directly with Three.js in Chromium.
    if (transportFailure) throw transportFailure
    const sceneSnapshot = buildLightweightScene(bot, stage)

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

    stage('ESN_RENDERER', 'starting lightweight real-block renderer')

    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>ESN CAM</title>' +
      '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#87b7df}' +
      'canvas{display:block;width:100%;height:100%}</style>' +
      '</head><body></body></html>',
      { waitUntil: 'domcontentloaded', timeout: 10000 }
    )

    let threePath
    try {
      const threeEntry = require.resolve('three')
      const buildDir = path.dirname(threeEntry)
      const min = path.join(buildDir, 'three.min.js')
      const plain = path.join(buildDir, 'three.js')
      threePath = fs.existsSync(min) ? min : plain
    } catch (error) {
      throw new Error('Three.js browser runtime is unavailable: ' + (error?.message || error))
    }

    if (!threePath || !fs.existsSync(threePath)) {
      throw new Error('Three.js browser file could not be found.')
    }

    stage('ESN_RENDERER', 'loading lightweight Three.js runtime')
    await page.addScriptTag({ path: threePath })

    await page.evaluate(snapshot => {
      if (!window.THREE) throw new Error('Three.js did not initialize.')

      const THREE = window.THREE
      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: 'low-power'
      })
      renderer.setPixelRatio(1)
      renderer.setSize(window.innerWidth, window.innerHeight)
      renderer.outputEncoding = THREE.sRGBEncoding
      document.body.appendChild(renderer.domElement)

      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x87b7df)
      scene.fog = new THREE.Fog(0x87b7df, 18, 48)

      const camera = new THREE.PerspectiveCamera(
        72,
        window.innerWidth / window.innerHeight,
        0.05,
        96
      )
      camera.position.set(snapshot.camera.x, snapshot.camera.y, snapshot.camera.z)
      camera.rotation.order = 'ZYX'
      camera.rotation.set(snapshot.camera.pitch, snapshot.camera.yaw, 0, 'ZYX')

      scene.add(new THREE.HemisphereLight(0xddeeff, 0x5a5548, 1.05))
      const sun = new THREE.DirectionalLight(0xffffff, 0.72)
      sun.position.set(0.6, 1, 0.4)
      scene.add(sun)

      const geometry = new THREE.BoxGeometry(1, 1, 1)
      const matrix = new THREE.Matrix4()

      for (const group of snapshot.groups) {
        const material = new THREE.MeshLambertMaterial({
          color: group.color,
          transparent: group.opacity < 1,
          opacity: group.opacity,
          depthWrite: group.opacity >= 0.8
        })
        const mesh = new THREE.InstancedMesh(geometry, material, group.positions.length)
        for (let i = 0; i < group.positions.length; i++) {
          const [x, y, z] = group.positions[i]
          matrix.makeTranslation(x + 0.5, y + 0.5, z + 0.5)
          mesh.setMatrixAt(i, matrix)
        }
        mesh.instanceMatrix.needsUpdate = true
        scene.add(mesh)
      }

      const entityGeometry = new THREE.BoxGeometry(1, 1, 1)
      const entityMaterial = new THREE.MeshLambertMaterial({ color: 0xd8a56d })
      for (const entity of snapshot.entities) {
        const mesh = new THREE.Mesh(entityGeometry, entityMaterial)
        mesh.scale.set(entity.width, entity.height, entity.width)
        mesh.position.set(entity.x, entity.y + entity.height / 2, entity.z)
        scene.add(mesh)
      }

      const baseYaw = snapshot.camera.yaw
      const basePitch = snapshot.camera.pitch
      const started = performance.now()

      function draw () {
        const t = (performance.now() - started) / 1000
        camera.rotation.set(
          basePitch + Math.sin(t * 0.65) * 0.006,
          baseYaw + Math.sin(t * 0.35) * 0.012,
          0,
          'ZYX'
        )
        renderer.render(scene, camera)
        requestAnimationFrame(draw)
      }

      draw()
      window.__esnRenderer = renderer
      window.__esnSceneReady = true
    }, sceneSnapshot)

    stage('ESN_CANVAS', 'lightweight Minecraft canvas created')

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
      throw new Error('ESN lightweight renderer could not use SwiftShader WebGL: ' + (webgl.reason || 'unknown'))
    }
    stage('WEBGL', 'ESN renderer ready via ' + webgl.renderer)

    const outputDir = path.join(__dirname, '..', 'recordings', 'java-render-tests')
    frameDir = path.join(outputDir, 'frames-' + Date.now())
    fs.mkdirSync(frameDir, { recursive: true })
    const output = path.join(outputDir, 'java-render-' + Date.now() + '.mp4')

    // The old test captured 40 PNGs through ElementHandle.screenshot().
    // On CPU-only SwiftShader hosting, each PNG encode can be very expensive.
    // Use Chrome DevTools' direct JPEG capture instead: fewer frames, much
    // less compression work, and per-frame watchdogs so CAPTURE can never hang.
    const frames = 18
    const fps = 6
    if (transportFailure) throw transportFailure
    stage('CAPTURE', 'fast capture: ' + frames + ' JPEG frames at ' + fps + ' fps')

    const canvasExists = await page.evaluate(() => !!document.querySelector('canvas')).catch(() => false)
    if (!canvasExists) throw new Error('ESN renderer canvas disappeared before capture.')

    const cdp = await page.createCDPSession()
    const captureStarted = Date.now()

    for (let i = 0; i < frames; i++) {
      if (transportFailure) throw transportFailure

      const shot = await Promise.race([
        cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 68,
          fromSurface: true,
          captureBeyondViewport: false
        }),
        wait(8000).then(() => {
          throw new Error('Frame ' + (i + 1) + ' capture timed out after 8 seconds.')
        })
      ])

      const framePath = path.join(frameDir, 'frame-' + String(i).padStart(4, '0') + '.jpg')
      fs.writeFileSync(framePath, Buffer.from(shot.data, 'base64'))

      if (i === 0 || (i + 1) % 3 === 0 || i === frames - 1) {
        stage('CAPTURE_PROGRESS', (i + 1) + '/' + frames + ' frames captured')
      }

      await wait(80)
    }

    stage(
      'CAPTURE_DONE',
      frames + ' frames captured in ' + Math.max(1, Math.round((Date.now() - captureStarted) / 1000)) + 's'
    )

    stage('ENCODE', 'encoding fast test MP4 with FFmpeg')
    const ffmpeg = spawnSync('ffmpeg', [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(frameDir, 'frame-%04d.jpg'),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '25',
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
      version: bot.version || '26.2',
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
