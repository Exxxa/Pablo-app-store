const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/logs' });
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const CONTAINER_NAME = process.env.MINECRAFT_CONTAINER || 'sparkles-minecraft-server_minecraft_1';
const DATA_DIR = process.env.DATA_DIR || '/minecraft-data';
const SERVER_PROPERTIES = path.join(DATA_DIR, 'server.properties');
const WHITELIST_FILE = path.join(DATA_DIR, 'whitelist.json');
const MC_SETTINGS_FILE = path.join(DATA_DIR, 'mc-settings.json');
const GAMERULES_FILE = path.join(DATA_DIR, 'mc-gamerules.json');
const BANS_FILE = path.join(DATA_DIR, 'banned-players.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'mc-schedule.json');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const RCON_PASSWORD = process.env.RCON_PASSWORD || 'sparkles_mc_rcon';

const DEFAULT_MC_SETTINGS = {
  TYPE: 'VANILLA',
  VERSION: 'LATEST',
  MEMORY: '1G',
  LEVEL: 'world',
  USE_AIKAR_FLAGS: 'false',
  MODRINTH_MODPACK: '',
  MODRINTH_LOADER: '',
  ENABLE_RCON: 'true',
  RCON_PASSWORD: RCON_PASSWORD,
};

const GAMERULE_DEFAULTS = { keepInventory: false };

const BASE_ENV = { EULA: 'TRUE' };

const upload = multer({
  dest: path.join(os.tmpdir(), 'mc-uploads'),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    file.originalname.toLowerCase().endsWith('.zip')
      ? cb(null, true)
      : cb(new Error('Only .zip files are accepted'));
  },
});

const modUpload = multer({
  dest: path.join(os.tmpdir(), 'mc-uploads'),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    file.originalname.toLowerCase().endsWith('.jar')
      ? cb(null, true)
      : cb(new Error('Only .jar files are accepted'));
  },
});

