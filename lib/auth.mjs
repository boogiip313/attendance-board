import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto'

/* ------------------------------------------------------------------ */
/* Session cookies (HMAC-signed, so they need no server-side storage)  */
/* ------------------------------------------------------------------ */

export function createSession(userId, secret, ttlDays = 30) {
  const exp = Date.now() + ttlDays * 24 * 3600 * 1000
  const payload = `${userId}.${exp}`
  const sig = sign(payload, secret)
  return { value: `${payload}.${sig}`, expires: new Date(exp) }
}

export function readSession(cookie, secret) {
  if (!cookie) return null
  const parts = cookie.split('.')
  if (parts.length !== 3) return null
  const [userId, exp, sig] = parts
  const expected = sign(`${userId}.${exp}`, secret)
  if (!safeEqual(sig, expected)) return null
  if (Number(exp) < Date.now()) return null
  return userId
}

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('hex')
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/* ------------------------------------------------------------------ */
/* Google OAuth (authorization code flow)                              */
/* ------------------------------------------------------------------ */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

export function buildAuthorizeUrl(clientId, redirectUri) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state: randomBytes(16).toString('hex'),
  })
  return { url: `${AUTH_URL}?${params.toString()}`, state: params.get('state') }
}

export async function exchangeCode(clientId, clientSecret, redirectUri, code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  const data = await res.json()
  if (!res.ok || !data.id_token) {
    throw new Error(data.error_description || data.error || `token exchange failed (${res.status})`)
  }
  return data.id_token
}

/* Verify the Google-signed id_token (RS256) against their public JWKS. */
let jwksCache = { at: 0, keys: {} }

async function getJwks() {
  if (Date.now() - jwksCache.at < 6 * 3600 * 1000) return jwksCache.keys
  const res = await fetch(CERTS_URL)
  const data = await res.json()
  const keys = {}
  for (const key of data.keys || []) keys[key.kid] = key
  jwksCache = { at: Date.now(), keys }
  return keys
}

export async function verifyIdToken(idToken, clientId) {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('malformed id_token')
  const [h, p, sig] = parts
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))

  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`)
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error(`unexpected issuer ${payload.iss}`)
  }
  if (payload.aud && String(payload.aud) !== clientId) {
    throw new Error('id_token audience mismatch')
  }
  if (Number(payload.exp) * 1000 < Date.now()) throw new Error('id_token expired')

  const keys = await getJwks()
  const key = keys[header.kid]
  if (!key) throw new Error(`unknown key id ${header.kid}`)

  const publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' })
  const ok = verify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'))
  if (!ok) throw new Error('id_token signature invalid')

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email,
  }
}

/* ------------------------------------------------------------------ */
/* Cookie helpers / CSRF origin check                                  */
/* ------------------------------------------------------------------ */

export function getCookie(req, name) {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

export function checkOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}