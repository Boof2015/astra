interface SearchEmptyStateProps {
  subject: string
  query: string
  fields: string
  onClear: () => void
  className?: string
}

export default function SearchEmptyState({
  subject,
  query,
  fields,
  onClear,
  className = ''
}: SearchEmptyStateProps) {
  return (
    <div className={`library-empty search-empty-state ${className}`.trim()}>
      <p aria-live="polite">No {subject} found for &ldquo;{query.trim()}&rdquo;.</p>
      <p className="empty-hint">Searches {fields}. Try fewer words.</p>
      <button type="button" className="settings-btn" onClick={onClear}>
        Clear search
      </button>
    </div>
  )
}
