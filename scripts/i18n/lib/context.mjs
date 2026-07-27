import ts from 'typescript'

/**
 * Derives translator context from the code that actually uses each message.
 *
 * This reads the current state of the source rather than hooking into extraction, because the
 * ~1,900 call sites already in the tree never pass through the extractor's rewrite path again.
 * Anything derived here therefore covers old and new sites identically.
 */

const ROLE_BY_ATTRIBUTE = {
  'aria-label': 'screen-reader',
  'aria-description': 'screen-reader',
  'aria-placeholder': 'placeholder',
  title: 'tooltip',
  placeholder: 'placeholder',
  alt: 'text',
}

const ROLE_BY_TAG = {
  button: 'button',
  a: 'link',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  summary: 'heading',
  legend: 'heading',
  label: 'label',
  option: 'menu-item',
  optgroup: 'menu-item',
  p: 'body',
  li: 'text',
  td: 'text',
  th: 'text',
}

/** Wrappers carry no meaning of their own, so the role walk passes straight through them. */
const TRANSPARENT_TAGS = new Set(['div', 'span', 'section', 'article', 'main', 'header', 'footer', 'nav', 'ul', 'ol', 'form', 'fieldset'])
const MAX_ROLE_WALK_DEPTH = 4

/** Every helper that resolves a catalog message at runtime. */
const TRANSLATE_FUNCTIONS = new Set(['translate', 't', 'mainT'])

/** Tags that wrap part of a sentence without breaking it. */
const INLINE_WRAPPER_TAGS = new Set(['code', 'strong', 'em', 'b', 'i', 'span', 'kbd', 'small', 'a', 'mark', 'u'])

function isTranslateCall(expression) {
  return ts.isCallExpression(expression)
    && ts.isIdentifier(expression.expression)
    && TRANSLATE_FUNCTIONS.has(expression.expression.text)
}

/**
 * A short, readable name for a value interpolated into a run.
 *
 * The raw source is worse than useless here: `{result?.summary.duplicateGroups ?? dupli}` is
 * noise to a translator and was being truncated mid-expression. What they need is "a value called
 * duplicateGroups appears here", so the run reads as a sentence with a slot in it.
 */
function describeExpression(expression) {
  const name = (node) => {
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node)) return node.name.text
    if (ts.isElementAccessExpression(node)) return name(node.expression)
    if (ts.isCallExpression(node)) {
      // A method call names the value in its receiver, not its method: `heatTilt.toFixed(1)`
      // is a heat tilt, not a "toFixed". A plain call keeps the function name.
      return ts.isPropertyAccessExpression(node.expression)
        ? name(node.expression.expression)
        : name(node.expression)
    }
    if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return name(node.expression)
    // `a ?? b` and `a || b` are fallbacks around one value; the left side is the real subject.
    if (ts.isBinaryExpression(node)) return name(node.left)
    return null
  }
  // A conditional or a branch that renders markup is not a value slot at all.
  if (ts.isConditionalExpression(expression)) return null
  const derived = name(expression)
  return derived && derived.length <= 24 ? derived : null
}

function nearestJsxContainer(node) {
  let current = node.parent
  while (current) {
    if (ts.isJsxElement(current) || ts.isJsxFragment(current)) return current
    current = current.parent
  }
  return null
}

/**
 * The nearest container that holds a whole run of text rather than part of one.
 *
 * A fragment wrapped in `<code>` or `<strong>` has that tag as its nearest container, which
 * contains only the fragment itself — composing from there would report every wrapped fragment
 * as a run of one and hide the very sentences worth showing. Inline tags are skipped so the run
 * is built from the enclosing block.
 */
function nearestRunContainer(node) {
  let current = nearestJsxContainer(node)
  while (
    current
    && ts.isJsxElement(current)
    && INLINE_WRAPPER_TAGS.has(current.openingElement.tagName.getText())
  ) {
    current = nearestJsxContainer(current)
  }
  return current
}

function readStringAttribute(openingElement, name) {
  for (const property of openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue
    if (property.initializer && ts.isStringLiteral(property.initializer)) return property.initializer.text
  }
  return null
}

