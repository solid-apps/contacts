// contacts — manage the contacts stored on your Solid pod.
//
// Contacts live under <pod>/public/contacts/ as vCard JSON-LD (one resource per
// person). List / add / edit / delete via the pod's LDP + authFetch API. Import
// from the device address book via the Contact Picker API (Chrome / Samsung
// Internet on Android), or from a .vcf file anywhere.
//
// All URLs are derived relative to this page, so it works whether the pod is at
// an origin root or behind a path (e.g. a tunnel).

const appEl = document.getElementById('app')

// .../public/apps/contacts/  →  data container is at <pod>/public/contacts/
const BOOK = new URL('../../contacts/', location.href)

// Resolve fresh each call — xlogin attaches authFetch asynchronously.
const authFetch = (url, opts) => ((window.xlogin && window.xlogin.authFetch) || fetch)(url, opts)
const loggedIn = () => !!(window.xlogin && window.xlogin.id)

const pickerSupported = ('contacts' in navigator) && ('ContactsManager' in window)

// --- vCard JSON-LD model ---
function contactDoc({ fn, emails, tels, note, webid }) {
  const doc = {
    '@context': { vcard: 'http://www.w3.org/2006/vcard/ns#' },
    '@type': 'vcard:Individual',
    'vcard:fn': fn || '',
    'vcard:hasEmail': (emails || []).filter(Boolean),
    'vcard:hasTelephone': (tels || []).filter(Boolean)
  }
  // WebID — the contact's Solid identity, used to message them (the inbox app
  // resolves their ldp:inbox from it). Stored as vcard:url.
  if (webid) doc['vcard:url'] = webid
  if (note) doc['vcard:note'] = note
  return doc
}

function parseContact(doc) {
  const get = (k) => doc['vcard:' + k] || doc['http://www.w3.org/2006/vcard/ns#' + k]
  const list = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]))
    .map((x) => (typeof x === 'string' ? x : (x['vcard:value'] || x.value || x['@value'] || '')))
    .filter(Boolean)
  const one = (v) => (typeof v === 'string' ? v : (v && (v['@id'] || v['@value'] || v.value))) || ''
  return {
    fn: get('fn') || doc.fn || '',
    emails: list(get('hasEmail')).map((e) => e.replace(/^mailto:/i, '')),
    tels: list(get('hasTelephone')).map((t) => t.replace(/^tel:/i, '')),
    webid: one(Array.isArray(get('url')) ? get('url')[0] : get('url')),
    note: get('note') || ''
  }
}

// --- pod I/O ---
function ldpContains(doc) {
  let c = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc.contains || []
  return (Array.isArray(c) ? c : [c]).map((x) => (typeof x === 'string' ? x : x['@id'] || x.id)).filter(Boolean)
}

async function listContacts() {
  const r = await authFetch(BOOK, { headers: { Accept: 'application/ld+json' } })
  if (!r.ok) return []                       // 404 → container not created yet
  const urls = ldpContains(await r.json())
    .map((u) => new URL(u, BOOK).href)
    .filter((u) => !u.endsWith('/') && !u.split('/').pop().startsWith('.'))
  const out = []
  for (const u of urls) {
    try {
      const cr = await authFetch(u, { headers: { Accept: 'application/ld+json' } })
      if (!cr.ok) continue
      out.push({ url: u, ...parseContact(await cr.json()) })
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => (a.fn || '').localeCompare(b.fn || ''))
  return out
}

const slug = (fn) => (fn || 'contact').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'contact'

async function saveContact(data, existingUrl) {
  const url = existingUrl || new URL(slug(data.fn) + '-' + Date.now().toString(36), BOOK).href
  let res = await authFetch(url, {
    method: 'PUT', headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(contactDoc(data))
  })
  // If the container does not exist yet, create it and retry once.
  if (!res.ok && (res.status === 404 || res.status === 409) && !existingUrl) {
    await authFetch(BOOK, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: '' }).catch(() => {})
    res = await authFetch(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify(contactDoc(data))
    })
  }
  if (!res.ok) throw new Error(`save failed (${res.status})`)
  return url
}

