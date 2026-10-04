'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function commandExists(command, args = ['-version']) {
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', timeout: 5000 })
    return result.status === 0
  } catch {
    return false
  }
}

function canRequire(name) {
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}

function runDiagnostics(config) {
  const checks = {
    node: process.version,
    edition: config.minecraft.edition || 'unknown',
    bedrockProtocol: canRequire('bedrock-protocol'),
    ffmpeg: commandExists('ffmpeg'),
    prismarineViewer: canRequire('prismarine-viewer'),
    puppeteerCore: canRequire('puppeteer-core'),
    chromium: canRequire('@sparticuz/chromium'),
    legacyNativeRenderer: canRequire('node-canvas-webgl') || canRequire('gl'),
    authDirectoryWritable: true,
    recordingsDirectoryWritable: true,
    display: Boolean(process.env.DISPLAY)
  }

  for (const [key, relativeDir] of [
    ['authDirectoryWritable', 'auth'],
    ['recordingsDirectoryWritable', config.recording.directory]
  ]) {
    const dir = path.join(__dirname, '..', relativeDir)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
    } catch {
      checks[key] = false
    }
  }

  if (checks.edition === 'bedrock') {
    checks.rendererReady = false
  } else {
    checks.rendererReady = Boolean(
      checks.prismarineViewer &&
      checks.puppeteerCore &&
      checks.chromium &&
      checks.ffmpeg &&
      !checks.legacyNativeRenderer
    )
  }

  return checks
}

module.exports = { runDiagnostics }
