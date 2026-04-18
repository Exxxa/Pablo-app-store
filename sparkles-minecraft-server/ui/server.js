const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/logs' });
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const CONTAINER_NAME = process.env.MINECRAFT_CONTAINER || 'sparkles-minecraft-server_minecraft_1';
const DATA_DIR = process.env.DATA_DIR || '/minecraft-data';
const SERVER_PROPERTIES = path.join(DATA_DIR, 'server.properties');
const WHITELIST_FILE = path.join(DATA_DIR, 'whitelist.json');
const MC_SETTINGS_FILE = path.join(DATA_DIR, 'mc-settings.json');

const DEFAULT_MC_SETTINGS = {
  TYPE: 'VANILLA',
  VERSION: 'LATEST',
  MEMORY: '1G',
  LEVEL: 'world',
  USE_AIKAR_FLAGS: 'false',
  MODRINTH_MODPACK: '',
  MODRINTH_LOADER: '',
};

const BASE_ENV = { EULA: 'TRUE' };

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function getContainer() {
  const containers = await docker.listContainers({ all: true });
  const info = containers.find(c => c.Names.some(n => n.replace(/^\//, '') === CONTAINER_NAME));
  if (!info) throw new Error(`Container "${CONTAINER_NAME}" not found`);
  return docker.getContainer(info.Id);
}

function readMcSettings() {
  if (!fs.existsSync(MC_SETTINGS_FILE)) return { ...DEFAULT_MC_SETTINGS };
  try {
    return { ...DEFAULT_MC_SETTINGS, ...JSON.parse(fs.readFileSync(MC_SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_MC_SETTINGS };
  }
}

function writeMcSettings(settings) {
  fs.writeFileSync(MC_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function buildEnvArray(mcSettings) {
  const merged = { ...BASE_ENV, ...mcSettings };
  return Object.entries(merged)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
}

async function recreateContainer(mcSettings) {
  const container = await getContainer();
  const info = await container.inspect();

  const networkingConfig = {
    EndpointsConfig: Object.fromEntries(
      Object.entries(info.NetworkSettings.Networks).map(([name, cfg]) => [
        name,
        { IPAMConfig: cfg.IPAMConfig || {}, Aliases: cfg.Aliases || [] },
      ])
    ),
  };

  try { await container.stop({ t: 15 }); } catch (_) {}
  await container.remove();

  const newContainer = await docker.createContainer({
    name: CONTAINER_NAME,
    Image: info.Config.Image,
    Env: buildEnvArray(mcSettings),
    HostConfig: info.HostConfig,
    NetworkingConfig: networkingConfig,
    Labels: info.Config.Labels || {},
  });

  await newContainer.start();
  return newContainer;
}

function readServerProperties() {
  if (!fs.existsSync(SERVER_PROPERTIES)) return {};
  const props = {};
  fs.readFileSync(SERVER_PROPERTIES, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return;
    const eq = trimmed.indexOf('=');
    props[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  });
  return props;
}

function writeServerProperties(updates) {
  let lines = [];
  if (fs.existsSync(SERVER_PROPERTIES)) {
    lines = fs.readFileSync(SERVER_PROPERTIES, 'utf8').split('\n');
  }
  const updated = new Set();
  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) return line;
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      updated.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  Object.entries(updates).forEach(([key, val]) => {
    if (!updated.has(key)) newLines.push(`${key}=${val}`);
  });
  fs.writeFileSync(SERVER_PROPERTIES, newLines.join('\n'));
}

const SETTINGS_KEYS = [
  'server-name', 'motd', 'gamemode', 'difficulty', 'max-players',
  'white-list', 'online-mode', 'pvp',
  'level-seed', 'level-type', 'view-distance', 'simulation-distance',
  'max-world-size', 'max-build-height',
  'spawn-monsters', 'spawn-animals', 'spawn-npcs',
  'spawn-protection', 'allow-nether',
  'allow-flight', 'hardcore', 'force-gamemode',
  'player-idle-timeout', 'prevent-proxy-connections',
];

const SETTINGS_DEFAULTS = {
  'server-name': 'Minecraft Server',
  'motd': 'A Minecraft Server',
  'gamemode': 'survival',
  'difficulty': 'easy',
  'max-players': '20',
  'white-list': 'false',
  'online-mode': 'true',
  'pvp': 'true',
  'level-seed': '',
  'level-type': 'minecraft:normal',
  'view-distance': '10',
  'simulation-distance': '10',
  'max-world-size': '29999984',
  'max-build-height': '320',
  'spawn-monsters': 'true',
  'spawn-animals': 'true',
  'spawn-npcs': 'true',
  'spawn-protection': '16',
  'allow-nether': 'true',
  'allow-flight': 'false',
  'hardcore': 'false',
  'force-gamemode': 'false',
  'player-idle-timeout': '0',
  'prevent-proxy-connections': 'false',
};

// ── Status ─────────────────────────────────────────────────────────────────
app.get('/api/status', async (_req, res) => {
  try {
    const container = await getContainer();
    const info = await container.inspect();
    res.json({
      status: info.State.Status,
      running: info.State.Running,
      startedAt: info.State.StartedAt,
      image: info.Config.Image,
    });
  } catch (err) {
    res.json({ status: 'not_found', running: false, error: err.message });
  }
});

// ── Server controls ────────────────────────────────────────────────────────
app.post('/api/server/start', async (_req, res) => {
  try { const c = await getContainer(); await c.start(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/server/stop', async (_req, res) => {
  try { const c = await getContainer(); await c.stop(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/server/restart', async (_req, res) => {
  try { const c = await getContainer(); await c.restart(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Pull latest image + recreate container
app.post('/api/server/update', async (_req, res) => {
  try {
    const container = await getContainer();
    const info = await container.inspect();
    const image = info.Config.Image;

    await new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2) => err2 ? reject(err2) : resolve());
      });
    });

    const settings = readMcSettings();
    await recreateContainer(settings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── mc-config (Docker env vars) ────────────────────────────────────────────
app.get('/api/mc-config', (_req, res) => {
  res.json(readMcSettings());
});

app.post('/api/mc-config', async (req, res) => {
  try {
    const allowed = [
      'TYPE', 'VERSION', 'MEMORY', 'INIT_MEMORY', 'MAX_MEMORY',
      'LEVEL', 'USE_AIKAR_FLAGS',
      'MODRINTH_MODPACK', 'MODRINTH_LOADER', 'MODRINTH_MODPACK_VERSION_TYPE',
    ];
    const current = readMcSettings();
    const updates = {};
    allowed.forEach(k => {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        updates[k] = String(req.body[k]);
      }
    });
    const newSettings = { ...current, ...updates };
    writeMcSettings(newSettings);
    await recreateContainer(newSettings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Worlds ─────────────────────────────────────────────────────────────────
app.get('/api/worlds', (_req, res) => {
  try {
    if (!fs.existsSync(DATA_DIR)) return res.json({ worlds: [], active: 'world' });
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    const worlds = entries
      .filter(e => e.isDirectory() && fs.existsSync(path.join(DATA_DIR, e.name, 'level.dat')))
      .map(e => e.name);
    const active = readMcSettings().LEVEL || 'world';
    res.json({ worlds, active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Server properties ──────────────────────────────────────────────────────
app.get('/api/settings', (_req, res) => {
  try {
    const props = readServerProperties();
    const result = {};
    SETTINGS_KEYS.forEach(k => {
      result[k] = props[k] !== undefined ? props[k] : (SETTINGS_DEFAULTS[k] ?? '');
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const updates = {};
    SETTINGS_KEYS.forEach(k => {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) updates[k] = String(req.body[k]);
    });
    writeServerProperties(updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Whitelist ──────────────────────────────────────────────────────────────
app.get('/api/whitelist', (_req, res) => {
  try {
    if (!fs.existsSync(WHITELIST_FILE)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8')));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/whitelist/add', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid player name' });
    }
    let whitelist = [];
    if (fs.existsSync(WHITELIST_FILE)) whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    if (!whitelist.find(p => p.name === name)) {
      whitelist.push({ uuid: '', name });
      fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2));
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/whitelist/:name', (req, res) => {
  try {
    const { name } = req.params;
    let whitelist = [];
    if (fs.existsSync(WHITELIST_FILE)) whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    whitelist = whitelist.filter(p => p.name !== name);
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── WebSocket: Log streaming ───────────────────────────────────────────────
wss.on('connection', async (ws) => {
  let logStream = null;
  let closed = false;
  const cleanup = () => {
    closed = true;
    if (logStream) { try { logStream.destroy(); } catch (_) {} }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
  try {
    const container = await getContainer();
    logStream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 200 });
    let buffer = Buffer.alloc(0);
    logStream.on('data', (chunk) => {
      if (closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const size = buffer.readUInt32BE(4);
        if (buffer.length < 8 + size) break;
        const line = buffer.subarray(8, 8 + size).toString('utf8');
        buffer = buffer.subarray(8 + size);
        if (ws.readyState === WebSocket.OPEN) ws.send(line);
      }
    });
    logStream.on('end', () => {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send('[Log stream ended — container stopped]');
      cleanup();
    });
    logStream.on('error', (err) => {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send(`[Stream error: ${err.message}]`);
      cleanup();
    });
  } catch (err) {
    if (ws.readyState === WebSocket.OPEN) { ws.send(`[Error: ${err.message}]`); ws.close(); }
  }
});

const PORT = process.env.PORT || 25566;
server.listen(PORT, () => {
  console.log(`Minecraft UI on :${PORT} | Container: ${CONTAINER_NAME} | Data: ${DATA_DIR}`);
});
