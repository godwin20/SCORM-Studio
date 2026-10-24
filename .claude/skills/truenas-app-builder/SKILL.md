---
name: "truenas-app-builder"
description: "Use when Keith wants a self-hosted web app or service packaged to run on his TrueNAS (25.04+) as a custom app installed via YAML, or wants one fixed or updated."
---

# Build a TrueNAS custom app

Package a small web app or service so it installs on TrueNAS Community Edition 25.04+ through **Apps > Discover Apps > ⋮ > Install via YAML**, with no image to build or publish. Proven on SCORM Studio (Node server + HTML page, port 8787, behind Cloudflare Tunnel).

Keith wants complete, ready-to-use files (never "find this line" snippets) and plain English.

## The pattern

- **No custom image.** Use an official runtime image (`node:22-alpine`, `python:3.12-alpine`, `nginx:alpine`) and mount the app's files from a TrueNAS dataset. TrueNAS custom apps cannot `build:` from a Dockerfile.
- **Files live in a dataset** made with the **Apps** preset, mounted read-only, e.g. `/mnt/YOUR-POOL/apps/<app-name>:/app:ro`. The app's files sit directly in the dataset, never in a subfolder.
- **Run as the TrueNAS apps user**: `user: "568:568"`.
- **Locked down**: `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, log rotation (`max-size: 5m`, `max-file: 3`).
- **Health check** hits an endpoint that needs no password or code (e.g. `/ping`) using `wget` (present in alpine images).
- **Secrets** (API keys, access codes) go in the YAML `environment:` block, clearly marked `# <-- CHANGE`. Never put a secret in a file people will share.
- **One app serves everything**: if there is a web page, the server hosts it at `/` so users just open a web address. Re-read the page file when it changes so updates need no restart.
- **Also answer**: `HEAD` requests, `/favicon.ico` (204 or a real icon), and CORS preflight if browsers call it from elsewhere.
- **Graceful stop**: handle SIGTERM.

## Steps

1. **Agree the shape**: what runs (server, static site, worker), the port, which settings are secrets, what limits protect any paid API (per-person and per-day caps, a spend cap on the provider side).
2. **Write the app** with only the runtime's built-in libraries where possible (no `npm install` / `pip install` step at start-up). Settings come from environment variables; refuse to start with a clear message if a required one is missing or too weak.
3. **Write `truenas-app.yaml`** from the template below.
4. **Test it locally before shipping**: syntax check, run it from a folder the way the container will, hit every route with curl (good/bad codes, limits, CORS), and click through any web page in headless Chromium (Playwright at `/opt/npm-tools/node_modules/playwright`). Check the YAML parses.
5. **Write `SETUP.md`** in plain English: API key with spend limit (if any), dataset, copying files in, permissions, install via YAML, https via Cloudflared, first use, everyday running, troubleshooting table.
6. **Deliver one zip**: `<app>-truenas/` containing `app/` (the files for the dataset), `truenas-app.yaml`, `SETUP.md`. Offer to turn SETUP.md into a doc he can keep.

## YAML template

```yaml
services:
  <app-name>:
    image: node:22-alpine
    restart: unless-stopped
    user: "568:568"
    working_dir: /app
    command: ["node", "server.js"]
    environment:
      SOME_SECRET: "change-me"          # <-- CHANGE
      PORT: "8787"
      TZ: "Europe/London"
    ports:
      - "8787:8787"                     # <-- CHANGE the first number if taken
    volumes:
      - /mnt/YOUR-POOL/apps/<app-name>:/app:ro   # <-- CHANGE
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8787/ping"]
      interval: 60s
      timeout: 5s
      retries: 3
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"
```

If the app must write data, mount a second dataset read-write (e.g. `/mnt/YOUR-POOL/apps/<app-name>-data:/data`) and keep `read_only: true` for the rest.

## Gotchas already hit (put these in SETUP.md)

| Problem | Cause | Fix |
| --- | --- | --- |
| `String should match pattern '^[a-z]([-a-z0-9]*[a-z0-9])?$'` on install | App **Name** box has capitals, spaces or underscores | Lowercase letters, numbers, hyphens only; not starting or ending with a hyphen |
| Jobs show app.start SUCCESS but "No containers are available" | Container is crash-looping | Shell: `sudo docker ps -a --filter name=<app>` then `sudo docker logs --tail 30 ix-<app>-<app>-1` |
| `EACCES: permission denied` on the app files | Files copied in via SFTP/SMB are owned by `truenas_admin`, unreadable by 568 | `sudo chown -R 568:568 <dataset>`, `sudo chmod 755 <dataset>`, `sudo chmod 644 <dataset>/*` |
| Permission error returns after an update | Each copy resets the owner | Re-run the chown/chmod after every file copy |
| `Cannot find module` / file not found | Files copied inside a subfolder (e.g. `app/` from the zip) | Move them straight into the dataset |
| `bind source path does not exist` | Wrong dataset path in YAML | Copy the exact path from Datasets (case-sensitive) |
| A secret or code silently doesn't match | `$` in YAML values is treated as a Compose variable | Avoid `$` (or write `$$`); also avoid `"` and `\`; avoid `£`/accents/emoji in anything sent as an HTTP header |
| `pull access denied` or timeout | TrueNAS can't reach Docker Hub | Check gateway and DNS in Network > Global Configuration |
| Log times look wrong | TrueNAS time zone not UK | System > General Settings > Localization |

The container name for a custom app is `ix-<app-name>-<service-name>-1`. Handy one-liner that needs no path typing:

```bash
P=$(sudo docker inspect -f '{{range .Mounts}}{{.Source}}{{end}}' ix-<app>-<app>-1)
sudo chown 568:568 "$P"/* && sudo chmod 644 "$P"/*
```

(For apps with more than one mount, pick the mount by destination instead.)

## Updating an installed app

| What changed | What to do |
| --- | --- |
| A page/file the server re-reads | Replace the file, fix permissions, no restart |
| Server code | Replace the file, fix permissions, Apps > <app> > Restart |
| Secrets, limits, port | Apps > <app> > Edit, change YAML, Save |

Keep file names identical (rename browser downloads like `file (1).html`). When sending Keith updates, send complete replacement files with the same names.

## Reaching it from outside (https)

Recommend the **Cloudflared** app from the TrueNAS catalog: create a tunnel in Cloudflare Zero Trust, paste the token into the app, add a public hostname pointing to `HTTP TRUENAS-IP:<port>`. Optionally add a Cloudflare Access policy to restrict who can open it. After it's live, test the public address in headless Chromium (curl first to confirm it's reachable).

## Security defaults

- Paid-API proxies: access code checked with a constant-time compare, lockout after repeated wrong codes, per-IP hourly limit, global daily limit, request size cap, and the server builds the prompt itself so it can't be used as a general chat.
- Logs record times, counts and token use, never user content.
- Real client IP comes from `cf-connecting-ip` / `x-forwarded-for` behind the tunnel.