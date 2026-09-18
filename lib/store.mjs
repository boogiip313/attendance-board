import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * Tiny JSON-file-backed store. Every write is atomic (tmp + rename) and the
 * whole dataset is kept in memory, so reads are synchronous and safe.
 */
export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.file = join(dataDir, 'store.json')
    mkdirSync(dataDir, { recursive: true })
    this.db = { users: {}, attendance: [], seq: 0 }
    if (existsSync(this.file)) {
      try {
        this.db = JSON.parse(readFileSync(this.file, 'utf8'))
      } catch (err) {
        console.error(`[store] could not read ${this.file}: ${err.message}`)
      }
    } else {
      this.persist()
    }
  }

  persist() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.db, null, 2))
    renameSync(tmp, this.file)
  }

  getUser(id) {
    const u = this.db.users[id]
    return u ? { ...u } : null
  }

  getUserByGoogleId(googleId) {
    for (const u of Object.values(this.db.users)) {
      if (u.googleId === googleId) return { ...u }
    }
    return null
  }

  getUserByEmail(email) {
    for (const u of Object.values(this.db.users)) {
      if (String(u.email ?? '').toLowerCase() === String(email ?? '').toLowerCase()) return { ...u }
    }
    return null
  }

  upsertUser({ googleId, email, name }) {
    let user = this.getUserByGoogleId(googleId)
    if (user) {
      this.db.users[user.id].email = email
      this.db.users[user.id].name = name
      user = this.db.users[user.id]
    } else {
      const id = String(++this.db.seq)
      this.db.users[id] = {
        id,
        googleId,
        email,
        name,
        rank: '',
        createdAt: new Date().toISOString(),
      }
      user = this.db.users[id]
    }
    this.persist()
    return { ...user }
  }

  updateUser(id, patch) {
    const u = this.db.users[id]
    if (!u) return null
    Object.assign(u, patch)
    this.persist()
    return { ...u }
  }

  listUsers() {
    return Object.values(this.db.users).map((u) => ({ ...u }))
  }

  getActiveEntry(userId) {
    return this.db.attendance.find((a) => a.userId === userId && !a.out) ?? null
  }

  getLastEndedEntry(userId) {
    const ended = this.db.attendance
      .filter((a) => a.userId === userId && a.out)
      .sort((a, b) => String(b.out).localeCompare(String(a.out)))
    return ended[0] ?? null
  }

  clockIn(userId) {
    if (this.getActiveEntry(userId)) return { error: 'already_clocked_in' }
    const entry = { id: ++this.db.seq, userId, in: new Date().toISOString(), out: null }
    this.db.attendance.push(entry)
    this.persist()
    return { entry: { ...entry } }
  }

  clockOut(userId) {
    const active = this.getActiveEntry(userId)
    if (!active) return { error: 'not_clocked_in' }
    active.out = new Date().toISOString()
    this.persist()
    return { entry: { ...active } }
  }
}