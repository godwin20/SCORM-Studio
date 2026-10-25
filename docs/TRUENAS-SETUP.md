# SCORM Studio on TrueNAS

SCORM Studio runs as a custom app on TrueNAS Community Edition 25.04 and is reached in any browser,
on Windows or Mac, with nothing to install. The same app writes quiz questions with your Claude API
key, which stays on the server.

- **Web address:** https://scorm-studio.g-security.uk/ (through the Cloudflared app)
- **Access code:** colleagues type it once to use question writing. Anyone with the address can build courses.
- **Limits:** 20 question requests per person per hour, 100 per day in total, plus the spend limit on your Claude workspace.

The app is two files in a TrueNAS dataset, `server.js` and `scorm-studio.html`, run by the official
`node:22-alpine` image as the TrueNAS apps user (568) with read-only access to the folder.
After `npm run build`, both files are in `deploy/truenas/app/`. A second, small, **writable** dataset
holds the auto-updated copy of `scorm-studio.html` (see **Auto-update** below) - everything else about
the app stays read-only.

---

## First-time setup

1. **API key with a spending cap**
    - Sign in at https://platform.claude.com and add credit under Billing.
    - Create a Workspace (for example "SCORM Studio") and set a monthly spend limit on it.
    - Create an API key inside that workspace and keep it safe.
2. **Two datasets**
    - Datasets > Add Dataset, name it `scorm-studio`, Dataset Preset **Apps**. This one holds
      `server.js` and the baseline `scorm-studio.html`, and stays read-only to the app.
    - Datasets > Add Dataset again, name it `scorm-studio-live`, Dataset Preset **Apps**. This one
      starts empty - the app writes its auto-updated copy of the page into it.
    - Note both paths, for example `/mnt/tank/apps/scorm-studio` and `/mnt/tank/apps/scorm-studio-live`.
3. **Copy the two files into the first dataset**, straight in (not inside an `app` subfolder).
   Use WinSCP or Cyberduck over SFTP (turn on SSH in System > Services), or a temporary SMB share.
   Leave the second dataset empty - the app fills it in on first start.
4. **Fix permissions on both datasets** so the apps user can read and write them (System > Shell):
   ```bash
   sudo chown -R 568:568 /mnt/YOUR-POOL/apps/scorm-studio /mnt/YOUR-POOL/apps/scorm-studio-live
   sudo chmod 755 /mnt/YOUR-POOL/apps/scorm-studio /mnt/YOUR-POOL/apps/scorm-studio-live
   sudo chmod 644 /mnt/YOUR-POOL/apps/scorm-studio/*
   ```
5. **Install the app**
    - Edit the 5 marked lines in `deploy/truenas/truenas-app.yaml`: API key, access code,
      port (only if 8787 is taken), and both dataset paths.
    - Apps > Discover Apps > ⋮ > **Install via YAML**.
    - Name it exactly `scorm-studio` (lowercase letters, numbers and hyphens only).
    - Paste the YAML and Save. Check it at `http://TRUENAS-IP:8787`.
6. **Reach it from work over https**
    - Cloudflare Zero Trust > Networks > Tunnels: create a tunnel, copy its token.
    - Install the **Cloudflared** app from the TrueNAS catalog with that token.
    - Add a public hostname (for example `scorm-studio.yourdomain`) pointing to `HTTP` `TRUENAS-IP:8787`.
    - Optional: a Cloudflare Access policy so only work email addresses can open it.

Then open the site, go to **Quiz**, press **Generate questions**, enter the access code, press **Test**
(it should say Connected), then **Save**.

## Access code

Choose it yourself on the `ACCESS_CODE` line. At least 8 characters; three or four random words work
well (`Lantern-Copper-Harbour-42`). Random option: `openssl rand -base64 12` in System > Shell.

