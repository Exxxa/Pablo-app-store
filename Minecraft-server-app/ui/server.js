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

const CONTAINER_NAME = process.env.MINECRAFT_CONTAINER || 'Minecraft-server-app_minecraft_1';
const DATA_DIR = process.env.DATA_DIR || '/minecraft-data';
const SERVER_PROPERTIES = path.join(DATA_DIR, 'server.properties');
const WHITELIST_FILE = path.join(DATA_DIR, 'whitelist.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function getContainer() {
  const containers = await docker.listContainers({ all: true });
  const info = containers.find(c => c.Names.some(n => n.replace(/^\//, '') === CONTAINER_NAME));
  if (!info) throw new Error(`Container "${CONTAINER_NAME}" not found`);
  return docker.getContainer(info.Id);
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
  'server-name', 'motd', 'gamemode', 'difficulty',
  'max-players', 'white-list', 'online-mode', 'pvp',
];

// GET /api/status
app.get('/api/status', async (_req, res) => {
  try {
    const container = await getContainer();
    const info = await container.inspect();
    res.json({
      status: info.State.Status,
      running: info.State.Running,
      startedAt: info.State.StartedAt,
    });
  } catch (err) {
    res.json({ status: 'not_found', running: false, error: err.message });
  }
});

// GET /api/settings
app.get('/api/settings', (_req, res) => {
  try {
    const props = readServerProperties();
    const defaults = {
      'server-name': 'Minecraft Server',
      'motd': 'A Minecraft Server',
      'gamemode': 'survival',
      'difficulty': 'easy',
      'max-players': '20',
      'white-list': 'false',
      'online-mode': 'true',
      'pvp': 'true',
    };
    const result = {};
    SETTINGS_KEYS.forEach(k => { result[k] = props[k] !== undefined ? props[k] : defaults[k]; });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings
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

// POST /api/server/start
app.post('/api/server/start', async (_req, res) => {
  try {
    const container = await getContainer();
    await container.start();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/server/stop
app.post('/api/server/stop', async (_req, res) => {
  try {
    const container = await getContainer();
    await container.stop();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/server/restart
app.post('/api/server/restart', async (_req, res) => {
  try {
    const container = await getContainer();
    await container.restart();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/whitelist
app.get('/api/whitelist', (_req, res) => {
  try {
    if (!fs.existsSync(WHITELIST_FILE)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/whitelist/add
app.post('/api/whitelist/add', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid player name' });
    }
    let whitelist = [];
    if (fs.existsSync(WHITELIST_FILE)) {
      whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    }
    if (!whitelist.find(p => p.name === name)) {
      whitelist.push({ uuid: '', name });
      fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2));
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/whitelist/:name
app.delete('/api/whitelist/:name', (req, res) => {
  try {
    const { name } = req.params;
    let whitelist = [];
    if (fs.existsSync(WHITELIST_FILE)) {
      whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    }
    whitelist = whitelist.filter(p => p.name !== name);
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket /logs — stream Docker logs, stripping 8-byte multiplex header
wss.on('connection', async (ws) => {
  let logStream = null;
  let closed = false;

  const cleanup = () => {
    closed = true;
    if (logStream) {
      try { logStream.destroy(); } catch (_) {}
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  try {
    const container = await getContainer();
    logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 200,
    });

    let buffer = Buffer.alloc(0);

    logStream.on('data', (chunk) => {
      if (closed) return;
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 8) {
        const size = buffer.readUInt32BE(4);
        if (buffer.length < 8 + size) break;
        const line = buffer.subarray(8, 8 + size).toString('utf8');
        buffer = buffer.subarray(8 + size);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(line);
        }
      }
    });

    logStream.on('end', () => {
      if (!closed && ws.readyState === WebSocket.OPEN) {
        ws.send('[Log stream ended — container stopped]');
      }
      cleanup();
    });

    logStream.on('error', (err) => {
      if (!closed && ws.readyState === WebSocket.OPEN) {
        ws.send(`[Stream error: ${err.message}]`);
      }
      cleanup();
    });

  } catch (err) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`[Error connecting to container: ${err.message}]`);
      ws.close();
    }
  }
});

const PORT = process.env.PORT || 25566;
server.listen(PORT, () => {
  console.log(`Minecraft UI listening on port ${PORT}`);
  console.log(`Container: ${CONTAINER_NAME}`);
  console.log(`Data dir:  ${DATA_DIR}`);
});
