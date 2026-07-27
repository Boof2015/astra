/**
 * Component path -> the place a translator would recognise it by.
 *
 * Hand-maintained on purpose. A generated name ("TransportBar") tells a translator nothing;
 * "Transport bar (bottom of the main window)" tells them how much room the string has and what
 * it sits beside. When you add a component, add it here — run the app with `?locale=en-KEY` to
 * see exactly where an unmapped key surfaces.
 *
 * First match wins, so order from most specific to least.
 */
export const SCREEN_PATTERNS = [
  [/components\/views\/SettingsView/, 'Settings'],
  [/components\/settings\/SettingsTransferWizard/, 'Settings ▸ Transfer wizard'],
  [/components\/settings\/ChannelRoutingPanel/, 'Settings ▸ Audio ▸ Channel routing'],
  [/components\/settings\/DelayCompensationPanel/, 'Settings ▸ Audio ▸ Delay compensation'],
  [/components\/settings\/SpeakerStage/, 'Settings ▸ Audio ▸ Speaker stage'],
  [/components\/settings\/AudioOutputSelect/, 'Settings ▸ Audio ▸ Output device'],
  [/components\/settings\/BitPerfectModeWarningModal/, 'Settings ▸ Bit-perfect warning dialog'],
  [/components\/settings\/KeybindSettings/, 'Settings ▸ Keyboard shortcuts'],
  [/components\/settings\/FolderSettings/, 'Settings ▸ Music folders'],
  [/components\/settings\/RemoteServersPanel/, 'Settings ▸ Remote servers'],
  [/components\/settings\/LocalApiPairingModal/, 'Settings ▸ API pairing dialog'],
  [/components\/settings\/ConfirmActionModal/, 'Settings ▸ Confirmation dialog'],
  [/components\/settings\/SettingsSegmentedControl/, 'Settings ▸ segmented toggle'],

  [/components\/views\/LibraryView/, 'Library'],
  [/components\/views\/PlaylistView/, 'Playlists'],
  [/components\/views\/HomeView/, 'Home'],
  [/components\/views\/StatsView/, 'Listening stats'],
  [/components\/views\/GraphView/, 'Library graph'],
  [/components\/views\/EQView/, 'Equalizer'],

  [/components\/library\/LibraryIntegrityPanel/, 'Library ▸ Integrity panel'],
  [/components\/library\/TrackIntegrityResultModal/, 'Library ▸ Integrity result dialog'],
  [/components\/library\/TrackList/, 'Library ▸ Track list'],
  [/components\/library\/AlbumGrid/, 'Library ▸ Album grid'],
  [/components\/library\/ArtistList/, 'Library ▸ Artist list'],
  [/components\/library\/GenreGrid/, 'Library ▸ Genre grid'],
  [/components\/library\/YearGrid/, 'Library ▸ Year grid'],
  [/components\/library\/FolderTreeView/, 'Library ▸ Folder tree'],
  [/components\/library\/(AlbumArtwork|ArtistNameLinks)/, 'Library ▸ Track details'],

  [/components\/layout\/TransportBar/, 'Transport bar (bottom of the main window)'],
  [/components\/layout\/Sidebar/, 'Main navigation sidebar'],
  [/components\/layout\/InfoSidebar/, 'Now-playing info sidebar'],
  [/components\/layout\/TitleBar/, 'Window title bar'],
  [/components\/layout\/AnalyzerEditOverlay/, 'Analyzer edit overlay'],
  [/components\/layout\/AnalyzerDeck/, 'Analyzer deck'],
  [/components\/layout\/AudioPipelineShelf/, 'Transport bar ▸ Audio pipeline shelf'],
  [/components\/layout\/TransportLyricsShelf/, 'Transport bar ▸ Lyrics shelf'],
  [/components\/layout\/QuickLaunchPalette/, 'Quick launch palette (command bar)'],
  [/components\/layout\/FullscreenMode/, 'Fullscreen mode'],
  [/components\/layout\/Controller/, 'Controller (gamepad) overlay'],
  [/components\/layout\/Parallax/, 'Parallax ▸ pairing and presence'],
  [/components\/layout\/PhoneRemote|components\/layout\/PhoneSync/, 'Phone remote ▸ pairing'],
  [/components\/layout\/Zone/, 'Parallax ▸ Zones'],
  [/components\/layout\/(AssociatedOpenCue|DecodeFallbackCue|OutputDelayCue|UpdateAvailableCue)/, 'Transient notification cue'],
  [/components\/layout\/ViewRouter/, 'Main window'],

  [/components\/parallax\/ParallaxSetupFlow/, 'Parallax ▸ First-run setup'],
  [/components\/parallax\/ParallaxSettingsPanel/, 'Settings ▸ Parallax'],
  [/components\/parallax\/ParallaxManagementView/, 'Parallax ▸ Speaker management'],
  [/components\/parallax\//, 'Parallax'],

  [/components\/metadata\/MetadataEditorPanel/, 'Metadata editor'],
  [/components\/metadata\/DiffConfirmModal/, 'Metadata editor ▸ Confirm changes'],
  [/components\/lyrics\/LyricsEditorPanel/, 'Lyrics editor'],
  [/components\/lyrics\//, 'Lyrics'],
  [/components\/queue\//, 'Play queue'],
  [/components\/playlists\/DynamicPlaylistRuleEditor/, 'Playlists ▸ Dynamic rule editor'],
  [/components\/playlists\/CreatePlaylistModal/, 'Playlists ▸ Create dialog'],
  [/components\/playlists\//, 'Playlists'],
  [/components\/ratings\/RatingCalibrationLadder/, 'Ratings ▸ Calibration ladder'],
  [/components\/ratings\//, 'Ratings ▸ Star control'],
  [/components\/eq\//, 'Equalizer'],
  [/components\/mini\//, 'Mini player window'],
  [/components\/popout\/LyricsPopoutApp/, 'Lyrics popout window'],
  [/components\/popout\/ScopePopoutApp/, 'Visualizer popout window'],
  [/components\/visualizers\//, 'Visualizer panel'],
  [/components\/stats\//, 'Listening stats ▸ Share'],
  [/components\/signal\//, 'Astra Signal ▸ Share'],
  [/components\/sync\//, 'Phone sync ▸ Conflict resolver'],
  [/components\/player\/VolumeControl/, 'Transport bar ▸ Volume'],
  [/components\/player\//, 'Transport bar'],
  [/components\/activity\//, 'Activity indicator'],
  [/components\/i18n\//, 'Localization plumbing'],

  [/renderer\/App\.tsx/, 'Main window'],
  [/constants\/keyboardShortcuts/, 'Settings ▸ Keyboard shortcuts'],
  [/constants\/settingsSections/, 'Settings ▸ section names'],
  [/audio\/iamfDecodeWorker/, 'Playback ▸ Spatial audio decode errors'],
  [/audio\//, 'Playback ▸ Audio engine errors'],
  [/hooks\/useKeyboardShortcuts/, 'Settings ▸ Keyboard shortcuts'],
  [/hooks\//, 'Application state (surfaced in several places)'],
  [/stores\//, 'Application state (surfaced in several places)'],
  [/utils\//, 'Shared helper text'],
  [/^src\/main\//, 'Native dialogs and window titles'],
]

export function screenFor(relativePath) {
  const normalized = relativePath.split('\\').join('/')
  for (const [pattern, name] of SCREEN_PATTERNS) {
    if (pattern.test(normalized)) return name
  }
  return null
}
