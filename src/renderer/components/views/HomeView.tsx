export default function HomeView() {
  return (
    <div className="home-view">
      <div className="home-placeholder">
        <div className="home-placeholder-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        </div>
        <h2>Home</h2>
        <p>Recently played, favorites, and more coming soon</p>
      </div>
    </div>
  )
}