/**
 * The element role a translator needs: is this a button that must stay narrow, a heading, or
 * body copy that can wrap? Generic wrappers are transparent so that the common
 * `<button><span>Label</span></button>` shape still reports "button".
 */
function roleFromContainer(container, sourceFile) {
  let current = container
  for (let depth = 0; current && depth < MAX_ROLE_WALK_DEPTH; depth += 1) {
    if (ts.isJsxElement(current)) {
      const opening = current.openingElement
      const explicitRole = readStringAttribute(opening, 'role')
      if (explicitRole === 'button') return 'button'
      if (explicitRole === 'heading') return 'heading'
      if (explicitRole === 'menuitem' || explicitRole === 'option') return 'menu-item'

      const tag = opening.tagName.getText(sourceFile)
      if (/^[a-z]/.test(tag) && !TRANSPARENT_TAGS.has(tag)) return ROLE_BY_TAG[tag] ?? 'text'
    }
    current = nearestJsxContainer(current)
  }
  return 'text'
}

/**
 * Rebuilds the full run of text a message sits inside, in document order.
 *
 * The extractor splits at every inline tag, so one sentence becomes several keys:
 * `<p>Astra appends <code>/api/get</code> and <code>/api/search</code>. HTTP is supported…</p>`
 * is five separate messages. Listing them as unordered neighbours tells a translator almost
 * nothing — they cannot see that these fragments are one sentence, in what order they render, or
 * where their own fragment falls inside it. Reassembling the run is the difference between
 * "/api/get, appears near 'and'" and seeing the actual sentence with your piece highlighted.
 *
 * Literal punctuation and whitespace are kept, because they are exactly what the extractor left
 * behind in the markup and what makes the reassembled sentence readable.
 */
function composeRun(container, sourceFile, selfNode) {
  if (!container) return []
  const parts = []

  const pushMessage = (node, wrap) => {
    const namespace = readStringAttribute(node, 'ns')
    const key = readStringAttribute(node, 'i18nKey')
    if (!namespace || !key) return
    parts.push({ namespace, key, wrap, self: node === selfNode })
  }

  const walkChild = (child, wrap) => {
    if (ts.isJsxText(child)) {
      const value = child.text.replace(/\s+/g, ' ')
      // Punctuation and spacing the extractor skipped still belong to the sentence.
      if (value.trim()) parts.push({ literal: value })
      else if (value && parts.length > 0) parts.push({ literal: ' ' })
      return
    }
    if (ts.isJsxSelfClosingElement(child)) {
      const tag = child.tagName.getText(sourceFile)
      if (tag === 'LocalizedText') pushMessage(child, wrap)
      return
    }
    if (ts.isJsxElement(child)) {
      const tag = child.openingElement.tagName.getText(sourceFile)
      // Only inline wrappers are transparent; a nested block is its own run.
      if (!INLINE_WRAPPER_TAGS.has(tag)) return
      for (const inner of child.children) walkChild(inner, tag)
      return
    }
    if (ts.isJsxExpression(child) && child.expression) {
      if (isTranslateCall(child.expression)) {
        const [first] = child.expression.arguments
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          const { namespace, key } = splitKey(first.text, 'common')
          parts.push({ namespace, key, wrap, self: child.expression === selfNode })
          return
        }
      }
      parts.push({ dynamic: describeExpression(child.expression) ?? '' })
    }
  }

  for (const child of container.children) walkChild(child, null)
  return parts
}

/** The attribute a node sits in, if any — `title={translate(...)}` is a tooltip, not body copy. */
function enclosingAttributeName(node) {
  let current = node.parent
  while (current) {
    if (ts.isJsxAttribute(current)) return current.name.getText()
    if (ts.isJsxElement(current) || ts.isJsxFragment(current) || ts.isJsxSelfClosingElement(current)) return null
    current = current.parent
  }
  return null
}

function splitKey(rawKey, defaultNamespace) {
  const separator = rawKey.indexOf(':')
  if (separator === -1) return { namespace: defaultNamespace, key: rawKey }
  return { namespace: rawKey.slice(0, separator), key: rawKey.slice(separator + 1) }
}

