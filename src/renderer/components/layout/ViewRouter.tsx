import { useUIStore } from '../../stores/uiStore'
import LibraryView from '../views/LibraryView'
import GraphView from '../views/GraphView'
import EQView from '../views/EQView'
import HomeView from '../views/HomeView'
import SettingsView from '../views/SettingsView'
import PlaylistView from '../views/PlaylistView'

export default function ViewRouter() {
  const activeView = useUIStore((s) => s.activeView)

  switch (activeView) {
    case 'home':
      return <HomeView />
    case 'library':
      return <LibraryView />
    case 'graph':
      return <GraphView />
    case 'eq':
      return <EQView />
    case 'settings':
      return <SettingsView />
    case 'playlist':
      return <PlaylistView />
    default:
      return <HomeView />
  }
}
