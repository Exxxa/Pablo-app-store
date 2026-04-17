# Minecraft Java Server — Umbrel App

A Minecraft Java Edition server with a web-based control panel, packaged as an Umbrel community app.

## Features

- Full Minecraft Java server via `itzg/minecraft-server`
- Web UI with dark theme and four tabs:
  - **Server Control** — start / stop / restart + live status + connection address
  - **Settings** — edit `server.properties` fields with live toggles
  - **Whitelist** — add and remove players by name
  - **Console** — real-time log streaming over WebSocket
- Status polling every 5 seconds
- REST API for all server management operations

## Project Structure

```
sparkles-minecraft-java/
├── docker-compose.yml      # Two-service stack: minecraft + ui
├── umbrel-app.yml          # Umbrel app manifest
└── ui/
    ├── Dockerfile          # node:20-alpine image
    ├── package.json
    ├── server.js           # Express + WebSocket backend
    └── public/
        └── index.html      # Single-page frontend
```

## Installation (Umbrel Community App Store)

1. In your Umbrel dashboard, go to **App Store → Community App Stores**.
2. Add your community store URL (the repo containing this app).
3. Find **Minecraft Java Server** in the store and click **Install**.
4. The control panel opens on your Umbrel dashboard port (default `3000`).

## Manual / Development Setup

```bash
# Clone or copy this directory to your machine
cd sparkles-minecraft-java

# Set required env vars (Umbrel sets these automatically)
export APP_DATA_DIR=/path/to/data
export APP_PORT=3000

# Start both services
docker compose up --build
```

Open `http://localhost:3000` for the control panel.

## Port Forwarding (let friends join)

To allow external players to connect to your server:

1. Log in to your router admin panel (usually `192.168.1.1` or `192.168.0.1`).
2. Go to **Port Forwarding** (may be under "NAT", "Firewall", or "Advanced").
3. Create a new rule:
   - **Protocol:** TCP (or TCP+UDP)
   - **External port:** `25565`
   - **Internal IP:** your Umbrel device's local IP (find it in Umbrel Settings)
   - **Internal port:** `25565`
4. Save and apply.
5. Share your **public IP address** (or a dynamic DNS hostname) with players.
   They connect using `your.public.ip:25565`.

> **Tip:** Use a free Dynamic DNS service (e.g. DuckDNS, No-IP) if your ISP
> assigns a changing IP address.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `APP_DATA_DIR` | — | Path where Minecraft data (`server.properties`, worlds, etc.) is stored |
| `APP_PORT` | `3000` | External port for the web UI |
| `MINECRAFT_CONTAINER` | `sparkles-minecraft-java_minecraft_1` | Docker container name of the MC server |

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Container status |
| GET | `/api/settings` | Read server.properties fields |
| POST | `/api/settings` | Write server.properties fields |
| POST | `/api/server/start` | Start the container |
| POST | `/api/server/stop` | Stop the container |
| POST | `/api/server/restart` | Restart the container |
| GET | `/api/whitelist` | List whitelisted players |
| POST | `/api/whitelist/add` | Add a player `{ name }` |
| DELETE | `/api/whitelist/:name` | Remove a player |
| WS | `/logs` | Stream live Docker logs |
