export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v)
  }
  for (const child of children.flat()) {
    if (child == null) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  let data = {}
  try {
    data = await res.json()
  } catch {}
  if (!res.ok) {
    const message = data.message || data.error || `Request failed (${res.status})`
    const err = new Error(message)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export function fmtTime(iso) {
  if (!iso) return '\u2014'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fmtDate(iso) {
  if (!iso) return '\u2014'
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function fmtDuration(ms) {
  if (!ms || ms <= 0) return '0m'
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c])
}

export function statusClass(state) {
  return state ? 'in' : 'out'
}