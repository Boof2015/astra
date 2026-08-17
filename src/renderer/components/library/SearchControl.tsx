interface SearchControlProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
}

export default function SearchControl({ value, onChange, placeholder }: SearchControlProps) {
  return (
    <div className="search-container">
      <span className="search-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <input
        type="text"
        className="search-input"
        data-shortcut-search="true"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value.length > 0 && (
        <button
          type="button"
          className="search-clear-btn"
          aria-label="Clear search"
          title="Clear search"
          onClick={() => onChange('')}
        >
          ×
        </button>
      )}
    </div>
  )
}
