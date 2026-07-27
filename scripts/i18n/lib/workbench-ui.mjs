/**
 * The workbench's stylesheet and application code, kept out of the generator so that editing the
 * UI does not mean editing a giant template literal.
 *
 * Everything here runs from a `file://` page with no network of any kind, so there are no
 * imports, no fonts to fetch and no build step — the generator inlines these two strings and the
 * validation rules into one self-contained HTML file.
 */

export const WORKBENCH_CSS = `
:root {
  color-scheme: dark;
  --bg: #0e0f13;
  --panel: #16181f;
  --panel-2: #1c1f28;
  --line: #2a2e3a;
  --text: #e6e8ee;
  --muted: #9aa1b1;
  --accent: #7aa2f7;
  --ok: #6bcf8e;
  --warn: #e0af68;
  --err: #f7768e;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
header {
  display: flex; align-items: center; gap: 16px;
  padding: 10px 16px; border-bottom: 1px solid var(--line);
  background: var(--panel); flex-wrap: wrap;
}
h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .01em; }
h1 small { color: var(--muted); font-weight: 400; margin-left: 6px; }
.progress { flex: 1; min-width: 160px; height: 6px; background: var(--panel-2); border-radius: 3px; overflow: hidden; }
.progress > i { display: block; height: 100%; background: var(--accent); transition: width .2s; }
.count { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
button, select, input[type=search] {
  background: var(--panel-2); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font: inherit;
}
button { cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); color: #0b0d12; border-color: var(--accent); font-weight: 600; }
main { flex: 1; display: grid; grid-template-columns: minmax(240px, 340px) 1fr; min-height: 0; }
#list { border-right: 1px solid var(--line); overflow-y: auto; background: var(--panel); }
/* Single line is load-bearing, not cosmetic: a screen name long enough to wrap makes two
   sticky headers overlap as one scrolls past the other. */
.group {
  padding: 8px 12px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--muted); position: sticky; top: 0; background: var(--panel);
  border-bottom: 1px solid var(--line);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row { padding: 7px 12px; cursor: pointer; border-left: 3px solid transparent; display: flex; gap: 8px; align-items: baseline; }
.row:hover { background: var(--panel-2); }
.row[aria-selected=true] { background: var(--panel-2); border-left-color: var(--accent); }
.row .src { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--line); }
.dot.done { background: var(--ok); }
.dot.review { background: var(--warn); }
.dot.error { background: var(--err); }
#detail { overflow-y: auto; padding: 20px 24px; }
#detail.empty { display: grid; place-items: center; color: var(--muted); }
.badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); }
.badge.role { border-color: var(--accent); color: var(--accent); }
.badge.review { border-color: var(--warn); color: var(--warn); }
.source {
  background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--accent);
  padding: 12px 14px; border-radius: 6px; font-size: 15px; white-space: pre-wrap; margin-bottom: 14px;
}
textarea {
  width: 100%; min-height: 96px; resize: vertical;
  background: var(--panel); color: var(--text); border: 1px solid var(--line);
  border-radius: 6px; padding: 12px 14px; font: inherit; font-size: 15px;
}
textarea:focus { outline: none; border-color: var(--accent); }
textarea.invalid { border-color: var(--err); }
.meta { margin-top: 18px; display: grid; gap: 14px; }
.meta section { border-top: 1px solid var(--line); padding-top: 12px; }
.meta h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 6px; font-weight: 600; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font-size: 12px; padding: 2px 8px; border-radius: 4px; background: var(--panel-2); border: 1px solid var(--line); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
td, th { text-align: left; padding: 4px 8px 4px 0; vertical-align: top; }
th { color: var(--muted); font-weight: 500; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--accent); }
.note { color: var(--text); background: var(--panel-2); border-left: 3px solid var(--warn); padding: 8px 12px; border-radius: 4px; }
.run {
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 12px 14px; font-size: 15px; line-height: 1.7; color: var(--muted);
}
.run mark { background: rgba(122,162,247,.22); color: var(--text); border-radius: 3px; padding: 1px 4px; font-weight: 600; }
.run .slot {
  display: inline-block; background: var(--panel-2); border: 1px dashed var(--line);
  border-radius: 3px; padding: 0 6px; font-size: 12px; color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.msgs { margin-top: 10px; display: grid; gap: 6px; }
.msg { font-size: 13px; padding: 8px 12px; border-radius: 6px; }
.msg.err { background: rgba(247,118,142,.12); border: 1px solid rgba(247,118,142,.4); color: var(--err); }
.msg.warn { background: rgba(224,175,104,.1); border: 1px solid rgba(224,175,104,.35); color: var(--warn); }
.hint { color: var(--muted); font-size: 12px; }
kbd { background: var(--panel-2); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 1px 5px; font-size: 11px; font-family: inherit; }
@media (max-width: 720px) { main { grid-template-columns: 1fr; } #list { max-height: 38vh; } }
`

