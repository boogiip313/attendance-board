import { api, el, escapeHtml, fmtDuration, fmtTime } from './common.js'

const nameEl = document.getElementById('name')
const rankEl = document.getElementById('rank')
const emailEl = document.getElementById('email')
const statusCardEl = document.getElementById('statusCard')
const statusTextEl = document.getElementById('statusText')
const statusTimeEl = document.getElementById('statusTime')
const elapsedEl = document.getElementById('elapsed')
const clockBtnEl = document.getElementById('clockBtn')
const clockNoteEl = document.getElementById('clockNote')
const rankFormEl = document.getElementById('rankForm')
const rankInputEl = document.getElementById('rankInput')
const adminSectionEl = document.getElementById('adminSection')
const adminListEl = document.getElementById('adminList')
const errorEl = document.getElementById('error')

let me = null
let ticker = null

function setError(msg) {
  if (!msg) {
    errorEl.hidden = true
    errorEl.textContent = ''
    return
  }
  errorEl.hidden = false
  errorEl.textContent = msg
}

function updateElapsed() {
  if (me && me.clockedIn && me.activeSince) {
    const ms = Date.now() - new Date(me.activeSince).getTime()
    elapsedEl.textContent = fmtDuration(ms)
  }
}

function renderStatus() {
  const clockedIn = me.clockedIn
  statusCardEl.classList.toggle('in', clockedIn)
  statusCardEl.classList.toggle('out', !clockedIn)
  statusTextEl.textContent = clockedIn ? 'ON DUTY' : 'OFF DUTY'
  statusTimeEl.textContent = clockedIn ? `Since ${fmtTime(me.activeSince)}` : 'Not clocked in'
  clockBtnEl.textContent = clockedIn ? 'Clock Out' : 'Clock In'
  clockBtnEl.classList.toggle('btn-danger', clockedIn)
  clockBtnEl.classList.toggle('btn-primary', !clockedIn)
  clockNoteEl.textContent = ''
  if (ticker) clearInterval(ticker)
  elapsedEl.textContent = ''
  if (clockedIn) {
    updateElapsed()
    ticker = setInterval(updateElapsed, 1000)
  }
}

function renderRankForm() {
  rankInputEl.value = me.rank || ''
  rankEl.textContent = me.rank || 'No rank'
}

function renderAdmin() {
  if (!me.isAdmin) {
    adminSectionEl.hidden = true
    return
  }
  adminSectionEl.hidden = false
  api('/api/attendance').then((board) => {
    adminListEl.replaceChildren()
    for (const row of board.rows) {
      const input = el('input', { class: 'rank-input', value: row.rank || '', type: 'text', placeholder: 'Rank' })
      const saveBtn = el('button', { class: 'btn btn-small btn-secondary' }, 'Save')
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true
        try {
          await api(`/api/users/${row.id}/rank`, { method: 'POST', body: JSON.stringify({ rank: input.value }) })
          renderAdmin()
        } catch (err) {
          setError(err.message)
          saveBtn.disabled = false
        }
      })
      adminListEl.append(
        el('div', { class: 'admin-row' },
          el('span', { class: 'row-name' }, escapeHtml(row.name || 'Unknown')),
          input,
          saveBtn,
        ),
      )
    }
  }).catch((err) => setError(err.message))
}

async function clockToggle() {
  clockBtnEl.disabled = true
  try {
    const action = me.clockedIn ? 'out' : 'in'
    const data = await api(`/api/clock/${action}`, { method: 'POST', body: '{}' })
    me = {
      ...me,
      clockedIn: action === 'in',
      activeSince: action === 'in' ? data.entry.in : null,
    }
    renderStatus()
    if (action === 'out') {
      const dur = data.entry.out ? fmtDuration(new Date(data.entry.out) - new Date(data.entry.in)) : ''
      clockNoteEl.textContent = `Clocked out. Worked ${dur}.`
    }
  } catch (err) {
    if (err.data && err.data.error === 'already_clocked_in') {
      me.clockedIn = true
      refreshMe()
    }
    setError(err.message)
  } finally {
    clockBtnEl.disabled = false
  }
}

function wireRankForm() {
  rankFormEl.addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = rankFormEl.querySelector('button')
    btn.disabled = true
    try {
      const data = await api('/api/rank', { method: 'POST', body: JSON.stringify({ rank: rankInputEl.value }) })
      me = { ...me, rank: data.user.rank }
      renderRankForm()
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      btn.disabled = false
    }
  })
}

async function refreshMe() {
  const data = await api('/api/me')
  return data.user
}

async function init() {
  clockBtnEl.addEventListener('click', clockToggle)
  wireRankForm()
  try {
    me = await refreshMe()
  } catch (err) {
    setError(`Not signed in (${err.message}). Redirecting...`)
    setTimeout(() => { location.href = '/auth/login' }, 1200)
    return
  }
  nameEl.textContent = me.name || me.email
  emailEl.textContent = me.email
  renderStatus()
  renderRankForm()
  renderAdmin()
}

init()