/**
 * The extractor already knew what expression fed each `{{placeholder}}` and threw it away.
 * Recovering it means a translator can see that `{{count}}` is `selectedTracks.length` rather
 * than guessing whether it is a count, an index, or a name.
 */
function placeholdersFromOptions(argument, sourceFile) {
  const result = {}
  if (!argument || !ts.isObjectLiteralExpression(argument)) return result
  for (const property of argument.properties) {
    if (ts.isPropertyAssignment(property)) {
      result[property.name.getText(sourceFile)] = {
        expr: property.initializer.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 120),
      }
    } else if (ts.isShorthandPropertyAssignment(property)) {
      result[property.name.getText(sourceFile)] = { expr: property.name.getText(sourceFile) }
    }
  }
  return result
}

/**
 * Finds every message reference in one file.
 *
 * Returns raw sites; the caller joins them against the catalogs, because the English text is
 * owned by the catalog and must never be re-derived from the source.
 */
export function collectSitesFromSource(relativePath, sourceText, defaultNamespace = 'common') {
  const scriptKind = relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind)
  const sites = []

  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

  const describeContainer = (node) => {
    const container = nearestJsxContainer(node)
    if (!container) return { containerId: null, parentContainerId: null, container: null }
    const parent = nearestJsxContainer(container)
    return {
      containerId: `${relativePath}#${container.pos}`,
      parentContainerId: parent ? `${relativePath}#${parent.pos}` : null,
      container,
    }
  }

  function visit(node) {
    // <LocalizedText ns="common" i18nKey="auto.foo.bar" />
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sourceFile) === 'LocalizedText') {
      const namespace = readStringAttribute(node, 'ns')
      const key = readStringAttribute(node, 'i18nKey')
      if (namespace && key) {
        const { containerId, parentContainerId, container } = describeContainer(node)
        sites.push({
          namespace,
          key,
          role: container ? roleFromContainer(container, sourceFile) : 'text',
          file: relativePath,
          line: lineOf(node),
          placeholders: {},
          containerId,
          parentContainerId,
          run: composeRun(nearestRunContainer(node), sourceFile, node),
        })
      }
    }

    // translate('common:foo'), t('settings:bar'), mainT('dialogs.baz')
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && TRANSLATE_FUNCTIONS.has(node.expression.text)) {
      const [first, second] = node.arguments
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        const { namespace, key } = splitKey(first.text, defaultNamespace)
        const attribute = enclosingAttributeName(node)
        const { containerId, parentContainerId, container } = describeContainer(node)
        const role = attribute
          ? ROLE_BY_ATTRIBUTE[attribute] ?? (container ? roleFromContainer(container, sourceFile) : 'text')
          : container
            ? roleFromContainer(container, sourceFile)
            : 'text'
        sites.push({
          namespace,
          key,
          role,
          file: relativePath,
          line: lineOf(node),
          placeholders: placeholdersFromOptions(second, sourceFile),
          containerId,
          parentContainerId,
          // Attribute values render alone; only visible children form a run.
          run: attribute ? [] : composeRun(nearestRunContainer(node), sourceFile, node),
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return sites
}

/**
 * Carries hand-written context forward across regeneration.
 *
 * Notes and placeholder examples are the only fields a human owns, and they are the whole point
 * of the sidecar — a machine can say a string is a button, but only a person can say "this is a
 * verb, not a noun". Everything else is re-derived every run. Mirrors the same instinct as
 * setNested() in extract-static-ui.mjs, which already refuses to silently overwrite a message.
 */
export function mergeContext(generated, existing = {}) {
  const merged = {}
  for (const [key, entry] of Object.entries(generated)) {
    const previous = existing[key]
    const next = { ...entry }
    if (previous?.note) next.note = previous.note
    if (previous?.status === 'needs-review') next.status = 'needs-review'
    for (const [name, meta] of Object.entries(next.placeholders ?? {})) {
      const previousExample = previous?.placeholders?.[name]?.example
      if (previousExample !== undefined) meta.example = previousExample
    }
    merged[key] = next
  }
  return merged
}

/** Stable key ordering so regeneration produces no incidental diff noise. */
export function sortObjectByKey(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
}
