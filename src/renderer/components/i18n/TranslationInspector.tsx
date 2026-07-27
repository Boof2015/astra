import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { I18N_NAMESPACES } from '../../../shared/i18n/types'
import { checkMessage, lengthBudgetFor } from '../../../shared/i18n/rules'
import {
  INSPECT_KEY_ATTRIBUTE,
  PICK_MODIFIER_LABEL,
  hasPickModifier,
  translateLocale,
} from './inspectMode'
import { applyDraft, applyEdit, buildBundle, loadDraft, saveDraft, type Draft } from './translationDraft'
import { listSurfaces, subscribeToSurfaces, type TranslationSurface } from './translationSurfaces'

/**
 * The translation studio: point at any string in the running app, see what it is, and translate
 * it in place with the result landing in the real control immediately.
 *
 * Context comes from the same sidecars the offline workbench uses, loaded only in development so
 * it never reaches a packaged build.
 */

interface ContextEntry {
  text: string
  role: string
  screen: string
  run?: { text?: string; literal?: string; dynamic?: string; self?: boolean }[]
  placeholders?: Record<string, { expr?: string; example?: string }>
  sites?: string[]
  note?: string
}

type ContextByNamespace = Record<string, Record<string, ContextEntry>>

async function loadContext(): Promise<ContextByNamespace> {
  // Dev-only, and a dynamic import inside this branch on purpose: the sidecars are several times
  // the size of the catalogs, and a static import would drag every byte into the shipped bundle
  // for a tool no user can reach.
  if (!import.meta.env.DEV) return {}
  const entries = await Promise.all(
    I18N_NAMESPACES.map(async (namespace) => {
      try {
        const module = await import(`../../../shared/i18n/context/${namespace}.json`)
        return [namespace, module.default as Record<string, ContextEntry>] as const
      } catch {
        return [namespace, {} as Record<string, ContextEntry>] as const
      }
    })
  )
  return Object.fromEntries(entries)
}

const INSPECTED_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'] as const
const PANEL_POSITION_KEY = 'astra-i18n-studio-position'

function buildReverseLookup(context: ContextByNamespace): Map<string, string> {
  const lookup = new Map<string, string>()
  for (const namespace of I18N_NAMESPACES) {
    for (const [key, entry] of Object.entries(context[namespace] ?? {})) {
      if (entry.text && !lookup.has(entry.text)) lookup.set(entry.text, `${namespace}:${key}`)
    }
  }
  return lookup
}

function measure(node: Node): DOMRect {
  // `display: contents` elements have no box of their own; a Range over their contents does.
  // The same applies to a bare text node, which is how a string inside a button that also holds
  // an icon gets a box around the words rather than the whole control.
  const range = document.createRange()
  range.selectNodeContents(node)
  const rect = range.getBoundingClientRect()
  range.detach()
  if (rect.width || rect.height) return rect
  return node instanceof Element ? node.getBoundingClientRect() : rect
}

/** A rect that has scrolled out of the viewport must not be drawn at its old coordinates. */
function isOnScreen(rect: DOMRect): boolean {
  if (rect.width < 1 || rect.height < 1) return false
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
}

/** Catalog text was whitespace-collapsed at extraction, so rendered text must be too. */
function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The text node directly under the pointer.
 *
 * Walking up from `elementFromPoint` and comparing whole `textContent` only matches when a
 * container holds exactly one string and nothing else — a button with an icon beside its label
 * never matches, and when it does the highlight covers the entire control instead of the words.
 * Resolving to the caret's text node picks out the exact string being pointed at.
 */
function textNodeAtPoint(x: number, y: number): Text | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  // caretPositionFromPoint is the standard; caretRangeFromPoint is the older Chromium spelling.
  const position = doc.caretPositionFromPoint?.(x, y)
  if (position?.offsetNode?.nodeType === Node.TEXT_NODE) return position.offsetNode as Text
  const range = doc.caretRangeFromPoint?.(x, y)
  if (range?.startContainer?.nodeType === Node.TEXT_NODE) return range.startContainer as Text
  return null
}