| Characters | Use? | Why |
| --- | --- | --- |
| Letters, numbers, spaces, `-` `_` `.` `!` `@` `#` `%` | Yes | All work |
| `"` and `\` | No | Break the YAML line |
| `$` | No | TrueNAS treats it as a marker and changes the code |
| `£`, accented letters, emoji | No | Browsers can't send them, so the code is always rejected |

To change it: Apps > scorm-studio > Edit, change the line, Save. Change it when someone leaves.

## Auto-update

With `AUTO_UPDATE: "1"` (the default in the YAML), the app checks the project's
**[Releases page](https://github.com/godwin20/SCORM-Studio/releases)** itself, once an hour
(`UPDATE_INTERVAL_MIN`), and once shortly after it starts. When a newer release has
`scorm-studio.html` attached, it downloads it, checks the file is a believable size and really is
SCORM Studio, checks its contents match the sha256 digest GitHub itself reports for it, keeps one
backup of what was there before, then writes it into the writable `scorm-studio-live` dataset. The
page is live on the **next refresh - no restart, nothing to copy in by hand.** A release is cut by
pushing a tag like `v1.2.1` (or via the repo's Release workflow), so pushing ordinary commits to
`main` never reaches colleagues on its own - only a tagged release does.

Check it worked: `GET /health` with the access code shows `liveVersion` (the applied tag); the app's
logs (Apps > scorm-studio > Workloads > logs icon) show a line starting `update-check` each time it
runs, ending `applied vX.Y.Z` on success. If a check fails for any reason - no internet, GitHub down,
a corrupted download - it logs why and simply leaves whatever's currently live in place; nothing
ever goes offline waiting for an update.

**`server.js` is never auto-updated** - a change there always needs the manual step below, since it
holds the access-code check and rate limits and shouldn't apply itself from the internet unreviewed.

To turn auto-update off, Apps > scorm-studio > Edit, set `AUTO_UPDATE` to `"0"`, Save, and go back to
updating `scorm-studio.html` by hand (below). Switching it back on later picks up from wherever the
`scorm-studio-live` dataset was left.

## Updating by hand

Get the files from the **[Releases page](https://github.com/godwin20/SCORM-Studio/releases)** (each
tagged version has `scorm-studio.html` and `server.js` attached, ready to download) instead of
waiting for them to be sent.

| What changed | What to do |
| --- | --- |
| `scorm-studio.html`, auto-update off | Replace the file in the `scorm-studio` dataset. No restart; it loads on the next page refresh |
| `scorm-studio.html`, auto-update on | Nothing to do - it updates itself within the hour. To force it sooner, Apps > scorm-studio > Restart |
| `server.js` | Replace the file in the `scorm-studio` dataset, then Apps > scorm-studio > Restart (always manual, auto-update or not) |
| API key, access code, limits, port, `AUTO_UPDATE` | Apps > scorm-studio > Edit, change the YAML, Save |

Copied files are owned by your account again, which brings back the `EACCES` error. After every copy:

```bash
P=$(sudo docker inspect -f '{{range .Mounts}}{{.Source}}{{end}}' ix-scorm-studio-scorm-studio-1)
sudo chown 568:568 "$P"/* && sudo chmod 644 "$P"/*
```

Keep the names exactly `server.js` and `scorm-studio.html` (rename `scorm-studio (1).html` downloads).

## Troubleshooting

Where to look:
- **App screen shows containers:** Apps > scorm-studio > Workloads > logs icon > Connect.
- **"No containers are available":** it may be crash-looping. Check from the shell (below).
- **Install or update failed:** the Jobs icon in the top bar shows the failed job and its error.

```bash
sudo docker ps -a --filter name=scorm
sudo docker logs --tail 30 ix-scorm-studio-scorm-studio-1
```

`Restarting (1)` means the server starts and stops straight away; the log says why.

| Message | Cause | Fix |
| --- | --- | --- |
| `String should match pattern '^[a-z]...'` | App name has capitals, spaces or underscores | Name it `scorm-studio` |
| `EACCES: permission denied, open '/app/server.js'` | Apps user can't read the files | Run the chown/chmod lines above |
| `bind source path does not exist` | Dataset path in the YAML is wrong | Copy the exact path from Datasets (case-sensitive) |
| `Cannot find module '/app/server.js'` | Files are in a subfolder | Move both files straight into the dataset |
| `Missing settings` | API key or access code line empty | Fill both in via Edit |
| `ACCESS_CODE is too short` | Under 8 characters | Use a longer code |
| `address already in use` | Port 8787 taken | Change the first number, e.g. `8788:8787` |
| `pull access denied` or timeout | TrueNAS can't download the Node image | Check gateway and DNS in Network > Global Configuration |
| "scorm-studio.html was not found" | HTML missing or misnamed | Copy it in with the exact name |
| "Could not reach the quiz server" | Tunnel down or app stopped | Check Cloudflared and that the app is Running |
| "The API key was not accepted" | Key mistyped or deleted | Check it in the Claude Console and the YAML |
| "run out of credit" | Balance or spend limit reached | Top up, or raise the workspace limit |
| `bind source path does not exist` on the second volume | `scorm-studio-live` dataset not created yet | Create it (First-time setup, step 2) |
| `/health` never shows a `liveVersion` | Either auto-update is off, or the first check hasn't run / succeeded yet | Check `AUTO_UPDATE` is `"1"`; check the logs for an `update-check` line and what it says |
| `update-check` logs `digest did not match` | A download got corrupted in transit (rare) | Harmless - it's refused automatically and retried next hour. Only chase it if it keeps happening |

If log times look wrong, set the time zone in System > General Settings > Localization.

## Quick reference

| Item | Value |
| --- | --- |
| App name | `scorm-studio` |
| Container | `ix-scorm-studio-scorm-studio-1` |
| Port | 8787 |
| Image | `node:22-alpine` |
| Runs as | apps user, 568:568 |
| Files in the `scorm-studio` dataset (read-only) | `server.js`, `scorm-studio.html` |
| `scorm-studio-live` dataset (writable) | auto-updated `scorm-studio.html` + `.version` + `.bak`, written by the app |

```bash
# check the access code works, and see which release is currently live
curl -H "X-Access-Code: YOUR-CODE" http://localhost:8787/health
```
