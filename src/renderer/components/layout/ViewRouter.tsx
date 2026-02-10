import { useUIStore } from '../../stores/uiStore'
import LibraryView from '../views/LibraryView'
import EQView from '../views/EQView'
import HomeView from '../views/HomeView'
import SettingsView from '../views/SettingsView'

export default function ViewRouter() {
  const activeView = useUIStore((s) => s.activeView)

  switch (activeView) {
    case 'home':
      return <HomeView />
    case 'library':
      return <LibraryView />
    case 'eq':
      return <EQView />
    case 'settings':
      return <SettingsView />
    default:
      return <LibraryView />
  }
}
