'use strict'

globalThis.THREE = require('three')
const THREE = globalThis.THREE
const { Vec3 } = require('vec3')
const { WorldRenderer } = require('prismarine-viewer/viewer/lib/worldrenderer')

const socket = globalThis.io({
  path: window.location.pathname + 'socket.io'
})

const renderer = new THREE.WebGLRenderer({
  antialias: false,
  alpha: false,
  powerPreference: 'low-power'
})
renderer.setPixelRatio(1)
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color('lightblue')

const ambientLight = new THREE.AmbientLight(0xcccccc)
scene.add(ambientLight)

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5)
directionalLight.position.set(1, 1, 0.5).normalize()
scene.add(directionalLight)

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
)

const world = new WorldRenderer(scene, 1)

function animate () {
  window.requestAnimationFrame(animate)
  world.update()
  renderer.render(scene, camera)
}
animate()

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

socket.on('version', version => {
  // The bridge already sends the Prismarine-compatible viewer version.
  world.setVersion(version, version)
})

socket.on('loadChunk', ({ x, z, chunk }) => {
  world.addColumn(x, z, chunk)
})

socket.on('unloadChunk', ({ x, z }) => {
  world.removeColumn(x, z)
})

socket.on('blockUpdate', ({ pos, stateId }) => {
  world.setBlockStateId(new Vec3(pos.x, pos.y, pos.z), stateId)
})

socket.on('position', ({ pos, yaw, pitch }) => {
  if (!pos) return
  camera.position.set(pos.x, pos.y + 1.6, pos.z)
  camera.rotation.set(pitch || 0, yaw || 0, 0, 'ZYX')
})

window.__esnLiteViewerReady = true
