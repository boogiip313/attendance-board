import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { createReadStream, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { randomBytes } from 'node:crypto'

import { Store } from './lib/store.mjs'
import {
  buildAuthorizeUrl,
  checkOrigin,
  createSession,
  exchangeCode,
  getCookie,
  readSession,
  verifyIdToken,
} from './lib/auth.mjs'

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

function loadDotEnv() {
  const file = join(process.cwd(), '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    if (process.env[key] !== undefined) continue
    process.env[key] = trimmed.slice(idx + 1).trim()
  }
}
loadDotEnv()

const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '0.0.0.0'
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '')
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const ADMINS = (process.env.GOOGLE_ADMIN_EMAIL || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const PUBLIC_DIR = join(process.cwd(), 'public')
const SESSION_TTL_DAYS = 30

let SESSION_SECRET = process.env.SESSION_SECRET || ''
if (!SESSION_SECRET) {
  const secretFile = join(DATA_DIR, 'session-secret')
  if (existsSync(secretFile)) {
    SESSION_SECRET = readFileSync(secretFile, 'utf8').trim()
  } else {
    SESSION_SECRET = randomBytes(32).toString('hex')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(secretFile, SESSION_SECRET, { mode: 0o600 })
  }
}

const store = new Store(DATA_DIR)
const oauthConfigured = Boolean(CLIENT_ID && CLIENT_SECRET)

function isAdmin(user) {
  return Boolean(user && ADMINS.includes(String(user.email ?? '').toLowerCase()))
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...headers })
  res.end(body)
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8')
}

function redirect(res, location) {
  res.writeHead(302, { Location: location })
  res.end()
}

