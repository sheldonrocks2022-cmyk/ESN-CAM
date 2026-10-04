'use strict'

const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

const repoRoot = path.resolve(__dirname, '..')
const buildModules = path.join(repoRoot, '.browser-build', 'node_modules')
const outputDir = path.join(repoRoot, 'public')
fs.mkdirSync(outputDir, { recursive: true })

const utilsWeb = path.join(
  buildModules,
  'prismarine-viewer',
  'viewer',
  'lib',
  'utils.web.js'
)

esbuild.build({
  entryPoints: [path.join(repoRoot, 'src', 'browser-viewer-entry.js')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: true,
  outfile: path.join(outputDir, 'esn-viewer.js'),
  nodePaths: [buildModules],
  define: {
    'process.platform': '"browser"',
    'process.env.NODE_ENV': '"production"'
  },
  plugins: [
    {
      name: 'prismarine-utils-web',
      setup (build) {
        build.onResolve({ filter: /^\.\/utils$/ }, args => {
          if (args.importer.includes('prismarine-viewer/viewer/lib/worldrenderer.js')) {
            return { path: utilsWeb }
          }
          return null
        })

        build.onResolve({ filter: /^events$/ }, () => ({
          path: require.resolve('events', { paths: [buildModules] })
        }))
      }
    }
  ]
}).then(() => {
  const out = path.join(outputDir, 'esn-viewer.js')
  console.log('[ESN CAM] Built lightweight browser viewer:', out, fs.statSync(out).size, 'bytes')
}).catch(error => {
  console.error(error)
  process.exit(1)
})
