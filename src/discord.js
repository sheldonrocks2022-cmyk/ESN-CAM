'use strict'

const {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder
} = require('discord.js')
const fs = require('node:fs')
const { addShot, clearPreset, listPresets } = require('./scenes')
const { runDiagnostics } = require('./diagnostics')
const { createGrowthManager } = require('./growth')
const { createFinanceManager } = require('./finance')
const { createVideoManager } = require('./video')
const { testJavaAccess, testJavaConnection } = require('./java')
const { testJavaRender } = require('./java-render')

const PRESET_CHOICES = [
  { name: 'Full Advertisement', value: 'full-ad' },
  { name: 'Spawn', value: 'spawn' },
  { name: 'PvP', value: 'pvp' },
  { name: 'Boss', value: 'boss' },
  { name: 'Exclusive Items', value: 'exclusive-items' }
]

function addPresetOption(sub, required = true) {
  return sub.addStringOption(option => option
    .setName('preset')
    .setDescription('Advertisement preset')
    .setRequired(required)
    .addChoices(...PRESET_CHOICES))
}

function commandDefinition() {
  return new SlashCommandBuilder()
    .setName('cam')
    .setDescription('Control ESN CAM')
    .addSubcommand(sub => sub.setName('start').setDescription('Connect ESN CAM to ESN SMP'))
    .addSubcommand(sub => sub.setName('stop').setDescription('Disconnect ESN CAM from Minecraft'))
    .addSubcommand(sub => sub.setName('switch-account').setDescription('Clear cached Microsoft login and sign in with a different account'))
    .addSubcommand(sub => sub.setName('status').setDescription('Show ESN CAM status'))
    .addSubcommand(sub => sub.setName('diagnostics').setDescription('Check host recording support'))
    .addSubcommand(sub => sub.setName('network-test').setDescription('Test host connection to the ESN SMP Bedrock listener'))
    .addSubcommand(sub => sub.setName('java-test').setDescription('Verify Java entitlement with Microsoft login'))
    .addSubcommand(sub => sub.setName('java-connect').setDescription('Test Java 26.2 login and spawn on ESN SMP'))
    .addSubcommand(sub => sub.setName('java-render-test').setDescription('Render a short real Java CAM clip from ESN SMP'))
    .addSubcommand(sub => sub.setName('presets').setDescription('List recording presets and shot counts'))
    .addSubcommand(sub => addPresetOption(
      sub.setName('record').setDescription('Record an advertisement preset')
    ))
    .addSubcommand(sub =>
      sub.setName('shot-add')
        .setDescription('Save ESN CAM current position as a shot')
        .addStringOption(option => option
          .setName('preset')
          .setDescription('Advertisement preset')
          .setRequired(true)
          .addChoices(...PRESET_CHOICES))
        .addStringOption(option => option
          .setName('name')
          .setDescription('Shot name')
          .setRequired(true))
        .addIntegerOption(option => option
          .setName('seconds')
          .setDescription('Clip length in seconds')
          .setMinValue(1)
          .setMaxValue(30)
          .setRequired(false)))
    .addSubcommand(sub => addPresetOption(
      sub.setName('shot-clear').setDescription('Delete every shot in a preset')
    ))
    .addSubcommand(sub => sub
      .setName('goto')
      .setDescription('Move ESN CAM to coordinates')
      .addNumberOption(option => option.setName('x').setDescription('X').setRequired(true))
      .addNumberOption(option => option.setName('y').setDescription('Y').setRequired(true))
      .addNumberOption(option => option.setName('z').setDescription('Z').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('look')
      .setDescription('Aim ESN CAM at coordinates')
      .addNumberOption(option => option.setName('x').setDescription('Target X').setRequired(true))
      .addNumberOption(option => option.setName('y').setDescription('Target Y').setRequired(true))
      .addNumberOption(option => option.setName('z').setDescription('Target Z').setRequired(true)))
}

function isAuthorized(interaction, config) {
  if (config.ownerUserId && interaction.user.id === config.ownerUserId) return true
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true

  const roles = interaction.member?.roles
  const roleIds = roles?.cache ? [...roles.cache.keys()] : Array.isArray(roles) ? roles : []
  return config.allowedRoleIds.some(id => roleIds.includes(id))
}

function statusLine(value) {
  return value ? 'YES' : 'NO'
}

async function safeReply(interaction, options) {
  if (interaction.deferred || interaction.replied) return interaction.followUp(options)
  return interaction.reply(options)
}

async function createDiscordController(config, camera, recorder, fullConfig) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] })
  const growth = createGrowthManager(fullConfig.growth, recorder)
  const finance = createFinanceManager(fullConfig.finance, config)
  const video = createVideoManager(fullConfig.cinematic)

  client.once('clientReady', async () => {
    const definition = commandDefinition().toJSON()
    const growthDefinition = growth.commandDefinition().toJSON()
    const financeDefinition = finance.commandDefinition().toJSON()
    const videoDefinition = video.commandDefinition().toJSON()
    if (config.guildId) {
      const guild = await client.guilds.fetch(config.guildId)
      await guild.commands.set([definition, growthDefinition, financeDefinition, videoDefinition])
      console.log(`ESN Operator ready as ${client.user.tag}; /cam + /growth + /esn + /video registered in ${guild.name}`)
    } else {
      await client.application.commands.set([definition, growthDefinition, financeDefinition, videoDefinition])
      console.log(`ESN Operator ready as ${client.user.tag}; /cam + /growth + /esn + /video registered globally`)
    }
    growth.start(client)
  })

  camera.on('warning', message => console.warn(`[Minecraft] ${message}`))
  camera.on('online', () => console.log('[Minecraft] ESN CAM joined the server'))
  camera.on('offline', reason => console.log(`[Minecraft] Disconnected: ${reason || 'unknown'}`))

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return

    if (interaction.commandName === 'growth') {
      if (!isAuthorized(interaction, config)) {
        await interaction.reply({ content: 'You are not authorized to control the ESN Growth Center.', ephemeral: true })
        return
      }

      try {
        await growth.handle(interaction)
      } catch (error) {
        console.error(error)
        await safeReply(interaction, { content: `ESN Growth error: ${error.message}`, ephemeral: true })
      }
      return
    }

    if (interaction.commandName === 'esn') {
      if (!isAuthorized(interaction, config)) {
        await interaction.reply({ content: 'You are not authorized to control ESN Operator.', ephemeral: true })
        return
      }

      try {
        await finance.handle(interaction)
      } catch (error) {
        console.error(error)
        await safeReply(interaction, { content: `ESN Operator error: ${error.message}`, ephemeral: true })
      }
      return
    }

    if (interaction.commandName === 'video') {
      if (!isAuthorized(interaction, config)) {
        await interaction.reply({ content: 'You are not authorized to control ESN Cinematic AI.', ephemeral: true })
        return
      }

      try {
        await video.handle(interaction)
      } catch (error) {
        console.error(error)
        await safeReply(interaction, { content: `ESN Video error: ${error.message}`, ephemeral: true })
      }
      return
    }

    if (interaction.commandName !== 'cam') return

    if (!isAuthorized(interaction, config)) {
      await interaction.reply({ content: 'You are not authorized to control ESN CAM.', ephemeral: true })
      return
    }

    const sub = interaction.options.getSubcommand()

    try {
      if (sub === 'start') {
        await interaction.deferReply({ ephemeral: true })
        if (!camera.config.port) camera.config.port = 17429
        await camera.start(async data => {
          const url = data.verification_uri || data.verification_uri_complete || 'https://www.microsoft.com/link'
          const code = data.user_code || data.code || 'Check the host console'
          await interaction.followUp({
            content: `**Microsoft login required**\nOpen: ${url}\nCode: **${code}**\nAfter you approve it, ESN CAM will continue connecting automatically.`,
            ephemeral: true
          }).catch(() => {})
        })
        await interaction.editReply(`ESN CAM is connecting to **${fullConfig.minecraft.host}:${fullConfig.minecraft.port}** using **Minecraft Bedrock**. If Microsoft/Xbox needs authorization, I will send the login code here.`)
        return
      }

      if (sub === 'stop') {
        await camera.stop()
        await interaction.reply({ content: 'ESN CAM has been disconnected.', ephemeral: true })
        return
      }

      if (sub === 'switch-account') {
        await interaction.deferReply({ ephemeral: true })
        await camera.stop()

        const authFolder = fullConfig.minecraft.profilesFolder
        fs.rmSync(authFolder, { recursive: true, force: true })
        fs.mkdirSync(authFolder, { recursive: true })

        await interaction.editReply('Cached Bedrock/Xbox login cleared. Starting a fresh Microsoft sign-in now...')

        if (!camera.config.port) camera.config.port = 17429
        await camera.start(async data => {
          const url = data.verification_uri || data.verification_uri_complete || 'https://www.microsoft.com/link'
          const code = data.user_code || data.code || 'Check the host console'
          await interaction.followUp({
            content: `**Choose the Microsoft account with your Bedrock/Xbox profile**\nOpen: ${url}\nCode: **${code}**\nSign in with the correct Microsoft account. ESN CAM will reconnect to ESN SMP automatically after approval.`,
            ephemeral: true
          }).catch(() => {})
        })

        return
      }

      if (sub === 'status') {
        const mc = camera.getStatus()
        const recording = recorder.getStatus()
        const pos = mc.position ? `${mc.position.x}, ${mc.position.y}, ${mc.position.z}` : 'unknown'
        await interaction.reply({
          content:
            `**Minecraft:** ${mc.state}\n` +
            `**Edition:** ${mc.edition || 'Bedrock'}\n` +
            `**Account:** ${mc.username || 'not connected'}\n` +
            `**Minecraft version:** ${mc.version || 'unknown'}\n` +
            `**Position:** ${pos}\n` +
            `**Recording:** ${recording.active ? 'ACTIVE' : 'idle'}\n` +
            `**Last job:** ${recording.lastJob?.state || 'none'}` +
            (mc.lastError ? `\n**Last error:** ${mc.lastError}` : ''),
          ephemeral: true
        })
        return
      }

      if (sub === 'java-test') {
        await interaction.deferReply({ ephemeral: true })
        await interaction.editReply('Starting the **Minecraft Java** entitlement test. If Microsoft asks for authorization, I will send the code here.')

        const result = await testJavaAccess(fullConfig.java, async data => {
          const url = data.verification_uri || data.verification_uri_complete || 'https://www.microsoft.com/link'
          const code = data.user_code || data.code || 'Check the host console'
          await interaction.followUp({
            content:
              '**Java Microsoft login required**\n' +
              'Open: ' + url + '\n' +
              'Code: **' + code + '**\n' +
              'Sign in with the Microsoft account that has Game Pass Premium.',
            ephemeral: true
          }).catch(() => {})
        })

        await interaction.editReply(
          '**JAVA ACCESS CONFIRMED**\n' +
          'Account: **' + (result.username || 'authenticated') + '**\n' +
          'Minecraft version: **' + (result.version || 'auto') + '**\n' +
          'Server: **' + result.host + ':' + result.port + '**\n\n' +
          'This account can be used for the Java recording side of ESN Operator.'
        )
        return
      }

      if (sub === 'java-connect') {
        await interaction.deferReply({ ephemeral: true })
        await interaction.editReply('Connecting the Java CAM to **ESN SMP 26.2** now. If Microsoft asks for authorization, I will send the code here.')

        const result = await testJavaConnection(fullConfig.java, async data => {
          const url = data.verification_uri || data.verification_uri_complete || 'https://www.microsoft.com/link'
          const code = data.user_code || data.code || 'Check the host console'
          await interaction.followUp({
            content: '**Java Microsoft login required**\\nOpen: ' + url + '\\nCode: **' + code + '**',
            ephemeral: true
          }).catch(() => {})
        })

        const pos = result.position ? `\\nSpawned at: **${result.position.x}, ${result.position.y}, ${result.position.z}**` : ''
        await interaction.editReply(
          '**JAVA 26.2 CONNECTION: PASS**\\n' +
          'Account: **' + result.username + '**\\n' +
          'Version: **' + result.version + '**\\n' +
          'Server: **' + result.host + ':' + result.port + '**' + pos
        )
        return
      }

      if (sub === 'java-render-test') {
        await interaction.deferReply({ ephemeral: true })
        await interaction.editReply('Joining ESN SMP with the Java CAM and attempting a short real render now...')

        const result = await testJavaRender(fullConfig.java, async data => {
          const url = data.verification_uri || data.verification_uri_complete || 'https://www.microsoft.com/link'
          const code = data.user_code || data.code || 'Check the host console'
          await interaction.followUp({
            content: '**Java Microsoft login required**\nOpen: ' + url + '\nCode: **' + code + '**',
            ephemeral: true
          }).catch(() => {})
        })

        const size = fs.statSync(result.output).size
        const discordLimit = 24 * 1024 * 1024
        if (size <= discordLimit) {
          await interaction.editReply({
            content:
              '**JAVA RENDER TEST: PASS**\n' +
              'Account: **' + result.username + '**\n' +
              'Version: **' + result.version + '**\n' +
              'Real Minecraft render attached.',
            files: [new AttachmentBuilder(result.output)]
          })
        } else {
          await interaction.editReply(
            '**JAVA RENDER TEST: PASS**\nRendered successfully, but the MP4 is too large to attach. Saved as: `' + result.output + '`'
          )
        }
        return
      }

      if (sub === 'network-test') {
        await interaction.deferReply({ ephemeral: true })
        const result = await camera.testConnection()
        if (result.ok) {
          await interaction.editReply(
            `**Bedrock network test: PASS**\n` +
            `Host: ${result.host}\n` +
            `Resolved IP: ${result.resolvedHost}\n` +
            `Port: ${result.port}/UDP\n` +
            `Latency: ${result.latencyMs} ms\n` +
            `MOTD: ${result.motd}\n` +
            `Version: ${result.version}\n` +
            `Players: ${result.players}`
          )
        } else {
          await interaction.editReply(
            `**Bedrock network test: FAIL**\n` +
            `Host: ${result.host}\n` +
            `Resolved IP: ${result.resolvedHost}\n` +
            `Port: ${result.port}/UDP\n` +
            `Waited: ${result.latencyMs} ms\n` +
            `Error: ${result.error}`
          )
        }
        return
      }

      if (sub === 'diagnostics') {
        const d = runDiagnostics(fullConfig)
        await interaction.reply({
          content:
            `**Minecraft edition:** ${d.edition}\n` +
            `**Bedrock protocol:** ${statusLine(d.bedrockProtocol)}\n` +
            `**Host video renderer ready:** ${statusLine(d.rendererReady)}\n` +
            `**Java viewer components**\n` +
            `Prismarine Viewer: ${statusLine(d.prismarineViewer)}\n` +
            `Puppeteer Core: ${statusLine(d.puppeteerCore)}\n` +
            `Chromium/SwiftShader: ${statusLine(d.chromium)}\n` +
            `Legacy native GL disabled: ${statusLine(!d.legacyNativeRenderer)}\n` +
            `FFmpeg: ${statusLine(d.ffmpeg)}\n` +
            `Node: ${d.node}\n` +
            `Writable auth storage: ${statusLine(d.authDirectoryWritable)}\n` +
            `Writable recordings storage: ${statusLine(d.recordingsDirectoryWritable)}`,
          ephemeral: true
        })
        return
      }

      if (sub === 'presets') {
        const lines = listPresets().map(p => `**${p.name}** — ${p.shots} shots — ${p.description}`)
        await interaction.reply({ content: lines.join('\n') || 'No presets configured.', ephemeral: true })
        return
      }

      if (sub === 'goto') {
        await interaction.deferReply({ ephemeral: true })
        const x = interaction.options.getNumber('x', true)
        const y = interaction.options.getNumber('y', true)
        const z = interaction.options.getNumber('z', true)
        await camera.goTo({ x, y, z }, 1)
        await interaction.editReply(`ESN CAM reached **${x}, ${y}, ${z}**.`)
        return
      }

      if (sub === 'look') {
        const x = interaction.options.getNumber('x', true)
        const y = interaction.options.getNumber('y', true)
        const z = interaction.options.getNumber('z', true)
        await camera.lookAt({ x, y, z })
        await interaction.reply({ content: `ESN CAM is now aimed at **${x}, ${y}, ${z}**.`, ephemeral: true })
        return
      }

      if (sub === 'shot-add') {
        const preset = interaction.options.getString('preset', true)
        const name = interaction.options.getString('name', true)
        const seconds = interaction.options.getInteger('seconds') || 5
        const shot = camera.getCurrentShot(name, seconds)
        const count = addShot(preset, shot)
        await interaction.reply({
          content: `Saved **${name}** to **${preset}** as shot #${count}.`,
          ephemeral: true
        })
        return
      }

      if (sub === 'shot-clear') {
        const preset = interaction.options.getString('preset', true)
        clearPreset(preset)
        await interaction.reply({ content: `Cleared every shot from **${preset}**.`, ephemeral: true })
        return
      }

      if (sub === 'record') {
        const preset = interaction.options.getString('preset', true)
        await interaction.deferReply({ ephemeral: true })
        await interaction.editReply(`Recording **${preset}** now...`)

        const result = await recorder.recordPreset(preset)
        if (!result.finalOutput || !fs.existsSync(result.finalOutput)) {
          await interaction.followUp({ content: `Recording completed, but the final output file could not be found. Job: ${result.id}`, ephemeral: true })
          return
        }

        const size = fs.statSync(result.finalOutput).size
        const discordLimit = 24 * 1024 * 1024
        if (size <= discordLimit) {
          const attachment = new AttachmentBuilder(result.finalOutput)
          await interaction.followUp({
            content: `**${preset}** recording complete.`,
            files: [attachment]
          })
        } else {
          await interaction.followUp({
            content: `**${preset}** recording complete, but it is too large to attach here. Saved as: \`${result.finalOutput}\``,
            ephemeral: true
          })
        }
      }
    } catch (error) {
      console.error(error)
      await safeReply(interaction, { content: `ESN CAM error: ${error.message}`, ephemeral: true })
    }
  })

  await client.login(config.token)
  return client
}

module.exports = { createDiscordController }
