/**
 * ccnow-agent: Modular edge daemon for ccnow (tmux-agent-deck)
 * Bundled into single-file client/ccnow-agent.js via esbuild (npm run build).
 */

const fs = require('fs');
const path = require('path');
const {
  CLIENT_VERSION,
  CONFIG_DIR,
  CONFIG_FILE,
  WORKSPACES_FILE,
  readConfig,
  parseArgs,
  applyManagedGatewayEnv
} = require('./config');
const { AgentClient } = require('./client');
const { downloadAndApplyUpdate } = require('./updater');
const { handleServiceCommand } = require('./serviceManager');
const { runSetupCommand } = require('./depsManager');

function printHelp() {
  console.log(`
ccnow-agent (v${CLIENT_VERSION}) - Ultra-lightweight edge daemon for ccnow (tmux-agent-deck)

Usage:
  curl -fsSL https://<server>/agent.js | node - connect --server <url> --token <token> [--daemon] [--name <name>]
      Pair and connect this device to the ccnow Web Control Plane
      Add --daemon to automatically install and start as a background service (macOS / Linux)

  node ~/.ccnow/ccnow-agent.js start [--server <url>]
      Start daemon in foreground using saved credentials from ~/.ccnow/device.json

  node ~/.ccnow/ccnow-agent.js update [--server <url>]
      Download latest ccnow-agent from server and apply self-update

  node ~/.ccnow/ccnow-agent.js service <install|start|stop|restart|status|logs|uninstall>
      Manage background daemon service via macOS LaunchAgent or Linux systemd user unit

  node ~/.ccnow/ccnow-agent.js status
      Show currently paired device details

  node ~/.ccnow/ccnow-agent.js version
      Show client daemon version

  node ~/.ccnow/ccnow-agent.js unpair
      Remove local pairing configuration
`);
}

const parsed = parseArgs(process.argv.slice(2));

switch (parsed.command) {
  case 'version':
  case '-v':
  case '--version': {
    console.log(`ccnow-agent v${CLIENT_VERSION}`);
    break;
  }

  case 'update': {
    const config = readConfig();
    const server = parsed.options.server || config?.server;
    if (!server) {
      console.error('❌ Error: No server URL specified. Provide --server <url> or pair first.');
      process.exit(1);
    }
    console.log(`⬇️ Checking for updates and downloading from ${server}...`);
    downloadAndApplyUpdate(server).then((res) => {
      console.log('🎉 Update applied successfully!');
      console.log(`📁 Target:  ${res.path}`);
      console.log(`🏷️ Version: ${CLIENT_VERSION} ➔ ${res.version}`);
      process.exit(0);
    }).catch((err) => {
      console.error(`❌ Update failed: ${err.message}`);
      process.exit(1);
    });
    break;
  }

  case 'service': {
    const subcommand = parsed.options._subcommand || process.argv[3] || 'status';
    const result = handleServiceCommand(subcommand, parsed.options);
    if (result && !result.ok && !result.streaming) {
      process.exit(1);
    }
    break;
  }

  case 'setup': {
    runSetupCommand().then(() => process.exit(0)).catch((err) => {
      console.error('❌ Setup failed:', err.message);
      process.exit(1);
    });
    break;
  }

  case 'connect': {
    const { server, token, name, daemon, background } = parsed.options;
    if (!server || !token) {
      console.error('❌ Error: Both --server and --token are required for connect.');
      printHelp();
      process.exit(1);
    }

    const daemonMode = Boolean(daemon || background);
    console.log(daemonMode
      ? '🚀 Starting ccnow-agent pairing (background daemon mode)...'
      : '🚀 Starting ccnow-agent pairing...');
    const client = new AgentClient(server, { token, customName: name, daemon: daemonMode });
    client.start();

    process.on('SIGINT', () => {
      console.log('\n👋 Disconnecting ccnow-agent...');
      client.stop();
      process.exit(0);
    });
    break;
  }

  case 'start': {
    const config = readConfig() || {};
    const server = parsed.options.server || process.env.CCNOW_SERVER_URL || config.server;
    const deviceId = process.env.CCNOW_DEVICE_ID || config.deviceId;
    const deviceSecret = process.env.CCNOW_DEVICE_SECRET || config.deviceSecret;
    const deviceName = process.env.CCNOW_DEVICE_NAME || config.name || deviceId;

    if (!deviceId || !deviceSecret || !server) {
      console.error('❌ Error: No valid device credentials found in ~/.ccnow/device.json or CCNOW_* env vars');
      console.error('Please run `npx ccnow-agent connect --server <url> --token <token>` first.');
      process.exit(1);
    }

    if (process.env.CCNOW_DEFAULT_WORKSPACE && !fs.existsSync(WORKSPACES_FILE)) {
      try {
        if (!fs.existsSync(CONFIG_DIR)) {
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        const defaultWsName = process.env.CCNOW_DEFAULT_WORKSPACE_NAME || path.basename(process.env.CCNOW_DEFAULT_WORKSPACE) || 'workspace';
        const seed = [{ name: defaultWsName, path: process.env.CCNOW_DEFAULT_WORKSPACE }];
        fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(seed, null, 2), 'utf8');
      } catch (err) {
        console.warn('⚠️ Failed to seed default workspace:', err.message);
      }
    }

    // Align Terminal/Tmux & OAR Pure Chat with Control Plane LLM Gateway when managed (host-admin)
    applyManagedGatewayEnv({ server, deviceId, deviceSecret });

    console.log(`🚀 Starting ccnow-agent (Device: ${deviceName})...`);
    const client = new AgentClient(server, {
      deviceId,
      deviceSecret,
      customName: deviceName
    });
    client.start();

    const shutdown = (sig) => {
      console.log(`\n👋 Disconnecting ccnow-agent (${sig})...`);
      client.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    break;
  }

  case 'status': {
    const config = readConfig();
    if (!config) {
      console.log('ℹ️ No device configuration found. Device is not paired yet.');
    } else {
      console.log('📱 Paired Device Info:');
      console.log(`  Name:      ${config.name || 'N/A'}`);
      console.log(`  Device ID: ${config.deviceId}`);
      console.log(`  Server:    ${config.server}`);
      console.log(`  Config:    ${CONFIG_FILE}`);
    }
    break;
  }

  case 'unpair': {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
      console.log('✅ Local device configuration removed.');
    } else {
      console.log('ℹ️ No configuration file found.');
    }
    break;
  }

  case 'help':
  default:
    printHelp();
    break;
}
