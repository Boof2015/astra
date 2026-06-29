import { type ReactNode } from 'react'

export function highlightSearchMatch(
  text: string,
  query: string,
  className = 'search-highlight'
): ReactNode {
  if (!query) return text

  const normalizedText = text.toLowerCase()
  const normalizedQuery = query.toLowerCase().trim()
  if (!normalizedQuery) return text

  const substringIndex = normalizedText.indexOf(normalizedQuery)
  if (substringIndex >= 0) {
    return (
      <>
        {text.slice(0, substringIndex)}
        <mark className={className}>{text.slice(substringIndex, substringIndex + normalizedQuery.length)}</mark>
        {text.slice(substringIndex + normalizedQuery.length)}
      </>
    )
  }

  const parts: ReactNode[] = []
  let queryIndex = 0
  let lastPushed = 0

  for (let textIndex = 0; textIndex < text.length && queryIndex < normalizedQuery.length; textIndex += 1) {
    if (text[textIndex].toLowerCase() !== normalizedQuery[queryIndex]) continue

    if (textIndex > lastPushed) {
      parts.push(text.slice(lastPushed, textIndex))
    }
    parts.push(<mark key={textIndex} className={className}>{text[textIndex]}</mark>)
    queryIndex += 1
    lastPushed = textIndex + 1
  }

  if (lastPushed < text.length) {
    parts.push(text.slice(lastPushed))
  }

  return <>{parts}</>
}
