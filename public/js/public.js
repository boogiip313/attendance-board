import { api, el, escapeHtml, fmtDate, fmtDuration, fmtTime, statusClass } from './common.js'

const boardEl = document.getElementById('board')
const metaEl = document.getElementById('meta')
const clockEl = document.getElementById('clock')
const errorEl = document.getElementById('error')

function setError(msg) {
  if (!msg) {
    errorEl.hidden = true
    errorEl.textContent = ''
    return
  }
  errorEl.hidden = false
  errorEl.textContent = msg
}

function buildRow(row) {
  const lastShift = row.out ? fmtDuration(new Date(row.out) - new Date(row.in)) : null

  return el('div', { class: `card row ${row.clockedIn ? 'row-in' : ''}` },
    el('div', { class: 'status-dot' }),
    el('div', { class: 'row-main' },
      el('div', { class: 'row-name' }, escapeHtml(row.name || 'Unknown')),
      el('div', { class: 'row-rank' }, escapeHtml(row.rank || 'No rank')),
    ),
    el('div', { class: 'row-right' },
      el('span', { class: `badge ${statusClass(row.clockedIn)}` }, row.clockedIn ? 'ON DUTY' : 'OFF DUTY'),
      el('div', { class: 'row-times' },
        row.clockedIn
          ? `${fmtDate(row.in)} \u00b7 in ${fmtTime(row.in)}`
          : row.out
            ? `${fmtDate(row.in)} \u00b7 ${fmtTime(row.in)}\u2013${fmtTime(row.out)} (${lastShift})`
            : 'No shifts yet',
      ),
    ),
  )
}

function emptyState() {
  return el('div', { class: 'empty' },
    el('p', {}, 'No one has signed in yet.'),
    el('p', { class: 'muted' }, 'When someone clocks in, they appear here automatically.'),
  )
}

function render(board) {
  const { rows, inCount, count } = board
  boardEl.replaceChildren()
  if (!rows.length) {
    boardEl.append(emptyState())
  } else {
    for (const row of rows) boardEl.append(buildRow(row))
  }
  metaEl.textContent = `${inCount} on duty \u00b7 ${count} total`
  setError(null)
}

async function refresh() {
  try {
    const board = await api('/api/attendance')
    render(board)
  } catch (err) {
    setError(`Could not reach the board: ${err.message}`)
  }
}

function tick() {
  clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

tick()
setInterval(tick, 1000)
refresh()
setInterval(refresh, 8000)