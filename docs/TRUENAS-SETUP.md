# SCORM Studio on TrueNAS

SCORM Studio runs as a custom app on TrueNAS Community Edition 25.04 and is reached in any browser,
on Windows or Mac, with nothing to install. The same app writes quiz questions with your Claude API
key, which stays on the server.

- **Web address:** https://scorm-studio.g-security.uk/ (through the Cloudflared app)
- **Access code:** colleagues type it once to use question writing. Anyone with the address can build courses.
- **Limits:** 20 question requests per person per hour, 100 per day in total, plus the spend limit on your Claude workspace.

The app is two files in a TrueNAS dataset, `server.js` and `scorm-studio.html`, run by the official
`node:22-alpine` image as the TrueNAS apps user (568) with read-only access to the folder.
After `npm run build`, both files are in `deploy/truenas/app/`.

---

## First-time setup

1. **API key with a spending cap**
    - Sign in at https://platform.claude.com and add credit under Billing.
    - Create a Workspace (for example "SCORM Studio") and set a monthly spend limit on it.
    - Create an API key inside that workspace and keep it safe.
2. **Dataset**
    - Datasets > Add Dataset, name it `scorm-studio`, Dataset Preset **Apps**.
    - Note its path, for example `/mnt/tank/apps/scorm-studio`.
3. **Copy the two files in**, straight into the dataset (not inside an `app` subfolder).
   Use WinSCP or Cyberduck over SFTP (turn on SSH in System > Services), or a temporary SMB share.
4. **Fix permissions** so the apps user can read them (System > Shell):
   ```bash
   sudo chown -R 568:568 /mnt/YOUR-POOL/apps/scorm-studio
   sudo chmod 755 /mnt/YOUR-POOL/apps/scorm-studio
   sudo chmod 644 /mnt/YOUR-POOL/apps/scorm-studio/*
   ```
5. **Install the app**
    - Edit the 4 marked lines in `deploy/truenas/truenas-app.yaml`: API key, access code,
      port (only if 8787 is taken), dataset path.
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

## Updating

| What changed | What to do |
| --- | --- |
| `scorm-studio.html` | Replace the file. No restart; it loads on the next page refresh |
| `server.js` | Replace the file, then Apps > scorm-studio > Restart |
| API key, access code, limits, port | Apps > scorm-studio > Edit, change the YAML, Save |

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

If log times look wrong, set the time zone in System > General Settings > Localization.

## Quick reference

| Item | Value |
| --- | --- |
| App name | `scorm-studio` |
| Container | `ix-scorm-studio-scorm-studio-1` |
| Port | 8787 |
| Image | `node:22-alpine` |
| Runs as | apps user, 568:568 |
| Files in the dataset | `server.js`, `scorm-studio.html` |

```bash
# check the access code works
curl -H "X-Access-Code: YOUR-CODE" http://localhost:8787/health
```