interface Target {
  key: string
  /** The node this was resolved from, so the outline can follow it instead of a stale snapshot. */
  node: Node | null
  rect: DOMRect
  via?: string
}

interface Position {
  x: number
  y: number
}

function readPosition(): Position {
  try {
    const raw = localStorage.getItem(PANEL_POSITION_KEY)
    if (raw) return JSON.parse(raw) as Position
  } catch {
    // Fall through to the default corner.
  }
  return { x: Math.max(16, window.innerWidth - 420), y: 16 }
}

export default function TranslationInspector() {
  const { i18n } = useTranslation()
  const [context, setContext] = useState<ContextByNamespace>({})
  const [target, setTarget] = useState<Target | null>(null)
  const [preview, setPreview] = useState<Target | null>(null)
  const [draft, setDraft] = useState<Draft>(() => (translateLocale ? loadDraft(translateLocale) : {}))
  const [status, setStatus] = useState<string | null>(null)
  const [position, setPosition] = useState<Position>(readPosition)
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)
  const [sweepActive, setSweepActive] = useState(false)
  const [sweep, setSweep] = useState<{ rect: DOMRect; key: string }[]>([])
  const [surfaces, setSurfaces] = useState<TranslationSurface[]>([])
  const [showSurfaces, setShowSurfaces] = useState(false)
  const reverseLookup = useRef<Map<string, string>>(new Map())
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const dragOffset = useRef<Position | null>(null)

  useEffect(() => {
    void loadContext().then((loaded) => {
      setContext(loaded)
      reverseLookup.current = buildReverseLookup(loaded)
      if (translateLocale) applyDraft(i18n, translateLocale, loadDraft(translateLocale))
    })
  }, [i18n])

  useEffect(() => {
    setSurfaces(listSurfaces())
    return subscribeToSurfaces(() => setSurfaces(listSurfaces()))
  }, [])

  const sourceOf = useCallback(
    (qualified: string): ContextEntry | undefined => {
      const separator = qualified.indexOf(':')
      return context[qualified.slice(0, separator)]?.[qualified.slice(separator + 1)]
    },
    [context]
  )

  /**
   * Resolves the message under a point.
   *
   * Roughly half of Astra's strings reach the DOM through `translate()` rather than
   * <LocalizedText>, so they have no wrapper element to tag — a button whose label is
   * `{translate('…')}` is invisible to the tagged branch. Matching the rendered text back to its
   * key covers those, which is why "Import Playlist" was unreachable before.
   */
  const resolveAtPoint = useCallback((x: number, y: number): Target | null => {
    const element = document.elementFromPoint(x, y)
    if (!element || element.closest('.i18n-studio')) return null

    const tagged = element.closest(`[${INSPECT_KEY_ATTRIBUTE}]`)
    if (tagged) {
      const key = tagged.getAttribute(INSPECT_KEY_ATTRIBUTE)
      if (key) return { key, node: tagged, rect: measure(tagged) }
    }

    // Exact string under the caret first — same precision the sweep uses.
    const textNode = textNodeAtPoint(x, y)
    if (textNode) {
      const key = reverseLookup.current.get(normalizeText(textNode.textContent))
      if (key) return { key, node: textNode, rect: measure(textNode), via: 'text' }
    }

    for (let node: Element | null = element; node; node = node.parentElement) {
      const own = normalizeText(node.textContent)
      if (own && own.length < 200) {
        const key = reverseLookup.current.get(own)
        if (key) return { key, node, rect: measure(node), via: 'text' }
      }
      for (const attribute of INSPECTED_ATTRIBUTES) {
        const value = normalizeText(node.getAttribute(attribute))
        if (!value) continue
        const key = reverseLookup.current.get(value)
        if (key) return { key, node, rect: node.getBoundingClientRect(), via: attribute }
      }
    }
    return null
  }, [])

  // Picking is a modifier+click so the app stays completely usable with a plain click: you
  // navigate normally to reach a string, then hold the modifier to grab it without firing the
  // control underneath. Holding the modifier previews what a click would select, so you are
  // never guessing which of several nearby strings you are about to grab.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!hasPickModifier(event)) return
      const found = resolveAtPoint(event.clientX, event.clientY)
      if (!found) return
      event.preventDefault()
      event.stopPropagation()
      setTarget(found)
      setPreview(null)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }

    let frame = 0
    const onMove = (event: MouseEvent) => {
      if (!hasPickModifier(event)) {
        setPreview((current) => (current ? null : current))
        return
      }
      // One resolve per frame: pointer moves fire far faster than hit-testing needs to run.
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setPreview(resolveAtPoint(event.clientX, event.clientY)))
    }
    const onKeyUp = () => setPreview((current) => (current ? null : current))

    // Capture phase, so the control never sees the click at all.
    window.addEventListener('click', onClick, true)
    window.addEventListener('mousedown', onClick, true)
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onKeyUp)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('mousedown', onClick, true)
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onKeyUp)
    }
  }, [resolveAtPoint])

  /**
   * Keeps the selected string's outline pinned to the string itself.
   *
   * The rect captured when a string is picked is a snapshot: it does not move when the view
   * scrolls, does not follow a re-layout, and survives the element being unmounted entirely —
   * which leaves a rectangle hanging over whatever happens to be underneath it later. Re-deriving
   * the box from the live DOM is what makes it a highlight rather than a leftover.
   *
   * The cached node is reused while it is still attached; once it is gone the string is found
   * again by key, so the outline also survives React replacing the node as a translation is typed.
   */
  const locateRect = useCallback(
    (selected: Target): DOMRect | null => {
      if (selected.node && (selected.node as ChildNode).isConnected) return measure(selected.node)

      const tagged = document.querySelector(`[${INSPECT_KEY_ATTRIBUTE}="${CSS.escape(selected.key)}"]`)
      if (tagged) return measure(tagged)

      // Untagged strings are found by the text they currently render, which is the draft
      // translation once one has been typed — not the English it was picked by.
      const separator = selected.key.indexOf(':')
      const rendered = normalizeText(
        i18n.t(selected.key.slice(separator + 1), { ns: selected.key.slice(0, separator) })
      )
      if (!rendered) return null

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('.i18n-studio')) continue
        if (normalizeText(node.textContent) === rendered) return measure(node)
      }
      for (const element of document.querySelectorAll(`[${INSPECTED_ATTRIBUTES.join('],[')}]`)) {
        if (element.closest('.i18n-studio')) continue
        for (const attribute of INSPECTED_ATTRIBUTES) {
          if (normalizeText(element.getAttribute(attribute)) === rendered) return element.getBoundingClientRect()
        }
      }
      return null
    },
    [i18n]
  )

  useEffect(() => {
    if (!target) {
      setTargetRect(null)
      return undefined
    }
    let frame = 0
    const refresh = () => setTargetRect(locateRect(target))
    refresh()

    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(refresh)
    }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    // Catches the view changing under the selection: navigating away unmounts the string, and the
    // outline has to go with it rather than linger over whatever replaces it.
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [target, locateRect, draft])

  /**
   * Outlines every untranslated string currently on screen.
   *
   * Walking text nodes rather than tagged elements is deliberate: it finds `translate()` output
   * too, so the count reflects what is actually left on this screen instead of only the half the
   * studio can tag.
   */
  const runSweep = useCallback(() => {
    const found = new Map<string, { rect: DOMRect; key: string }>()
    const range = document.createRange()

    const consider = (key: string | undefined, rect: DOMRect) => {
      if (!key || draft[key] || found.has(key)) return
      if (!isOnScreen(rect)) return
      found.set(key, { rect, key })
    }

    // Measure the text node itself, never its parent. Every <LocalizedText> string is wrapped in
    // a `display: contents` span, which generates no box at all and reports 0x0 — measuring
    // parents silently dropped roughly half the strings on screen. A Range over the text also
    // gives tighter bounds than a parent that holds an icon and a label.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || parent.closest('.i18n-studio')) continue
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!text || text.length > 200) continue
      range.selectNodeContents(node)
      consider(reverseLookup.current.get(text), range.getBoundingClientRect())
    }

    // Tooltips and screen-reader labels render no text of their own, so they never appear in the
    // walk above and are the easiest strings in the app to forget entirely.
    for (const element of document.querySelectorAll(`[${INSPECTED_ATTRIBUTES.join('],[')}]`)) {
      if (element.closest('.i18n-studio')) continue
      for (const attribute of INSPECTED_ATTRIBUTES) {
        const value = element.getAttribute(attribute)?.trim()
        if (value) consider(reverseLookup.current.get(value), element.getBoundingClientRect())
      }
    }

    range.detach()
    setSweep([...found.values()])
  }, [draft])

  useEffect(() => {
    if (!sweepActive) {
      setSweep([])
      return undefined
    }
    // runSweep is rebuilt whenever the draft changes, so this also re-sweeps as strings get
    // translated and their outlines disappear.
    runSweep()

    // Scroll fires far faster than a full DOM walk can keep up with; coalesce to one per frame.
    let frame = 0
    const refresh = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => runSweep())
    }
    window.addEventListener('scroll', refresh, true)
    window.addEventListener('resize', refresh)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', refresh, true)
      window.removeEventListener('resize', refresh)
    }
  }, [sweepActive, runSweep])

  // Dragging keeps the panel wherever it is put. Docking and resizing the app was the
  // alternative and would change the wrapping and truncation being judged, which is the one
  // thing translating in place is for.
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragOffset.current) return
      const next = {
        x: Math.min(Math.max(0, event.clientX - dragOffset.current.x), window.innerWidth - 120),
        y: Math.min(Math.max(0, event.clientY - dragOffset.current.y), window.innerHeight - 40),
      }
      setPosition(next)
    }
    const onUp = () => {
      if (!dragOffset.current) return
      dragOffset.current = null
      try {
        localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify(position))
      } catch {
        // Position simply will not persist; the studio still works.
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [position])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTarget(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const total = useMemo(
    () => I18N_NAMESPACES.reduce((sum, namespace) => sum + Object.keys(context[namespace] ?? {}).length, 0),
    [context]
  )
  const done = useMemo(() => Object.values(draft).filter(Boolean).length, [draft])

  const onEdit = (value: string) => {
    if (!target || !translateLocale) return
    const next = { ...draft }
    if (value) next[target.key] = value
    else delete next[target.key]
    setDraft(next)
    if (!saveDraft(translateLocale, next)) setStatus('Could not save locally — export often.')
    applyEdit(i18n, translateLocale, target.key, value)
  }

  const onExport = () => {
    if (!translateLocale) return
    const bundle = buildBundle(translateLocale, draft, (key) => sourceOf(key)?.text)
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `astra-${translateLocale}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setStatus(`Exported ${done} translation(s).`)
    window.setTimeout(() => setStatus(null), 2600)
  }

  const entry = target ? sourceOf(target.key) : undefined
  const value = target ? draft[target.key] ?? '' : ''
  const report = entry && value ? checkMessage(entry.text, value, { role: entry.role }) : null
  const budget = entry ? lengthBudgetFor(entry.role, entry.text.length) : null

  return (
    <div className="i18n-studio">
      {sweep.map((item) => (
        <div
          key={item.key}
          className="i18n-studio-sweep"
          style={{ top: item.rect.top, left: item.rect.left, width: item.rect.width, height: item.rect.height }}
        />
      ))}

      {targetRect && isOnScreen(targetRect) ? (
        <div
          className="i18n-studio-outline"
          style={{ top: targetRect.top, left: targetRect.left, width: targetRect.width, height: targetRect.height }}
        />
      ) : null}

      {preview && preview.key !== target?.key ? (
        <div
          className="i18n-studio-preview"
          style={{ top: preview.rect.top, left: preview.rect.left, width: preview.rect.width, height: preview.rect.height }}
        >
          <span>{preview.key}</span>
        </div>
      ) : null}

      <div className="i18n-studio-panel" style={{ left: position.x, top: position.y }}>
        <div
          className="i18n-studio-grip"
          onMouseDown={(event) => {
            dragOffset.current = { x: event.clientX - position.x, y: event.clientY - position.y }
          }}
        >
          <strong>{translateLocale ? `→ ${translateLocale}` : 'Inspect'}</strong>
          {translateLocale ? <span className="i18n-studio-count">{done}{total ? ` / ${total}` : ''}</span> : null}
          <button
            type="button"
            className={sweepActive ? 'is-active' : undefined}
            onClick={() => setSweepActive((value) => !value)}
            title="Outline untranslated strings on this screen"
          >
            {sweepActive ? `${sweep.length} left` : 'Sweep'}
          </button>
          {surfaces.length > 0 ? (
            <button type="button" className={showSurfaces ? 'is-active' : undefined} onClick={() => setShowSurfaces((v) => !v)}>
              Open…
            </button>
          ) : null}
          {translateLocale ? <button type="button" onClick={onExport}>Export</button> : null}
        </div>

        {status ? <p className="i18n-studio-status">{status}</p> : null}

        {showSurfaces ? (
          <div className="i18n-studio-section">
            <h4>Force a surface open</h4>
            {surfaces.map((surface) => (
              <button key={surface.id} type="button" className="i18n-studio-surface" onClick={surface.open}>
                {surface.id}
              </button>
            ))}
          </div>
        ) : null}

        {!target ? (
          <p className="i18n-studio-meta">
            Hold <kbd>{PICK_MODIFIER_LABEL}</kbd> and click any string to translate it. The app works
            normally without the modifier. <kbd>Esc</kbd> clears the selection.
          </p>
        ) : (
          <>
            <div className="i18n-studio-head">
              <button type="button" onClick={() => void navigator.clipboard.writeText(target.key)} title="Copy key">
                {target.key}
              </button>
              {entry ? <span className="i18n-studio-badge">{entry.role}</span> : null}
              {target.via ? <span className="i18n-studio-badge">{target.via}</span> : null}
            </div>

            <p className="i18n-studio-source">{entry?.text ?? i18n.t(target.key, { lng: 'en' })}</p>
            {entry?.screen ? (
              <p className="i18n-studio-meta">{entry.screen}{budget ? ` · fits ~${budget} chars` : ''}</p>
            ) : null}

            {translateLocale ? (
              <>
                <textarea
                  ref={inputRef}
                  className={report?.errors.length ? 'is-invalid' : undefined}
                  value={value}
                  placeholder="Type the translation…"
                  onChange={(event) => onEdit(event.target.value)}
                  spellCheck
                />
                {report?.errors.map((message) => (
                  <p key={message} className="i18n-studio-error">{message}</p>
                ))}
                {report?.warnings.map((message) => (
                  <p key={message} className="i18n-studio-warning">{message}</p>
                ))}
              </>
            ) : null}

            {entry?.run?.length ? (
              <div className="i18n-studio-section">
                <h4>Reads in place as</h4>
                <p className="i18n-studio-run">
                  {entry.run.map((part, index) => {
                    if (part.literal !== undefined) return <span key={index}>{part.literal}</span>
                    if (part.dynamic !== undefined) {
                      return <span key={index} className="i18n-studio-slot">{part.dynamic || '…'}</span>
                    }
                    return part.self ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>
                  })}
                </p>
              </div>
            ) : null}

            {Object.entries(entry?.placeholders ?? {}).length > 0 ? (
              <div className="i18n-studio-section">
                <h4>Placeholders</h4>
                {Object.entries(entry?.placeholders ?? {}).map(([name, meta]) => (
                  <p key={name} className="i18n-studio-meta">
                    <code>{`{{${name}}}`}</code> ← {meta.example ?? meta.expr ?? 'a value'}
                  </p>
                ))}
              </div>
            ) : null}

            {entry?.note ? (
              <div className="i18n-studio-section">
                <h4>Note</h4>
                <p className="i18n-studio-note">{entry.note}</p>
              </div>
            ) : null}

            {entry?.sites?.length ? <p className="i18n-studio-file">{entry.sites[0]}</p> : null}
          </>
        )}
      </div>
    </div>
  )
}
