import { useUIStore } from '../../stores/uiStore'
import LibraryView from '../views/LibraryView'
import GraphView from '../views/GraphView'
import EQView from '../views/EQView'
import HomeView from '../views/HomeView'
import SettingsView from '../views/SettingsView'
import PlaylistView from '../views/PlaylistView'

export default function ViewRouter() {
  const activeView = useUIStore((s) => s.activeView)

  let content
  switch (activeView) {
    case 'home':
      content = <HomeView />
      break
    case 'library':
      content = <LibraryView />
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

  return <div className="app-view-transition-surface">{content}</div>
}
