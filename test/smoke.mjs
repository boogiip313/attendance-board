import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 4199
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = 'test-secret-xyz'
const DATA_DIR = '/tmp/attendance-smoke/data'

rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
writeFileSync(
  join(DATA_DIR, 'store.json'),
  JSON.stringify({
    users: {
      1: { id: '1', googleId: 'google-1', email: 'alice@example.com', name: 'Alice', rank: 'Captain', createdAt: '2026-01-01T00:00:00.000Z' },
      2: { id: '2', googleId: 'google-2', email: 'mallory@example.com', name: 'Mallory', rank: '', createdAt: '2026-01-01T00:00:00.000Z' },
    },
    attendance: [],
    seq: 2,
  }),
)

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: join(process.cwd(), '..'),
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    BASE_URL: BASE,
    SESSION_SECRET: SECRET,
    DATA_DIR,
    GOOGLE_ADMIN_EMAIL: 'alice@example.com',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let logs = ''
server.stdout.on('data', (d) => (logs += d))
server.stderr.on('data', (d) => (logs += d))
server.unref()

function cookieFor(userId) {
  const exp = Date.now() + 86400000
  const payload = `${userId}.${exp}`
  const sig = createHmac('sha256', SECRET).update(payload).digest('hex')
  return `sid=${encodeURIComponent(`${payload}.${sig}`)}`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`, { redirect: 'manual' })
      if (res.status === 200) return
    } catch {}
    await sleep(200)
  }
  throw new Error(`server did not start:\n${logs}`)
}

let failures = 0
function check(name, cond, extra = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`)
  if (!ok) failures++
}

async function main() {
  await waitUp()

  /* public + unauth (redirect: 'manual' so we see real codes) */
  let res = await fetch(`${BASE}/api/health`)
  check('health ok', res.status === 200 && (await res.json()).oauthConfigured === false)

  res = await fetch(`${BASE}/`)
  check('public board serves', res.status === 200 && (await res.text()).includes('Live Attendance'))

  res = await fetch(`${BASE}/api/attendance`)
  let board = await res.json()
  check('public board lists seeded users', res.status === 200 && board.rows.length === 2 && board.count === 2)

  res = await fetch(`${BASE}/api/me`)
  check('unauthenticated /api/me -> 401 JSON', res.status === 401)

  res = await fetch(`${BASE}/auth/login`)
  const loginHtml = await res.text()
  check('login w/o Google config shows setup page', res.status === 200 && loginHtml.includes('Login requires Google OAuth'))

  res = await fetch(`${BASE}/api/users/9/rank`, { method: 'POST', body: '{}' })
  check('unauthenticated rank post -> 401', res.status === 401)

  /* authenticated flow */
  const headers = { Cookie: cookieFor('1'), 'Content-Type': 'application/json' }

  res = await fetch(`${BASE}/api/me`, { headers })
  let me = await res.json()
  check('me returns seeded user', res.status === 200 && me.user?.name === 'Alice' && me.user.clockedIn === false && me.user.isAdmin === true)

  res = await fetch(`${BASE}/api/clock/in`, { headers, method: 'POST', body: '{}' })
  let clock = await res.json()
  check('clock in', res.status === 200 && Boolean(clock.entry?.in) && !clock.entry.out)

  res = await fetch(`${BASE}/api/clock/in`, { headers, method: 'POST', body: '{}' })
  check('double clock in blocked (409)', res.status === 409)

  res = await fetch(`${BASE}/api/me`, { headers })
  me = await res.json()
  check('me reflects clocked in', me.user.clockedIn === true && Boolean(me.user.activeSince))

  res = await fetch(`${BASE}/api/attendance`)
  board = await res.json()
  check('public board shows on duty', board.inCount === 1 && board.rows[0].clockedIn === true && board.rows[0].in !== null)

  res = await fetch(`${BASE}/api/rank`, { headers, method: 'POST', body: JSON.stringify({ rank: 'Major' }) })
  me = await res.json()
  check('own rank updated', me.user?.rank === 'Major')

  res = await fetch(`${BASE}/api/users/1/rank`, { headers, method: 'POST', body: JSON.stringify({ rank: 'General' }) })
  me = await res.json()
  check('admin rank update works', me.user?.rank === 'General')

  res = await fetch(`${BASE}/api/clock/out`, { headers, method: 'POST', body: '{}' })
  clock = await res.json()
  check('clock out', res.status === 200 && Boolean(clock.entry?.out))

  res = await fetch(`${BASE}/api/clock/out`, { headers, method: 'POST', body: '{}' })
  check('double clock out blocked (409)', res.status === 409)

  res = await fetch(`${BASE}/api/attendance`)
  board = await res.json()
  const row = board.rows.find((r) => r.id === '1')
  check('public board shows previous shift', row && row.clockedIn === false && Boolean(row.out))

  /* admin-only guard */
  const adminCookie = cookieFor('2')
  res = await fetch(`${BASE}/api/users/1/rank`, {
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    method: 'POST',
    body: JSON.stringify({ rank: 'Hacker' }),
  })
  check('non-admin rank change forbidden (403)', res.status === 403)

  /* CSRF origin check */
  res = await fetch(`${BASE}/api/clock/in`, {
    headers: { ...headers, Origin: 'https://evil.example' },
    method: 'POST',
    body: '{}',
  })
  check('cross-origin POST blocked (403)', res.status === 403)

  const finalStore = JSON.parse(readFileSync(join(DATA_DIR, 'store.json'), 'utf8'))
  check('attendance persisted to disk', finalStore.attendance.length === 1 && finalStore.attendance[0].out !== null)

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
  server.kill()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err)
  server.kill()
  process.exit(1)
})