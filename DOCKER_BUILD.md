# Docker Build Notes

This file is gitignored — it lives locally only.
It documents the steps to build and publish the UI Docker image when you update the app.

---

## When to do this

Run these steps whenever you change anything inside `minecraft-server-ui/`
(server.js, index.html, package.json, Dockerfile, etc.).
You do NOT need to redo this just to update umbrel-app.yml or docker-compose.yml.

---

## Steps

### 1. Make sure Docker Desktop is running

Open Docker Desktop and wait for it to show "Engine running".

### 2. Log in to Docker Hub (first time only, or after logout)

```bash
docker login
```

Enter your Docker Hub username (`exxxa`) and your password when prompted.

### 3. Build the image

Easiest: run the bundled script from the `minecraft-server-ui/` folder, which
builds **and** pushes in one go (skip step 4 if you use it):

```powershell
.\scripts\build-push.ps1            # build + push :latest
.\scripts\build-push.ps1 -NoPush    # build only
```

Or build manually from the `minecraft-server-ui/` folder:

```bash
docker build -t exxxa/sparkles-minecraft-server-ui:latest .
```

Always push to `:latest` — you never need to change the tag or touch docker-compose.yml again.

### 4. Push the image to Docker Hub

```bash
docker push exxxa/sparkles-minecraft-server-ui:latest
```

### 5. Bump the version in umbrel-app.yml

Open `sparkles-minecraft-server/umbrel-app.yml` and increment the version number:

```yaml
version: "1.0.1"   # was 1.0.0 — change this each time you release an update
```

This is the only thing that tells Umbrel "there is an update available".
Without this change, Umbrel users won't see an update prompt.

### 6. Commit and push to GitHub

```bash
git add sparkles-minecraft-server/umbrel-app.yml
git commit -m "Release 1.0.1 — describe what changed"
git push
```

### 7. Update on Umbrel

- Umbrel will show an "Update available" badge on the app
- The user clicks Update — Umbrel pulls the new `:latest` image and restarts
- No need to remove/re-add the store for updates (only needed for first install)

---

## What Umbrel actually needs from this repo

Only these files are downloaded by Umbrel — everything else can stay local:

| File | Purpose |
|------|---------|
| `umbrel-app-store.yml` | Identifies your store |
| `sparkles-minecraft-server/umbrel-app.yml` | App metadata (name, icon, description) |
| `sparkles-minecraft-server/docker-compose.yml` | Defines which Docker images to run |
| `sparkles-minecraft-server/icon.jpg` | App icon |
| `sparkles-minecraft-server/Minecraft_background_*.jpg` | Gallery images |

The `minecraft-server-ui/` source folder builds the UI image separately (see above)
and is not part of what Umbrel downloads from the store.