export const WORKBENCH_JS = String.raw`
const STORE_KEY = 'astra-i18n-workbench-' + DATA.locale.code
const messages = DATA.messages
const draft = loadDraft()
let selectedIndex = messages.findIndex((m) => !draft[id(m)])
if (selectedIndex < 0) selectedIndex = 0

function id(message) { return message.ns + ':' + message.key }
function valueOf(message) { return draft[id(message)] ?? '' }

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {} } catch { return {} }
}
function saveDraft() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(draft)) }
  catch { status('Could not save locally — export often.', true) }
}

function validate(message) {
  const value = valueOf(message)
  if (!value) return { errors: [], warnings: [], empty: true }
  return checkMessage(message.text, value, { role: message.role })
}

function stateOf(message) {
  const value = valueOf(message)
  if (!value) return 'todo'
  const { errors } = validate(message)
  if (errors.length) return 'error'
  if (message.status === 'needs-review' || message.staleFrom) return 'review'
  return 'done'
}

const filterEl = document.getElementById('filter')
const searchEl = document.getElementById('search')

function visibleMessages() {
  const mode = filterEl.value
  const term = searchEl.value.trim().toLowerCase()
  return messages.filter((message) => {
    if (term
      && !message.text.toLowerCase().includes(term)
      && !message.key.toLowerCase().includes(term)
      && !valueOf(message).toLowerCase().includes(term)) return false
    const state = stateOf(message)
    if (mode === 'todo') return state === 'todo'
    if (mode === 'review') return state === 'review'
    if (mode === 'problem') return state === 'error' || validate(message).warnings.length > 0
    return true
  })
}

function renderList() {
  const list = document.getElementById('list')
  const visible = visibleMessages()
  let html = ''
  let group = null
  for (const message of visible) {
    if (message.screen !== group) {
      group = message.screen
      html += '<div class="group">' + escapeHtml(group) + '</div>'
    }
    const index = messages.indexOf(message)
    html += '<div class="row" role="option" data-index="' + index + '"'
      + ' aria-selected="' + (index === selectedIndex) + '">'
      + '<span class="dot ' + stateOf(message) + '"></span>'
      + '<span class="src">' + escapeHtml(message.text) + '</span></div>'
  }
  list.innerHTML = html || '<div class="group">Nothing matches</div>'
  const active = list.querySelector('[aria-selected=true]')
  if (active) active.scrollIntoView({ block: 'nearest' })
}

function renderProgress() {
  const done = messages.filter((message) => valueOf(message)).length
  document.getElementById('bar').style.width = (done / messages.length * 100) + '%'
  document.getElementById('count').textContent = done + ' / ' + messages.length + ' translated'
}

function renderDetail() {
  const detail = document.getElementById('detail')
  const message = messages[selectedIndex]
  if (!message) { detail.className = 'empty'; detail.textContent = 'Select a string'; return }
  detail.className = ''

  const { errors, warnings } = validate(message)
  const budget = lengthBudgetFor(message.role, message.text.length)
  const parts = []

  parts.push('<div class="badges">'
    + '<span class="badge role">' + escapeHtml(message.role) + '</span>'
    + '<span class="badge">' + escapeHtml(message.screen) + '</span>'
    + (budget ? '<span class="badge">fits ~' + budget + ' chars</span>' : '')
    + (message.status === 'needs-review' ? '<span class="badge review">needs review</span>' : '')
    + '<span class="badge"><code>' + escapeHtml(message.ns + ':' + message.key) + '</code></span>'
    + '</div>')

  if (message.staleFrom) {
    parts.push('<div class="note">The English changed after this was translated.<br>'
      + 'Was: ' + escapeHtml(message.staleFrom) + '</div>')
  }

  parts.push('<div class="source">' + escapeHtml(message.text) + '</div>')
  parts.push('<textarea id="entry" spellcheck="true" dir="' + DATA.locale.direction + '"'
    + (errors.length ? ' class="invalid"' : '') + '>' + escapeHtml(valueOf(message)) + '</textarea>')

  const msgs = errors.map((text) => '<div class="msg err">' + escapeHtml(text) + '</div>')
    .concat(warnings.map((text) => '<div class="msg warn">' + escapeHtml(text) + '</div>'))
  parts.push('<div class="msgs">' + msgs.join('') + '</div>')

  const meta = []
  if (message.note) meta.push('<section><h2>Note from the maintainers</h2><div class="note">' + escapeHtml(message.note) + '</div></section>')

  // The sentence this fragment is part of, with the fragment highlighted where it renders.
  // Without this a wrapped fragment like "/api/get" is unreadable on its own.
  if (message.run && message.run.length) {
    const rendered = message.run.map((part) => {
      if (part.literal !== undefined) return escapeHtml(part.literal)
      if (part.dynamic !== undefined) {
        return '<span class="slot">' + (part.dynamic ? escapeHtml(part.dynamic) : '&hellip;') + '</span>'
      }
      const text = escapeHtml(part.text)
      return part.self ? '<mark>' + text + '</mark>' : text
    }).join('')
    const fragments = message.run.filter((part) => part.text !== undefined).length
    meta.push('<section><h2>Reads in place as</h2><div class="run">' + rendered + '</div>'
      + '<p class="hint">This line is assembled from ' + fragments + ' separate strings. Your part is '
      + 'highlighted. Grey slots are values filled in at runtime. If your language needs a different '
      + 'word order than the English, say so — the sentence may need to be restructured in the code.</p>'
      + '</section>')
  }

  if (message.neighbours && message.neighbours.length) {
    meta.push('<section><h2>Appears next to</h2><div class="chips">'
      + message.neighbours.map((text) => '<span class="chip">' + escapeHtml(text) + '</span>').join('')
      + '</div></section>')
  }
  const placeholderNames = Object.keys(message.placeholders || {})
  if (placeholderNames.length) {
    meta.push('<section><h2>Placeholders</h2><table><tr><th>Name</th><th>Filled from</th><th>Example</th></tr>'
      + placeholderNames.map((name) => '<tr><td><code>{{' + escapeHtml(name) + '}}</code></td><td><code>'
        + escapeHtml(message.placeholders[name].expr || '') + '</code></td><td>'
        + escapeHtml(message.placeholders[name].example || '—') + '</td></tr>').join('')
      + '</table><p class="hint">Keep every placeholder exactly as written. You may reorder them.</p></section>')
  }
  if (message.sites && message.sites.length) {
    meta.push('<section><h2>Used in</h2><div class="chips">'
      + message.sites.map((site) => '<span class="chip">' + escapeHtml(site) + '</span>').join('')
      + '</div></section>')
  }
  meta.push('<section><p class="hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves and jumps to the next untranslated string.</p></section>')
  parts.push('<div class="meta">' + meta.join('') + '</div>')

  detail.innerHTML = parts.join('')

  const entry = document.getElementById('entry')
  entry.addEventListener('input', () => {
    const value = entry.value
    if (value) draft[id(message)] = value
    else delete draft[id(message)]
    saveDraft()
    renderProgress()
    renderRowState()
    renderMessages(message, entry)
  })
  entry.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      jumpToNextTodo()
    }
  })
  entry.focus()
}

// Re-render only the parts that change while typing; rebuilding the whole panel would drop
// focus and the caret position on every keystroke.
function renderMessages(message, entry) {
  const { errors, warnings } = validate(message)
  entry.classList.toggle('invalid', errors.length > 0)
  document.querySelector('.msgs').innerHTML =
    errors.map((text) => '<div class="msg err">' + escapeHtml(text) + '</div>')
      .concat(warnings.map((text) => '<div class="msg warn">' + escapeHtml(text) + '</div>')).join('')
}

function renderRowState() {
  const row = document.querySelector('.row[data-index="' + selectedIndex + '"]')
  if (row) row.querySelector('.dot').className = 'dot ' + stateOf(messages[selectedIndex])
}

function jumpToNextTodo() {
  const visible = visibleMessages()
  const start = visible.indexOf(messages[selectedIndex])
  const next = visible.slice(start + 1).find((message) => !valueOf(message)) ?? visible[start + 1]
  if (!next) { status('Nothing left in this filter.'); return }
  select(messages.indexOf(next))
}

function select(index) {
  selectedIndex = index
  renderList()
  renderDetail()
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ))
}

function status(text, sticky) {
  const el = document.getElementById('status')
  el.textContent = text
  if (!sticky) setTimeout(() => { if (el.textContent === text) el.textContent = '' }, 2600)
}

function setNested(target, path, value) {
  let cursor = target
  for (const segment of path.slice(0, -1)) {
    cursor[segment] = cursor[segment] || {}
    cursor = cursor[segment]
  }
  cursor[path[path.length - 1]] = value
}

/**
 * One file back to the maintainer: the translations plus the English each one was made from.
 * That second half is what lets the repo notice later that a translation went stale.
 */
function buildBundle() {
  const namespaces = {}
  const translatedFrom = {}
  for (const message of messages) {
    const value = valueOf(message)
    if (!value) continue
    namespaces[message.ns] = namespaces[message.ns] || {}
    translatedFrom[message.ns] = translatedFrom[message.ns] || {}
    setNested(namespaces[message.ns], message.key.split('.'), value)
    translatedFrom[message.ns][message.key] = message.text
  }
  return {
    astraTranslationBundle: 1,
    locale: DATA.locale,
    generatedAt: new Date().toISOString(),
    namespaces,
    translatedFrom,
  }
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

document.getElementById('list').addEventListener('click', (event) => {
  const row = event.target.closest('.row')
  if (row) select(Number(row.dataset.index))
})
filterEl.addEventListener('change', renderList)
searchEl.addEventListener('input', renderList)

document.getElementById('export').addEventListener('click', () => {
  const bundle = buildBundle()
  const done = Object.values(bundle.translatedFrom).reduce((sum, entries) => sum + Object.keys(entries).length, 0)
  if (done === 0) { status('Nothing translated yet.', true); return }
  download('astra-' + DATA.locale.code + '.json', JSON.stringify(bundle, null, 2))
  status('Exported ' + done + ' translation(s).')
})

document.getElementById('import').addEventListener('click', () => {
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.accept = 'application/json,.json'
  picker.addEventListener('change', () => {
    const file = picker.files && picker.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const bundle = JSON.parse(String(reader.result))
        let restored = 0
        const flatten = (value, prefix, out) => {
          if (typeof value === 'string') { out[prefix] = value; return }
          if (!value || typeof value !== 'object') return
          for (const key of Object.keys(value)) flatten(value[key], prefix ? prefix + '.' + key : key, out)
        }
        for (const ns of Object.keys(bundle.namespaces || {})) {
          const flat = {}
          flatten(bundle.namespaces[ns], '', flat)
          for (const key of Object.keys(flat)) { draft[ns + ':' + key] = flat[key]; restored += 1 }
        }
        saveDraft()
        select(selectedIndex)
        renderProgress()
        status('Restored ' + restored + ' translation(s).')
      } catch (error) {
        status('That file could not be read as a translation bundle.', true)
      }
    }
    reader.readAsText(file)
  })
  picker.click()
})

renderList()
renderProgress()
renderDetail()
`