async function readJsonBody(req) {
  let buf = ''
  for await (const chunk of req) {
    if (buf.length + chunk.length > 1_000_000) throw { status: 413, message: 'body too large' }
    buf += chunk
  }
  if (!buf) return {}
  try {
    return JSON.parse(buf)
  } catch {
    throw { status: 400, message: 'invalid JSON body' }
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const file = normalize(join(PUBLIC_DIR, rel))
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    return false
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
  createReadStream(file).pipe(res)
  return true
}

/* Authenticated request context (session + current user) */
function authContext(req) {
  const cookie = getCookie(req, 'sid')
  const userId = cookie ? readSession(cookie, SESSION_SECRET) : null
  const user = userId ? store.getUser(userId) : null
  return { user: user ? { ...user, isAdmin: isAdmin(user) } : null }
}

function requireAuth(req, res) {
  const { user } = authContext(req)
  if (!user) {
    redirect(res, '/auth/login')
    return null
  }
  return user
}

function apiAuth(req, res) {
  const { user } = authContext(req)
  if (!user) {
    sendJson(res, 401, { error: 'unauthorized', message: 'Sign in required.' })
    return null
  }
  if (!checkOrigin(req)) {
    sendJson(res, 403, { error: 'forbidden' })
    return null
  }
  return user
}

/* ------------------------------------------------------------------ */
/* Board data (shared by the public API + me endpoint)                 */
/* ------------------------------------------------------------------ */

function rowForUser(u) {
  const active = store.getActiveEntry(u.id)
  const last = active || store.getLastEndedEntry(u.id)
  return {
    id: u.id,
    name: u.name,
    rank: u.rank || '',
    clockedIn: Boolean(active),
    in: active ? active.in : (last ? last.in : null),
    out: active ? null : (last ? last.out : null),
  }
}

function boardData() {
  const rows = store.listUsers().map(rowForUser)
  rows.sort((a, b) => Number(b.clockedIn) - Number(a.clockedIn) || a.name.localeCompare(b.name))
  return {
    generatedAt: new Date().toISOString(),
    oauthConfigured,
    count: rows.length,
    inCount: rows.filter((r) => r.clockedIn).length,
    rows,
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, BASE_URL)
  const { pathname } = url
  const method = req.method || 'GET'

  try {
    /* ---- Auth ---------------------------------------------------- */
    if (pathname === '/auth/login' && method === 'GET') {
      if (!oauthConfigured) return sendConfigPage(res, 'Login requires Google OAuth credentials.')
      const { url: authUrl, state } = buildAuthorizeUrl(CLIENT_ID, `${BASE_URL}/auth/callback`)
      res.writeHead(302, {
        Location: authUrl,
        'Set-Cookie': `ostate=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
      })
      return res.end()
    }

    if (pathname === '/auth/callback' && method === 'GET') {
      const error = url.searchParams.get('error')
      if (error) return sendConfigPage(res, `Google sign-in failed: ${error}`)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code || !state || state !== getCookie(req, 'ostate')) {
        return sendConfigPage(res, 'Sign-in verification failed. Try again.')
      }
      if (!oauthConfigured) return sendConfigPage(res, 'Google OAuth is not configured.')

      const idToken = await exchangeCode(CLIENT_ID, CLIENT_SECRET, `${BASE_URL}/auth/callback`, code)
      const profile = await verifyIdToken(idToken, CLIENT_ID)
      const user = store.upsertUser(profile)

      const session = createSession(user.id, SESSION_SECRET, SESSION_TTL_DAYS)
      res.writeHead(302, {
        Location: '/dashboard',
        'Set-Cookie': `sid=${encodeURIComponent(session.value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
      })
      return res.end()
    }

    if (pathname === '/auth/logout' && method === 'GET') {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      })
      return res.end()
    }

    /* ---- API (public) ------------------------------------------- */
    if (pathname === '/api/attendance' && method === 'GET') {
      return sendJson(res, 200, boardData())
    }

    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, oauthConfigured })
    }

    /* ---- API (auth required) ------------------------------------- */
    if (pathname.startsWith('/api/')) {
      const user = apiAuth(req, res)
      if (!user) return

      if (pathname === '/api/me' && method === 'GET') {
        const active = store.getActiveEntry(user.id)
        return sendJson(res, 200, {
          user: { ...user, clockedIn: Boolean(active), activeSince: active ? active.in : null },
        })
      }

      if (pathname === '/api/clock/in' && method === 'POST') {
        const result = store.clockIn(user.id)
        if (result.error) return sendJson(res, 409, { error: result.error, message: 'Already clocked in.' })
        return sendJson(res, 200, { entry: result.entry })
      }

      if (pathname === '/api/clock/out' && method === 'POST') {
        const result = store.clockOut(user.id)
        if (result.error) return sendJson(res, 409, { error: result.error, message: 'Not currently clocked in.' })
        return sendJson(res, 200, { entry: result.entry })
      }

      if (pathname === '/api/rank' && method === 'POST') {
        const body = await readJsonBody(req)
        const rank = String(body.rank ?? '').trim().slice(0, 80)
        if (!rank) return sendJson(res, 400, { error: 'rank_required', message: 'Rank cannot be empty.' })
        const updated = store.updateUser(user.id, { rank })
        return sendJson(res, 200, { user: { ...updated, isAdmin: isAdmin(updated) } })
      }

      const rankForMatch = pathname.match(/^\/api\/users\/([^/]+)\/rank$/)
      if (rankForMatch && method === 'POST') {
        if (!isAdmin(user)) return sendJson(res, 403, { error: 'forbidden', message: 'Admins only.' })
        const target = store.getUser(rankForMatch[1])
        if (!target) return sendJson(res, 404, { error: 'not_found' })
        const body = await readJsonBody(req)
        const rank = String(body.rank ?? '').trim().slice(0, 80)
        const updated = store.updateUser(target.id, { rank })
        return sendJson(res, 200, { user: { ...updated, isAdmin: isAdmin(updated) } })
      }

      return sendJson(res, 404, { error: 'not_found' })
    }

    /* ---- Pages --------------------------------------------------- */
    if (method === 'GET') {
      if (pathname === '/dashboard') {
        const ctx = authContext(req)
        if (!ctx.user) return redirect(res, '/auth/login')
        return serveStatic(res, '/dashboard.html')
      }
      return serveStatic(res, pathname) || send(res, 404, 'Not found')
    }

    return send(res, 405, 'Method not allowed')
  } catch (err) {
    console.error(err)
    const status = err.status || 500
    const message = status === 500 ? 'Internal server error' : err.message
    sendJson(res, status, { error: 'error', message })
  }
}

function sendConfigPage(res, note) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Setup needed</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"></head><body class="center-page">
<main class="card"><h1>Attendance Board</h1><p class="muted">${note}</p>
<p>Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to your <code>.env</code>
and set <code>BASE_URL</code>, then restart. See the README.</p>
<a class="btn btn-secondary" href="/">Back to board</a></main></body></html>`
  send(res, 200, html, 'text/html; charset=utf-8')
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err)
    try { sendJson(res, 500, { error: 'error', message: 'Internal server error' }) } catch {}
  })
})

server.listen(PORT, HOST, () => {
  console.log(`Attendance board running`)
  console.log(`  Local:      http://localhost:${PORT}/`)
  console.log(`  Public URL: ${BASE_URL}/`)
  console.log(`  Google OAuth: ${oauthConfigured ? 'configured' : 'NOT CONFIGURED (set .env)'}`)
})