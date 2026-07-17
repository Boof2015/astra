import { useUIStore } from '../../stores/uiStore'
import LibraryView from '../views/LibraryView'
import GraphView from '../views/GraphView'
import EQView from '../views/EQView'
import HomeView from '../views/HomeView'
import SettingsView from '../views/SettingsView'
import PlaylistView from '../views/PlaylistView'
import StatsView from '../views/StatsView'

export default function ViewRouter() {
  const activeView = useUIStore((s) => s.activeView)
  const controllerEnabledView = activeView === 'home' || activeView === 'library' || activeView === 'stats' || activeView === 'playlist'

  let content
  switch (activeView) {
    case 'home':
      content = <HomeView />
      break
    case 'library':
      content = <LibraryView />
      break
    case 'stats':
      content = <StatsView />
      break
    case 'graph':
      content = <GraphView />
      break
    case 'eq':
      content = <EQView />
      break
    case 'settings':
      content = <SettingsView />
      break
    case 'playlist':
      content = <PlaylistView />
      break
    default:
      content = <HomeView />
  }

  return (
    <div
      className="app-view-transition-surface"
      data-controller-region={controllerEnabledView ? 'true' : undefined}
      data-controller-region-id={controllerEnabledView ? `view:${activeView}` : undefined}
      data-controller-exclude={controllerEnabledView ? undefined : 'true'}
    >
      {content}
    </div>
  )
}