async function removeContact(url) {
  const res = await authFetch(url, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(`delete failed (${res.status})`)
}

// --- imports ---
async function importFromDevice() {
  let props = ['name', 'email', 'tel']
  try {
    const avail = await navigator.contacts.getProperties()
    if (Array.isArray(avail) && avail.length) props = props.filter((p) => avail.includes(p))
  } catch { /* use defaults */ }
  const picked = await navigator.contacts.select(props.length ? props : ['name'], { multiple: true })
  let n = 0
  for (const c of picked) {
    const fn = (c.name && c.name[0]) || (c.email && c.email[0]) || (c.tel && c.tel[0]) || 'Unnamed'
    await saveContact({ fn, emails: c.email || [], tels: c.tel || [] })
    n++
  }
  return n
}

function parseVcf(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n') // unfold continuations
  const cards = []
  let cur = null
  for (const line of lines) {
    const u = line.trim()
    if (/^BEGIN:VCARD$/i.test(u)) cur = { fn: '', emails: [], tels: [] }
    else if (/^END:VCARD$/i.test(u)) { if (cur) cards.push(cur); cur = null }
    else if (cur) {
      const idx = line.indexOf(':')
      if (idx < 0) continue
      const key = line.slice(0, idx).split(';')[0].toUpperCase()
      const val = line.slice(idx + 1).trim()
      if (key === 'FN') cur.fn = val
      else if (key === 'N' && !cur.fn) cur.fn = val.split(';').filter(Boolean).reverse().join(' ').trim()
      else if (key === 'EMAIL') cur.emails.push(val)
      else if (key === 'TEL') cur.tels.push(val)
    }
  }
  return cards.filter((c) => c.fn || c.emails.length || c.tels.length)
}

async function importVcf(files) {
  let n = 0
  for (const file of files) {
    for (const c of parseVcf(await file.text())) {
      await saveContact({ fn: c.fn || c.emails[0] || c.tels[0] || 'Unnamed', emails: c.emails, tels: c.tels })
      n++
    }
  }
  return n
}

// --- UI ---
function toast(msg) {
  let t = document.querySelector('.toast')
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t) }
  t.textContent = msg; t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 2400)
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

let CONTACTS = []
let FILTER = ''

function editor(existing) {
  const c = existing || { fn: '', emails: [], tels: [], note: '' }
  const wrap = document.createElement('div')
  wrap.className = 'editor'
  wrap.innerHTML = `
    <div class="card form">
      <input class="f-fn"    placeholder="Name"                         value="${esc(c.fn)}">
      <input class="f-email" placeholder="Emails (comma-separated)"     value="${esc((c.emails || []).join(', '))}">
      <input class="f-tel"   placeholder="Phones (comma-separated)"     value="${esc((c.tels || []).join(', '))}">
      <input class="f-webid" placeholder="WebID (https://…/profile/card#me)" value="${esc(c.webid || '')}">
      <textarea class="f-note" placeholder="Note" rows="2">${esc(c.note)}</textarea>
      <div class="form-actions">
        <button class="save">Save</button>
        <button class="cancel ghost">Cancel</button>
      </div>
    </div>`
  const splitList = (v) => v.split(',').map((s) => s.trim()).filter(Boolean)
  wrap.querySelector('.cancel').onclick = () => render()
  wrap.querySelector('.save').onclick = async (e) => {
    if (!loggedIn()) { toast('Sign in first (login pill, bottom-right)'); return }
    const data = {
      fn: wrap.querySelector('.f-fn').value.trim(),
      emails: splitList(wrap.querySelector('.f-email').value),
      tels: splitList(wrap.querySelector('.f-tel').value),
      webid: wrap.querySelector('.f-webid').value.trim(),
      note: wrap.querySelector('.f-note').value.trim()
    }
    if (!data.fn && !data.emails.length && !data.tels.length && !data.webid) { toast('Add a name, email, phone or WebID'); return }
    e.currentTarget.disabled = true
    try {
      await saveContact(data, existing && existing.url)
      toast(existing ? 'saved' : 'added')
      await render()
    } catch (err) { toast(String(err.message || err)); e.currentTarget.disabled = false }
  }
  return wrap
}

