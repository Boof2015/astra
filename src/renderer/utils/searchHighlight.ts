import { createElement, Fragment, type ReactNode } from 'react'
import { findFuzzyMatch } from './fuzzySearch'

export function highlightSearchMatch(
  text: string,
  query: string,
  className = 'search-highlight'
): ReactNode {
  const match = findFuzzyMatch(query, text)
  if (!match || match.indices.length === 0) return text

  const matchedIndices = [...new Set(match.indices)].sort((left, right) => left - right)
  const parts: ReactNode[] = []
  let cursor = 0
  let groupStart = matchedIndices[0]
  let groupEnd = groupStart + 1

  const pushGroup = () => {
    if (groupStart > cursor) parts.push(text.slice(cursor, groupStart))
    parts.push(createElement(
      'mark',
      { key: groupStart, className },
      text.slice(groupStart, groupEnd)
    ))
    cursor = groupEnd
  }

  for (let index = 1; index < matchedIndices.length; index += 1) {
    const textIndex = matchedIndices[index]
    if (textIndex === groupEnd) {
      groupEnd += 1
      continue
    }
    pushGroup()
    groupStart = textIndex
    groupEnd = textIndex + 1
  }

  pushGroup()
  if (cursor < text.length) parts.push(text.slice(cursor))

  return createElement(Fragment, null, ...parts)
}
