# Attendance Board

A work attendance app with a **public read-only board** and a private dashboard for
**clock in / clock out**. Everyone signs in with their **Google account** and shows their
**name** and **rank** on the public board.

- Zero runtime dependencies — uses only Node.js built-ins (`http`, `crypto`, `fs`).
- Data is stored in a plain JSON file (`data/store.json`), no database required.
- Sessions are HMAC-signed cookies, so no session store needed.
- The public board at `/` can be read by anyone; all state changes require Google authentication.

## Features

| Area       | Public visitor          | Signed-in user                          | Admin (`GOOGLE_ADMIN_EMAIL`) |
|------------|-------------------------|-----------------------------------------|------------------------------|
| Board      | View live attendance    | View live attendance                    | View live attendance         |
| Clock in   | —                   | Yes                                     | Yes                          |
| Clock out  | —                   | Yes                                     | Yes                          |
| Rank       | See everyone\u2019s rank | Set / change their own rank             | Set anyone\u2019s rank        |

## Requirements

- Node.js 18+ (tested on Node 22)

## Quick start

1. **Get Google OAuth credentials**

   - Go to <https://console.cloud.google.com/apis/credentials> and create an OAuth Client ID
     (application type **Web application**).
   - Add an **Authorized redirect URI**: `<your public URL>/auth/callback`
     (e.g. `http://localhost:3000/auth/callback` for local testing, or
     `https://attend.example.com/auth/callback` in production).

2. **Configure the app**

   ```sh
   cd attendance
   cp .env.example .env
   # edit .env:
   #   BASE_URL=your public URL
   #   GOOGLE_CLIENT_ID=...
   #   GOOGLE_CLIENT_SECRET=...
   #   GOOGLE_ADMIN_EMAIL=you@example.com
   ```

3. **Run it**

   ```sh
   npm start        # or: node server.mjs
   ```

   - Public board:  `http://localhost:3000/`
   - Sign in:       `http://localhost:3000/dashboard` (or press "Sign in to clock")
   - Health check:  `http://localhost:3000/api/health`

The board itself is public; nothing on it requires a login. Clocking in/out, editing your
rank, and admin controls all require Google Sign-In.

## Endpoints

| Method | Path                         | Auth   | Description                               |
|--------|------------------------------|--------|-------------------------------------------|
| GET    | `/`                          | public | Public read-only attendance board         |
| GET    | `/dashboard`                 | auth   | Your clock in/out dashboard               |
| GET    | `/api/attendance`            | public | Board data as JSON                        |
| GET    | `/api/me`                    | auth   | Current user + status                     |
| POST   | `/api/clock/in`              | auth   | Clock in                                  |
| POST   | `/api/clock/out`             | auth   | Clock out                                 |
| POST   | `/api/rank`                  | auth   | Set your own rank                         |
| POST   | `/api/users/:id/rank`        | admin  | Set another user\u2019s rank               |
| GET    | `/api/health`                | public | Health check (`oauthConfigured` flag)     |
| GET    | `/auth/login` / `/logout`    | public | Google sign-in flow                       |

## Configuration

All config comes from environment variables or `.env`:

| Variable               | Default               | Description                                              |
|------------------------|-----------------------|----------------------------------------------------------|
| `PORT`                 | `3000`                | Listen port                                              |
| `HOST`                 | `0.0.0.0`             | Listen host (use `0.0.0.0` to be reachable from outside) |
| `BASE_URL`             | `http://localhost:PORT` | Public URL; must match the OAuth redirect URI           |
| `GOOGLE_CLIENT_ID`     |                       | Google OAuth client ID                                   |
| `GOOGLE_CLIENT_SECRET` |                       | Google OAuth client secret                                |
| `GOOGLE_ADMIN_EMAIL`   |                       | Comma-separated admin emails                             |
| `SESSION_SECRET`       | auto-generated        | Cookie signing secret (persisted to `data/session-secret`) |
| `DATA_DIR`             | `./data`              | Where the JSON store and secret live                     |

## Deploying publicly

You can run it on any host that can run Node.js:

- **Bind to `0.0.0.0`** (default) and open port `PORT` in your firewall.
- Set `BASE_URL` to the real public URL and make sure your Google OAuth **redirect URI**
  matches exactly (`https://yourdomain.example/auth/callback`).
- **Use HTTPS** (e.g. Caddy or nginx behind the app), because Google OAuth requires a secure
  context for production redirect URIs and it keeps the cookie safe. SameSite=Lax cookies are
  used, so putting the app behind HTTPS on the same origin is all that\u2019s required.
- Start it with a process manager: `pm2 start server.mjs` or a systemd unit.

### Example systemd unit

```ini
[Unit]
Description=Attendance Board
After=network.target

[Service]
WorkingDirectory=/opt/attendance
ExecStart=/usr/bin/node server.mjs
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Security notes

- Google ID tokens are cryptographically verified against Google\u2019s JWKS (RS256).
- Sessions are signed HMAC cookies (SHA-256); the signing key is random and stored in `data/session-secret`.
- A lightweight Origin check prevents cross-site state-changing requests.
- Public data intentionally exposes only name, rank, and clock times (no emails from the API).

## Project layout

```
attendance/
  server.mjs            Express-free HTTP server + all routes
  lib/
    store.mjs           JSON-file store (users + attendance + atomic writes)
    auth.mjs            Google OAuth (code flow + JWKS id_token verify) and sessions
  public/
    index.html          Public read-only attendance board
    dashboard.html      Signed-in clock in/out page
    style.css
    js/
      common.js         Shared helpers
      public.js         Public board logic (polls /api/attendance)
      dashboard.js      Dashboard logic
  data/                 Runtime data (gitignored): store.json, session-secret
  .env.example
```