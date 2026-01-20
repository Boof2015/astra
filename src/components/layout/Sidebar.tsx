export default function Sidebar() {
  return (
    <aside className="sidebar glass-panel">
      <nav className="sidebar-nav">
        <div className="sidebar-section">
          <h3 className="sidebar-heading">Library</h3>
          <ul className="sidebar-list">
            <li>
              <button className="sidebar-item active">
                <span className="sidebar-icon">♫</span>
                <span>All Songs</span>
              </button>
            </li>
            <li>
              <button className="sidebar-item">
                <span className="sidebar-icon">◉</span>
                <span>Albums</span>
              </button>
            </li>
            <li>
              <button className="sidebar-item">
                <span className="sidebar-icon">☆</span>
                <span>Artists</span>
              </button>
            </li>
          </ul>
        </div>

        <div className="sidebar-section">
          <h3 className="sidebar-heading">Visualizers</h3>
          <ul className="sidebar-list">
            <li>
              <button className="sidebar-item">
                <span className="sidebar-icon">〜</span>
                <span>Oscilloscope</span>
              </button>
            </li>
            <li>
              <button className="sidebar-item">
                <span className="sidebar-icon">▮</span>
                <span>Spectrum</span>
              </button>
            </li>
          </ul>
        </div>

        <div className="sidebar-section">
          <h3 className="sidebar-heading">Audio</h3>
          <ul className="sidebar-list">
            <li>
              <button className="sidebar-item">
                <span className="sidebar-icon">≡</span>
                <span>Equalizer</span>
              </button>
            </li>
          </ul>
        </div>
      </nav>
    </aside>
  )
}
