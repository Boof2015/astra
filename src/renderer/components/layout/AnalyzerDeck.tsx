import VisualizerPanel from '../visualizers/VisualizerPanel'

export default function AnalyzerDeck() {
  return (
    <header className="analyzer-deck">
      <div className="analyzer-brand-rail">
        <div className="analyzer-brand-dot" />
        <div className="analyzer-brand-label">SIGNAL PATH</div>
        <div className="analyzer-brand-version">v2.4</div>
      </div>
      <div className="analyzer-visualizers">
        <VisualizerPanel />
      </div>
    </header>
  )
}