function contactCard(c) {
  const row = document.createElement('div')
  row.className = 'card contact'
  const initials = (c.fn || '?').split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
  row.innerHTML = `
    <div class="avatar">${esc(initials || '?')}</div>
    <div class="who">
      <div class="name">${esc(c.fn || '(no name)')}</div>
      ${c.emails.map((e) => `<a class="line" href="mailto:${esc(e)}">${esc(e)}</a>`).join('')}
      ${c.tels.map((t) => `<a class="line" href="tel:${esc(t)}">${esc(t)}</a>`).join('')}
      ${c.webid ? `<a class="line webid" href="${esc(c.webid)}" title="WebID">⬡ ${esc(c.webid)}</a>` : ''}
      ${c.note ? `<div class="line note">${esc(c.note)}</div>` : ''}
    </div>
    <div class="actions">
      ${c.webid ? '<button class="msg" title="Message">Message</button>' : ''}
      <button class="edit ghost" title="Edit">Edit</button>
      <button class="del ghost danger" title="Remove">Remove</button>
    </div>`
  const msgBtn = row.querySelector('.msg')
  if (msgBtn) msgBtn.onclick = () => {
    // Open this person (a webid) via the intent bus — any app that handles
    // webid appears in the chooser. Falls back to messages directly if the bus
    // isn't loaded.
    if (window.intent) window.intent.open('webid', c.webid, c.fn)
    else location.href = '../messages/?to=' + encodeURIComponent(c.webid)
  }
  row.querySelector('.edit').onclick = () => { row.replaceWith(editor(c)) }
  row.querySelector('.del').onclick = async () => {
    if (!loggedIn()) { toast('Sign in first (login pill, bottom-right)'); return }
    if (!confirm(`Remove "${c.fn || 'this contact'}"?`)) return
    try { await removeContact(c.url); toast('removed'); await render() } catch (err) { toast(String(err.message || err)) }
  }
  return row
}

async function render() {
  try { CONTACTS = await listContacts() } catch { CONTACTS = [] }

  appEl.innerHTML = ''
  const head = document.createElement('div')
  head.innerHTML = `
    <h1>Contacts</h1>
    <p class="sub">${CONTACTS.length} ${CONTACTS.length === 1 ? 'contact' : 'contacts'} on your pod.</p>
    ${loggedIn() ? '' : '<div class="signin-note">Sign in (login pill, bottom-right) to view, add or import contacts.</div>'}
    <div class="toolbar">
      <button class="add">+ Add</button>
      ${pickerSupported ? '<button class="imp-dev ghost">Import from phone</button>' : ''}
      <button class="imp-vcf ghost">Import .vcf</button>
      <input class="search" type="search" placeholder="Search…" value="${esc(FILTER)}">
    </div>`
  appEl.appendChild(head)

  head.querySelector('.add').onclick = () => { head.after(editor(null)) }
  head.querySelector('.imp-vcf').onclick = () => document.getElementById('vcf').click()
  const dev = head.querySelector('.imp-dev')
  if (dev) dev.onclick = async () => {
    if (!loggedIn()) { toast('Sign in first (login pill, bottom-right)'); return }
    dev.disabled = true
    try { const n = await importFromDevice(); toast(`imported ${n}`); await render() }
    catch (err) { if (err && err.name !== 'AbortError') toast(String(err.message || err)); dev.disabled = false }
  }
  const search = head.querySelector('.search')
  search.oninput = () => { FILTER = search.value; paintList() }

  const list = document.createElement('div')
  list.className = 'list'
  appEl.appendChild(list)
  paintList()
}

function paintList() {
  const list = appEl.querySelector('.list')
  if (!list) return
  const q = FILTER.trim().toLowerCase()
  const shown = q
    ? CONTACTS.filter((c) => (c.fn + ' ' + c.emails.join(' ') + ' ' + c.tels.join(' ')).toLowerCase().includes(q))
    : CONTACTS
  list.innerHTML = ''
  if (!shown.length) {
    const empty = document.createElement('p')
    empty.className = 'muted'
    empty.textContent = CONTACTS.length ? 'No matches.' : 'No contacts yet — add one or import from your phone.'
    list.appendChild(empty)
    return
  }
  shown.forEach((c) => list.appendChild(contactCard(c)))
}

document.getElementById('vcf').addEventListener('change', async (e) => {
  if (!loggedIn()) { toast('Sign in first (login pill, bottom-right)'); e.target.value = ''; return }
  const files = [...e.target.files]
  e.target.value = ''
  if (!files.length) return
  try { const n = await importVcf(files); toast(`imported ${n}`); await render() }
  catch (err) { toast(String(err.message || err)) }
})

render()
document.addEventListener('xlogin', render)
document.addEventListener('xlogout', render)