function getModDir(type) {
  if (type === 'PAPER' || type === 'PURPUR') return path.join(DATA_DIR, 'plugins');
  return path.join(DATA_DIR, 'mods');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function getContainer() {
  const containers = await docker.listContainers({ all: true });
  const info = containers.find(c => c.Names.some(n => n.replace(/^\//, '') === CONTAINER_NAME));
  if (!info) throw new Error(`Container "${CONTAINER_NAME}" not found`);
  return docker.getContainer(info.Id);
}

function getMojangProfile(playerName) {
  return new Promise((resolve) => {
    const req = https.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(playerName)}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const raw = json.id;
            const uuid = `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
            resolve({ uuid, name: json.name });
          } catch { resolve(null); }
        } else { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

async function sendRconCommand(command) {
  const container = await getContainer();
  const exec = await container.exec({
    Cmd: ['rcon-cli', '--host', 'localhost', '--port', '25575', '--password', RCON_PASSWORD, command],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve) => {
    let output = '';
    stream.on('data', chunk => output += chunk.toString());
    stream.on('end', () => resolve(output.trim()));
    stream.on('error', () => resolve(''));
  });
}

function readGamerules() {
  if (!fs.existsSync(GAMERULES_FILE)) return { ...GAMERULE_DEFAULTS };
  try { return { ...GAMERULE_DEFAULTS, ...JSON.parse(fs.readFileSync(GAMERULES_FILE, 'utf8')) }; }
  catch { return { ...GAMERULE_DEFAULTS }; }
}

function getDirSizeBytes(dirPath) {
  let size = 0;
  try {
    for (const item of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, item.name);
      size += item.isDirectory() ? getDirSizeBytes(full) : fs.statSync(full).size;
    }
  } catch { }
  return size;
}

function getSchedule() {
  if (!fs.existsSync(SCHEDULE_FILE)) return { enabled: false, hour: 4, minute: 0 };
  try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); }
  catch { return { enabled: false, hour: 4, minute: 0 }; }
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
      restartCount: info.RestartCount || 0,
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
      .map(e => {
        const bytes = getDirSizeBytes(path.join(DATA_DIR, e.name));
        const sizeMB = bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB`
          : bytes < 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
          : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
        return { name: e.name, sizeMB };
      });
    const active = readMcSettings().LEVEL || 'world';
    res.json({ worlds, active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/worlds/:name', (req, res) => {
  try {
    const { name } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'Invalid world name' });
    const active = readMcSettings().LEVEL || 'world';
    if (name === active) return res.status(400).json({ error: 'Cannot delete the active world' });
    const worldPath = path.join(DATA_DIR, name);
    if (!fs.existsSync(worldPath)) return res.status(404).json({ error: 'World not found' });
    fs.rmSync(worldPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload a world zip
app.post('/api/worlds/upload', upload.single('world'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const tmpPath = req.file.path;
  try {
    const zip = new AdmZip(tmpPath);
    const entries = zip.getEntries();

    const levelEntry = entries.find(e => !e.isDirectory && e.entryName.replace(/\\/g, '/').endsWith('level.dat'));
    if (!levelEntry) {
      fs.unlinkSync(tmpPath);
      return res.status(400).json({ error: 'Not a valid Minecraft world — no level.dat found in zip' });
    }

    const parts = levelEntry.entryName.replace(/\\/g, '/').split('/');
    const hasSubfolder = parts.length > 1;
    const extractRoot = hasSubfolder ? parts[0] + '/' : '';
    const baseName = hasSubfolder
      ? parts[0]
      : req.file.originalname.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'world';

    let finalName = baseName;
    if (fs.existsSync(path.join(DATA_DIR, finalName))) {
      finalName = baseName + '_' + Date.now();
    }
    const finalPath = path.join(DATA_DIR, finalName);
    fs.mkdirSync(finalPath, { recursive: true });

    entries.forEach(entry => {
      if (entry.isDirectory) return;
      const entryName = entry.entryName.replace(/\\/g, '/');
      const relPath = extractRoot ? entryName.slice(extractRoot.length) : entryName;
      if (!relPath) return;
      const dest = path.join(finalPath, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    });

    fs.unlinkSync(tmpPath);
    res.json({ success: true, worldName: finalName });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// Rename a world folder
app.post('/api/worlds/rename', (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: 'Missing oldName or newName' });
    if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
      return res.status(400).json({ error: 'World name may only contain letters, numbers, _ and -' });
    }
    const oldPath = path.join(DATA_DIR, oldName);
    const newPath = path.join(DATA_DIR, newName);
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'World not found' });
    if (fs.existsSync(newPath)) return res.status(409).json({ error: 'A world with that name already exists' });

    fs.renameSync(oldPath, newPath);

    const settings = readMcSettings();
    const wasActive = settings.LEVEL === oldName;
    if (wasActive) {
      settings.LEVEL = newName;
      writeMcSettings(settings);
    }
    res.json({ success: true, wasActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export (download) a world as a zip
app.get('/api/worlds/:name/export', (req, res) => {
  try {
    const { name } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'Invalid world name' });
    const worldPath = path.join(DATA_DIR, name);
    if (!fs.existsSync(worldPath)) return res.status(404).json({ error: 'World not found' });

    const zip = new AdmZip();
    zip.addLocalFolder(worldPath, name);
    const buffer = zip.toBuffer();

    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Mods / Plugins ─────────────────────────────────────────────────────────
app.get('/api/mods', (_req, res) => {
  try {
    const settings = readMcSettings();
    const dir = getModDir(settings.TYPE);
    const folder = path.basename(dir);
    if (!fs.existsSync(dir)) return res.json({ mods: [], folder });
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.jar'));
    res.json({ mods: files.sort(), folder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mods/upload', modUpload.single('mod'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const tmpPath = req.file.path;
  try {
    const settings = readMcSettings();
    const dir = getModDir(settings.TYPE);
    fs.mkdirSync(dir, { recursive: true });
    const filename = req.file.originalname.replace(/[^a-zA-Z0-9._\-() ]/g, '_');
    const dest = path.join(dir, filename);
    fs.copyFileSync(tmpPath, dest);
    fs.unlinkSync(tmpPath);
    res.json({ success: true, filename });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/mods/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename.toLowerCase().endsWith('.jar') || filename.includes('/') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const settings = readMcSettings();
    const dir = getModDir(settings.TYPE);
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    fs.unlinkSync(filePath);
    res.json({ success: true });
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

app.post('/api/whitelist/add', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid player name' });
    }
    let whitelist = [];
    if (fs.existsSync(WHITELIST_FILE)) whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    if (!whitelist.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      const profile = await getMojangProfile(name);
      whitelist.push({ uuid: profile ? profile.uuid : '', name: profile ? profile.name : name });
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

// ── Game Rules ────────────────────────────────────────────────────────────
app.get('/api/gamerules', (_req, res) => {
  res.json(readGamerules());
});

app.post('/api/gamerules', async (req, res) => {
  try {
    const allowed = ['keepInventory'];
    const current = readGamerules();
    const updates = {};
    allowed.forEach(k => {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        updates[k] = Boolean(req.body[k]);
      }
    });
    const newRules = { ...current, ...updates };
    fs.writeFileSync(GAMERULES_FILE, JSON.stringify(newRules, null, 2));

    let rconOk = false;
    try {
      for (const [rule, value] of Object.entries(updates)) {
        await sendRconCommand(`gamerule ${rule} ${value}`);
      }
      rconOk = true;
    } catch (_) {}

    res.json({ success: true, rconOk });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RCON command ──────────────────────────────────────────────────────────
app.post('/api/rcon', async (req, res) => {
  try {
    const { command } = req.body;
    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      return res.status(400).json({ error: 'command is required' });
    }
    const output = await sendRconCommand(command.trim());
    res.json({ success: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Live player list ───────────────────────────────────────────────────────
app.get('/api/players', async (_req, res) => {
  try {
    const raw = await sendRconCommand('list');
    // "There are 2 of a max of 20 players online: Player1, Player2"
    const match = raw.match(/There are (\d+) of a max of (\d+) players online:?(.*)/i);
    if (match) {
      const players = match[3].split(',').map(s => s.trim()).filter(Boolean);
      res.json({ online: parseInt(match[1], 10), max: parseInt(match[2], 10), players });
    } else {
      res.json({ online: 0, max: 0, players: [] });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Ops management ────────────────────────────────────────────────────────
const OPS_FILE = path.join(DATA_DIR, 'ops.json');

app.get('/api/ops', (_req, res) => {
  try {
    if (!fs.existsSync(OPS_FILE)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(OPS_FILE, 'utf8')));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ops/add', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid player name' });
    }
    let ops = [];
    if (fs.existsSync(OPS_FILE)) ops = JSON.parse(fs.readFileSync(OPS_FILE, 'utf8'));
    if (!ops.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      const profile = await getMojangProfile(name);
      ops.push({ uuid: profile ? profile.uuid : '', name: profile ? profile.name : name, level: 4, bypassesPlayerLimit: false });
      fs.writeFileSync(OPS_FILE, JSON.stringify(ops, null, 2));
    }
    try { await sendRconCommand(`op ${name}`); } catch (_) {}
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/ops/:name', async (req, res) => {
  try {
    const { name } = req.params;
    let ops = [];
    if (fs.existsSync(OPS_FILE)) ops = JSON.parse(fs.readFileSync(OPS_FILE, 'utf8'));
    ops = ops.filter(p => p.name !== name);
    fs.writeFileSync(OPS_FILE, JSON.stringify(ops, null, 2));
    try { await sendRconCommand(`deop ${name}`); } catch (_) {}
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Container stats (CPU / RAM) ────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const container = await getContainer();
    const stats = await container.stats({ stream: false });
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    const cpuPercent = systemDelta > 0 ? parseFloat(((cpuDelta / systemDelta) * cpuCount * 100).toFixed(1)) : 0;
    const memUsedMB = Math.round(stats.memory_stats.usage / 1024 / 1024);
    const memLimitMB = Math.round(stats.memory_stats.limit / 1024 / 1024);
    res.json({ cpuPercent, memUsedMB, memLimitMB });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Bans ──────────────────────────────────────────────────────────────────
app.get('/api/bans', (_req, res) => {
  try {
    if (!fs.existsSync(BANS_FILE)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(BANS_FILE, 'utf8')));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bans/add', async (req, res) => {
  try {
    const { name, reason } = req.body;
    if (!name || typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid player name' });
    }
    let bans = [];
    if (fs.existsSync(BANS_FILE)) bans = JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'));
    if (!bans.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      const profile = await getMojangProfile(name);
      bans.push({
        uuid: profile ? profile.uuid : '',
        name: profile ? profile.name : name,
        source: 'Minecraft UI',
        expires: 'forever',
        reason: reason || 'Banned by an operator.',
        created: new Date().toISOString(),
      });
      fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2));
    }
    try { await sendRconCommand(`ban ${name}${reason ? ' ' + reason : ''}`); } catch (_) {}
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bans/:name', async (req, res) => {
  try {
    const { name } = req.params;
    let bans = [];
    if (fs.existsSync(BANS_FILE)) bans = JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'));
    bans = bans.filter(p => p.name !== name);
    fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2));
    try { await sendRconCommand(`pardon ${name}`); } catch (_) {}
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── World backups ─────────────────────────────────────────────────────────
app.get('/api/backups', (_req, res) => {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return res.json([]);
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.zip'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f));
        return { name: f, sizeMB: (stat.size / 1024 / 1024).toFixed(1), created: stat.birthtime };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/worlds/:name/backup', (req, res) => {
  try {
    const { name } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'Invalid world name' });
    const worldPath = path.join(DATA_DIR, name);
    if (!fs.existsSync(worldPath)) return res.status(404).json({ error: 'World not found' });
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `${name}_${ts}.zip`;
    const zip = new AdmZip();
    zip.addLocalFolder(worldPath, name);
    zip.writeZip(path.join(BACKUPS_DIR, backupName));
    res.json({ success: true, backupName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/backups/:filename/restore', (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename.endsWith('.zip') || filename.includes('/') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const backupPath = path.join(BACKUPS_DIR, filename);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });
    const zip = new AdmZip(backupPath);
    const entries = zip.getEntries();
    const topDir = entries.length ? entries[0].entryName.split('/')[0] : null;
    if (!topDir) return res.status(400).json({ error: 'Empty backup' });
    const destPath = path.join(DATA_DIR, topDir);
    if (fs.existsSync(destPath)) fs.rmSync(destPath, { recursive: true, force: true });
    zip.extractAllTo(DATA_DIR, true);
    res.json({ success: true, worldName: topDir });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/backups/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename.endsWith('.zip') || filename.includes('/') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const backupPath = path.join(BACKUPS_DIR, filename);
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/backups/:filename/download', (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename.endsWith('.zip') || filename.includes('/') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const backupPath = path.join(BACKUPS_DIR, filename);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Not found' });
    res.download(backupPath, filename);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Scheduled restart ─────────────────────────────────────────────────────
let scheduledRestartInProgress = false;

app.get('/api/schedule', (_req, res) => res.json(getSchedule()));

app.post('/api/schedule', (req, res) => {
  try {
    const { enabled, hour, minute } = req.body;
    const sched = {
      enabled: Boolean(enabled),
      hour: Math.max(0, Math.min(23, parseInt(hour, 10) || 4)),
      minute: Math.max(0, Math.min(59, parseInt(minute, 10) || 0)),
    };
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(sched, null, 2));
    res.json({ success: true, schedule: sched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function runScheduledRestart() {
  if (scheduledRestartInProgress) return;
  scheduledRestartInProgress = true;
  try {
    const warnings = [
      [0,            'say [Auto-restart] Server will restart in 5 minutes.'],
      [4 * 60000,    'say [Auto-restart] Server will restart in 1 minute.'],
      [30000,        'say [Auto-restart] Server restarting in 30 seconds!'],
      [30000,        null],
    ];
    for (const [delay, cmd] of warnings) {
      await new Promise(r => setTimeout(r, delay));
      if (cmd) try { await sendRconCommand(cmd); } catch (_) {}
    }
    const container = await getContainer();
    await container.restart();
  } catch (err) { console.error('Scheduled restart failed:', err.message); }
  finally { scheduledRestartInProgress = false; }
}

setInterval(() => {
  const sched = getSchedule();
  if (!sched.enabled) return;
  const now = new Date();
  if (now.getHours() === sched.hour && now.getMinutes() === sched.minute) {
    runScheduledRestart();
  }
}, 60 * 1000);

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
