import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import LocalizedText from '../i18n/LocalizedText'
import FolderSettings from '../settings/FolderSettings'
import AudioOutputSelect from '../settings/AudioOutputSelect'
import ChannelRoutingPanel from '../settings/ChannelRoutingPanel'
import DelayCompensationPanel from '../settings/DelayCompensationPanel'
import ConfirmActionModal from '../settings/ConfirmActionModal'
import BitPerfectModeWarningModal from '../settings/BitPerfectModeWarningModal'
import LocalApiPairingModal from '../settings/LocalApiPairingModal'
import KeybindSettings from '../settings/KeybindSettings'
import SettingsTransferWizard from '../settings/SettingsTransferWizard'
import SettingsSegmentedControl, { type SettingsSegmentedOption } from '../settings/SettingsSegmentedControl'
import { renderPairingQrSvg } from '../../utils/pairingQr'
import { usePresence } from '../../hooks/usePresence'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import {
  DEFAULT_UI_SCALE_PERCENT,
  DEFAULT_JUMP_TO_PLAYING_DESTINATION,
  MAX_UI_SCALE_PERCENT,
  MIN_UI_SCALE_PERCENT,
  UI_SCALE_STEP_PERCENT,
  useUIStore,
  type HomeGreetingTextMode,
  type JumpToPlayingDestination,
  type TransportInfoLineMode
} from '../../stores/uiStore'
import {
  BIT_PERFECT_DSP_DISABLED_MESSAGE,
  DEFAULT_NORMALIZATION_TARGET_LUFS,
  useAudioSettingsStore,
  type ReplayGainMode
} from '../../stores/audioSettingsStore'
import { useVisualizerSettingsStore } from '../../stores/visualizerSettingsStore'
import {
  DISCORD_PAUSE_CLEAR_MINUTE_PRESETS,
  useDiscordSettingsStore,
  type DiscordRpcCompactStatusMode,
  type DiscordRpcExpandedInfoMode,
  type DiscordRpcLinkDestination,
} from '../../stores/discordSettingsStore'
import { useLocalApiSettingsStore } from '../../stores/localApiSettingsStore'
import { usePhoneRemoteSettingsStore } from '../../stores/phoneRemoteSettingsStore'
import { useParallaxStore } from '../../stores/parallaxStore'
import { useLastFmSettingsStore } from '../../stores/lastFmSettingsStore'
import { useLyricsStore } from '../../stores/lyricsStore'
import { useLyricsDisplaySettingsStore } from '../../stores/lyricsDisplaySettingsStore'
import { useUpdateStore } from '../../stores/updateStore'
import { useDiagnosticsStore } from '../../stores/diagnosticsStore'
import { useGraphStore } from '../../stores/graphStore'
import { useListeningStatsStore } from '../../stores/listeningStatsStore'
import { useLibraryIntegrityStore } from '../../stores/libraryIntegrityStore'
import { useRatingsStore } from '../../stores/ratingsStore'
import RemoteServersPanel from '../settings/RemoteServersPanel'
import {
  SLEEP_TIMER_MAX_MINUTES,
  SLEEP_TIMER_MIN_MINUTES,
  SLEEP_TIMER_PRESET_MINUTES,
  useSleepTimerStore
} from '../../stores/sleepTimerStore'
import { SETTINGS_SECTIONS, type SettingsSectionId } from '../../constants/settingsSections'
import {
  DEFAULT_THEME_ACCENT,
  THEME_PRESET_LIST,
  useThemeStore,
  type AccentSource,
  type CoverArtAccentMethod,
  type ThemePresetId
} from '../../stores/themeStore'
import {
  factoryResetApplication,
  resetAllSettings,
  resetAudioSettings,
  resetDiscordCoverArtCache,
  resetEqSettings,
  resetIntegrationSettings,
  resetMappedFolders,
  resetThemeSettings,
  resetTrackRatings,
} from '../settings/resetActions'
import type { MiniPlayerVisualizerMode } from '../../../types/miniPlayer'
import {
  LOCAL_API_DEFAULT_PORT,
  LOCAL_API_MAX_PORT,
  LOCAL_API_MIN_PORT
} from '../../../types/localApi'
import {
  PHONE_REMOTE_DEFAULT_PORT,
  PHONE_REMOTE_MAX_PORT,
  PHONE_REMOTE_MIN_PORT
} from '../../../types/phoneRemote'
import type { LastFmProfileStatus, LastFmScrobbleProtocol } from '../../../types/lastFm'
import { LRCLIB_OFFICIAL_BASE_URL } from '../../../types/lyrics'
import type { AppBuildInfo } from '../../../types/appBuildInfo'
import type { CompanionApiScope } from '../../../types/companionApi'
import ParallaxSettingsPanel from '../parallax/ParallaxSettingsPanel'
import { formatLocaleDate, getDisplayLanguageOptions, setDisplayLanguage, translate, translateSourceText } from '../../i18n'
import { useTranslationSurface } from '../i18n/translationSurfaces'

type ResetActionId =
  | 'reset-theme'
  | 'reset-audio'
  | 'reset-integrations'
  | 'reset-discord-cover-art-cache'
  | 'reset-eq'
  | 'reset-all'
  | 'reset-ratings'
  | 'reset-listening-history'
  | 'reset-folders'
  | 'factory-reset'

type ResetActionState = 'idle' | 'running' | 'success' | 'error'
type NormalizationDisableStep = 'warning' | 'final' | null
type ReplayGainSelectorValue = ReplayGainMode | 'disabled'
const NORMALIZATION_TARGET_MIN_LUFS = -30
const NORMALIZATION_TARGET_MAX_LUFS = 0

const CUSTOM_SCROBBLE_PROTOCOLS: LastFmScrobbleProtocol[] = ['lastfm2', 'audioscrobbler', 'listenbrainz']

function getScrobbleProtocolLabel(protocol: LastFmScrobbleProtocol): string {
  if (protocol === 'audioscrobbler') return 'AudioScrobbler'
  if (protocol === 'listenbrainz') return 'ListenBrainz'
  return 'Last.fm 2.0'
}

const ACCENT_SOURCE_OPTIONS: readonly SettingsSegmentedOption<AccentSource>[] = [
  { value: 'theme', label: 'Theme Accent' },
  { value: 'cover-art', label: 'Cover Art' },
]

const COVER_ART_ACCENT_METHOD_OPTIONS: readonly SettingsSegmentedOption<CoverArtAccentMethod>[] = [
  { value: 'dominant', label: 'Dominant' },
  { value: 'vibrant', label: 'Vibrant' },
  { value: 'average', label: 'Average' },
]

const HOME_GREETING_TEXT_OPTIONS: readonly SettingsSegmentedOption<HomeGreetingTextMode>[] = [
  { value: 'messages', label: 'Messages' },
  { value: 'clock', label: 'Clock' },
  { value: 'off', label: 'Off' },
]

const TRANSPORT_INFO_LINE_OPTIONS: readonly SettingsSegmentedOption<TransportInfoLineMode>[] = [
  { value: 'output', label: 'Output Device' },
  { value: 'album', label: 'Album' },
  { value: 'hidden', label: 'Hidden' },
]

const REPLAYGAIN_OPTIONS: readonly SettingsSegmentedOption<ReplayGainSelectorValue>[] = [
  { value: 'disabled', label: 'Disabled' },
  { value: 'auto', label: 'Auto' },
  { value: 'track', label: 'Track' },
  { value: 'album', label: 'Album' },
]

const MINI_PLAYER_VISUALIZER_OPTIONS: readonly SettingsSegmentedOption<MiniPlayerVisualizerMode>[] = [
  { value: 'off', label: 'Off' },
  { value: 'oscilloscope', label: 'Oscilloscope' },
  { value: 'spectrum', label: 'Spectrum' },
]

const JUMP_TO_PLAYING_OPTIONS: readonly SettingsSegmentedOption<JumpToPlayingDestination>[] = [
  { value: 'smart-source', label: 'Smart Source' },
  { value: 'library-tracks', label: 'Library Tracks' },
  { value: 'album', label: 'Album' },
  { value: 'artist', label: 'Artist' },
  { value: 'queue', label: 'Queue' },
]

const DISCORD_COMPACT_STATUS_OPTIONS: readonly SettingsSegmentedOption<DiscordRpcCompactStatusMode>[] = [
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
]

const DISCORD_EXPANDED_INFO_OPTIONS: readonly SettingsSegmentedOption<DiscordRpcExpandedInfoMode>[] = [
  { value: 'file-info', label: 'File Info' },
  { value: 'album', label: 'Album' },
]

const DISCORD_LINK_DESTINATION_OPTIONS: readonly SettingsSegmentedOption<DiscordRpcLinkDestination>[] = [
  { value: 'ytmusic', label: 'YT Music' },
  { value: 'lastfm', label: 'Last.fm' },
  { value: 'off', label: 'Off' },
]

const DISCORD_PAUSE_CLEAR_OPTIONS: readonly SettingsSegmentedOption<number>[] = DISCORD_PAUSE_CLEAR_MINUTE_PRESETS.map(
  (minutes) => ({ value: minutes, label: minutes === 0 ? 'Off' : `${minutes}m` })
)

const CUSTOM_SCROBBLE_PROTOCOL_OPTIONS: readonly SettingsSegmentedOption<LastFmScrobbleProtocol>[] = CUSTOM_SCROBBLE_PROTOCOLS.map(
  (protocol) => ({ value: protocol, label: getScrobbleProtocolLabel(protocol) })
)

function getDefaultScrobbleProfileName(protocol: LastFmScrobbleProtocol): string {
  if (protocol === 'audioscrobbler') return 'AudioScrobbler endpoint'
  if (protocol === 'listenbrainz') return 'ListenBrainz endpoint'
  return 'Custom endpoint'
}

function getScrobbleUrlPlaceholder(protocol: LastFmScrobbleProtocol): string {
  if (protocol === 'audioscrobbler') return 'http://localhost:42010/apis/audioscrobbler_legacy'
  if (protocol === 'listenbrainz') return 'http://localhost:42010/apis/listenbrainz'
  return 'http://localhost:9078/2.0/'
}

function getScrobbleUsernameLabel(protocol: LastFmScrobbleProtocol): string {
  if (protocol === 'listenbrainz') return 'Username Label (optional)'
  return 'Username Label'
}

function getScrobbleSecretLabel(protocol: LastFmScrobbleProtocol): string {
  if (protocol === 'audioscrobbler') return 'Password or API Key'
  if (protocol === 'listenbrainz') return 'Auth Token'
  return 'Session Key or Token'
}

function isScrobbleUsernameRequired(protocol: LastFmScrobbleProtocol): boolean {
  return protocol !== 'listenbrainz'
}

interface ResetActionStatus {
  state: ResetActionState
  message: string
}

interface ResetActionDefinition {
  id: ResetActionId
  title: string
  description: string
  buttonLabel: string
  confirmTitle: string
  confirmMessage: string
  confirmLabel: string
  destructive: boolean
  typedPhrase?: string
  disabled?: boolean
  run: () => Promise<string | void>
}

const RESET_ACTION_IDS: ResetActionId[] = [
  'reset-theme',
  'reset-audio',
  'reset-integrations',
  'reset-discord-cover-art-cache',
  'reset-eq',
  'reset-all',
  'reset-ratings',
  'reset-listening-history',
  'reset-folders',
  'factory-reset',
]

const ASTRA_REPOSITORY_URL = 'https://github.com/Boof2015/astra'
const ASTRA_DISCORD_URL = 'https://discord.gg/hsKK8Kr9Nj'
const ASTRA_SUPPORT_URL = 'https://ko-fi.com/boof2015'
const ASTRA_LICENSE_URL = 'https://github.com/Boof2015/astra/blob/main/LICENSE'
const GPL_V3_URL = 'https://www.gnu.org/licenses/gpl-3.0.html'
const BIT_PERFECT_WARNING_DISMISSED_STORAGE_KEY = 'astra-bitperfect-warning-dismissed-v1'
const DEVELOPER_SETTINGS_VISIBILITY_STORAGE_KEY = 'astra-settings-developer-section-visible-v1'
const DEVELOPER_SETTINGS_SECTION_ID: SettingsSectionId = 'developer'
const DEVELOPER_SETTINGS_REVEAL_CLICK_TARGET = 7
const DEVELOPER_SETTINGS_REVEAL_RESET_MS = 2500

function buildInitialResetStatusMap(): Record<ResetActionId, ResetActionStatus> {
  return RESET_ACTION_IDS.reduce((acc, actionId) => {
    acc[actionId] = { state: 'idle', message: '' }
    return acc
  }, {} as Record<ResetActionId, ResetActionStatus>)
}

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim()
  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(trimmed)
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('')
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }

  const fullMatch = /^#([0-9a-fA-F]{6})$/.exec(trimmed)
  if (!fullMatch) return null
  return `#${fullMatch[1].toLowerCase()}`
}

function formatSleepTimerRemaining(remainingMs: number): string {
  const safeMs = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0
  const totalSeconds = Math.max(0, Math.ceil(safeMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function parseSleepTimerMinutesInput(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed)) return null
  if (parsed < SLEEP_TIMER_MIN_MINUTES || parsed > SLEEP_TIMER_MAX_MINUTES) return null
  return parsed
}

function formatNormalizationTargetLufs(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function parseNormalizationTargetLufsInput(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return null
  if (parsed < NORMALIZATION_TARGET_MIN_LUFS || parsed > NORMALIZATION_TARGET_MAX_LUFS) return null
  return Math.round(parsed * 10) / 10
}

function readDeveloperSectionVisibilityPreference(): boolean {
  try {
    return localStorage.getItem(DEVELOPER_SETTINGS_VISIBILITY_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistDeveloperSectionVisibilityPreference(visible: boolean): void {
  try {
    localStorage.setItem(DEVELOPER_SETTINGS_VISIBILITY_STORAGE_KEY, visible ? '1' : '0')
  } catch {
    // Ignore storage failures and continue with in-memory visibility.
  }
}

function formatBuildLabel(buildInfo: AppBuildInfo): string {
  const shortCommitHash = buildInfo.shortCommitHash ?? buildInfo.commitHash?.slice(0, 7)
  if (!shortCommitHash) return ''
  return `${shortCommitHash}${buildInfo.isDirty ? '*' : ''}`
}

function formatBuildCopyValue(buildInfo: AppBuildInfo): string {
  return buildInfo.commitHash ?? ''
}

function formatBuildTooltip(buildInfo: AppBuildInfo): string | undefined {
  if (!buildInfo.commitHash) return undefined
  return `Commit: ${buildInfo.commitHash}${buildInfo.isDirty ? '\nWorking tree was dirty when this build started.' : ''}\nClick to copy the full commit hash.`
}

export default function SettingsView() {
  const { t, i18n } = useTranslation(['settings', 'common'])
  const displayLanguageOptions = getDisplayLanguageOptions()
  const displayLanguage = i18n.resolvedLanguage ?? i18n.language
  const [showFolderSettings, setShowFolderSettings] = useState(false)
  const [pendingResetId, setPendingResetId] = useState<ResetActionId | null>(null)
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id)
  const [developerSectionVisible, setDeveloperSectionVisible] = useState(() => readDeveloperSectionVisibilityPreference())
  const [appVersionLabel, setAppVersionLabel] = useState('Loading...')
  const [appBuildLabel, setAppBuildLabel] = useState('')
  const [appBuildTooltip, setAppBuildTooltip] = useState('')
  const [appBuildCopyValue, setAppBuildCopyValue] = useState('')
  const [localApiSelectedPairingBaseUrl, setLocalApiSelectedPairingBaseUrl] = useState('')
  const [localApiPairingModalOpen, setLocalApiPairingModalOpen] = useState(false)
  const [settingsTransferWizardOpen, setSettingsTransferWizardOpen] = useState(false)

  // Studio surfaces: these dialogs hold a lot of copy and are awkward to reach by hand, so the
  // translation studio can open them on demand. No-ops outside studio mode.
  useTranslationSurface('Settings ▸ Transfer wizard', () => setSettingsTransferWizardOpen(true))
  useTranslationSurface('Settings ▸ API pairing dialog', () => setLocalApiPairingModalOpen(true))
  const [showInlinePhoneQr, setShowInlinePhoneQr] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [resetStatuses, setResetStatuses] = useState<Record<ResetActionId, ResetActionStatus>>(
    () => buildInitialResetStatusMap()
  )
  const { rescan, forceRescanAll, backfillReplayGainMetadata, isScanning, isCancelingScan, cancelScan, scanProgress, scanStage } = useLibraryStore()
  const {
    presetId,
    customAccent,
    accentSource,
    coverArtAccentMethod,
    resolvedTokens,
    setPreset,
    setCustomAccent,
    usePresetAccent,
    setAccentSource,
    setCoverArtAccentMethod,
    resetToDefault: resetThemeToDefault,
  } = useThemeStore()
  const {
    isRunning,
    setIsRunning,
  } = useVisualizerSettingsStore()
  const replayGainScanEnabled = useAudioSettingsStore((state) => state.replayGainScanEnabled)
  const setReplayGainScanEnabled = useAudioSettingsStore((state) => state.setReplayGainScanEnabled)
  const replayGainMode = useAudioSettingsStore((state) => state.replayGainMode)
  const setReplayGainMode = useAudioSettingsStore((state) => state.setReplayGainMode)
  const normalizationEnabled = useAudioSettingsStore((state) => state.normalizationEnabled)
  const setNormalizationEnabled = useAudioSettingsStore((state) => state.setNormalizationEnabled)
  const normalizationTargetLufs = useAudioSettingsStore((state) => state.normalizationTargetLufs)
  const setNormalizationTargetLufs = useAudioSettingsStore((state) => state.setNormalizationTargetLufs)
  const playbackOutputMode = useAudioSettingsStore((state) => state.playbackOutputMode)
  const setPlaybackOutputMode = useAudioSettingsStore((state) => state.setPlaybackOutputMode)
  const disableGaplessPrebufferDev = useAudioSettingsStore((state) => state.disableGaplessPrebufferDev)
  const setDisableGaplessPrebufferDev = useAudioSettingsStore((state) => state.setDisableGaplessPrebufferDev)
  const disableStandardAnalysisGraphDev = useAudioSettingsStore((state) => state.disableStandardAnalysisGraphDev)
  const setDisableStandardAnalysisGraphDev = useAudioSettingsStore((state) => state.setDisableStandardAnalysisGraphDev)
  const nativeAudioCapabilities = useAudioSettingsStore((state) => state.nativeAudioCapabilities)
  const playbackModeStatusMessage = useAudioSettingsStore((state) => state.playbackModeStatusMessage)
  const showTracklistBpmKey = useLibraryStore((state) => state.showTracklistBpmKey)
  const setShowTracklistBpmKey = useLibraryStore((state) => state.setShowTracklistBpmKey)
  const showTracklistGenre = useLibraryStore((state) => state.showTracklistGenre)
  const setShowTracklistGenre = useLibraryStore((state) => state.setShowTracklistGenre)
  const showTracklistAddedDate = useLibraryStore((state) => state.showTracklistAddedDate)
  const setShowTracklistAddedDate = useLibraryStore((state) => state.setShowTracklistAddedDate)
  const showTracklistPlayCount = useLibraryStore((state) => state.showTracklistPlayCount)
  const setShowTracklistPlayCount = useLibraryStore((state) => state.setShowTracklistPlayCount)
  const artistBrowseMode = useLibraryStore((state) => state.artistBrowseMode)
  const setArtistBrowseMode = useLibraryStore((state) => state.setArtistBrowseMode)
  const {
    enabled: discordEnabled,
    coverArtEnabled: discordCoverArtEnabled,
    smallIconEnabled: discordSmallIconEnabled,
    compactStatusMode: discordCompactStatusMode,
    expandedInfoMode: discordExpandedInfoMode,
    linkDestination: discordLinkDestination,
    pauseClearMinutes: discordPauseClearMinutes,
    statusMessage: discordStatusMessage,
    setEnabled: setDiscordEnabled,
    setCoverArtEnabled: setDiscordCoverArtEnabled,
    setSmallIconEnabled: setDiscordSmallIconEnabled,
    setCompactStatusMode: setDiscordCompactStatusMode,
    setExpandedInfoMode: setDiscordExpandedInfoMode,
    setLinkDestination: setDiscordLinkDestination,
    setPauseClearMinutes: setDiscordPauseClearMinutes,
  } = useDiscordSettingsStore()
  const {
    status: localApiStatus,
    errorMessage: localApiErrorMessage,
    init: initLocalApi,
    setEnabled: setLocalApiEnabled,
    setControlsEnabled: setLocalApiControlsEnabled,
    setLibrarySearchEnabled: setLocalApiLibrarySearchEnabled,
    setLibraryWriteEnabled: setLocalApiLibraryWriteEnabled,
    setPort: setLocalApiPort,
    rotateToken: rotateLocalApiToken,
  } = useLocalApiSettingsStore()
  const {
    status: phoneRemoteStatus,
    pairedDevices: phoneRemotePairedDevices,
    pendingPairingRequests: phoneRemotePendingPairingRequests,
    activePairingTicket: phoneRemoteActivePairingTicket,
    errorMessage: phoneRemoteErrorMessage,
    init: initPhoneRemote,
    setEnabled: setPhoneRemoteEnabled,
    setPort: setPhoneRemotePort,
    setSyncEnabled: setPhoneRemoteSyncEnabled,
    requestSync: requestPhoneRemoteSync,
    openSyncConflictResolver: openPhoneSyncConflictResolver,
    createPairingTicket: createPhoneRemotePairingTicket,
    clearActivePairingTicket: clearPhoneRemoteActivePairingTicket,
    approvePairingRequest: approvePhoneRemotePairingRequest,
    rejectPairingRequest: rejectPhoneRemotePairingRequest,
    revokePairedDevice: revokePhoneRemotePairedDevice,
    revokeAllPairedDevices: revokeAllPhoneRemotePairedDevices
  } = usePhoneRemoteSettingsStore()
  const {
    status: lastFmStatus,
    isAuthorizing: lastFmIsAuthorizing,
    errorMessage: lastFmErrorMessage,
    authHint: lastFmAuthHint,
    setEnabled: setLastFmEnabled,
    createCustomProfile: createLastFmCustomProfile,
    updateCustomProfile: updateLastFmCustomProfile,
    deleteCustomProfile: deleteLastFmCustomProfile,
    setProfileEnabled: setLastFmProfileEnabled,
    beginAuth: beginLastFmAuth,
    disconnectProfile: disconnectLastFmProfile,
  } = useLastFmSettingsStore()
  const {
    status: lyricsStatus,
    errorMessage: lyricsErrorMessage,
    setEnabled: setLyricsEnabled,
    setLrclibBaseUrl: setLyricsLrclibBaseUrl,
  } = useLyricsStore()
  const lyricsDisplaySettings = useLyricsDisplaySettingsStore((state) => state.settings)
  const setLyricsWordTimingEnabled = useLyricsDisplaySettingsStore((state) => state.setWordTimingEnabled)
  const setLyricsFuriganaEnabled = useLyricsDisplaySettingsStore((state) => state.setFuriganaEnabled)
  const setLyricsTranslationsEnabled = useLyricsDisplaySettingsStore((state) => state.setTranslationsEnabled)
  const setLyricsTranslationLanguagePriority = useLyricsDisplaySettingsStore((state) => state.setTranslationLanguagePriority)
  const setLyricsVoiceLabelsEnabled = useLyricsDisplaySettingsStore((state) => state.setVoiceLabelsEnabled)
  const {
    autoCheckEnabled,
    checkState: updateCheckState,
    statusMessage: updateStatusMessage,
    updateAvailable,
    latestTag,
    releaseName,
    lastCheckedAt,
    setAutoCheckEnabled,
    checkForUpdates,
    openReleasesPage,
  } = useUpdateStore()
  const {
    status: diagnosticsStatus,
    isLoading: diagnosticsIsLoading,
    isCapturingBundle: diagnosticsIsCapturingBundle,
    lastCaptureResult: diagnosticsLastCaptureResult,
    errorMessage: diagnosticsErrorMessage,
    init: initDiagnostics,
    setEnabled: setDiagnosticsEnabled,
    captureBundle: captureDiagnosticsBundle,
    revealCurrentLog,
    revealPreviousLog,
  } = useDiagnosticsStore()
  const [accentInputValue, setAccentInputValue] = useState(resolvedTokens.accent)
  const [miniPlayerVisualizerMode, setMiniPlayerVisualizerMode] = useState<MiniPlayerVisualizerMode>('off')
  const [localApiPortInput, setLocalApiPortInput] = useState(String(LOCAL_API_DEFAULT_PORT))
  const [phoneRemotePortInput, setPhoneRemotePortInput] = useState(String(PHONE_REMOTE_DEFAULT_PORT))
  const [lastFmProfileModalMode, setLastFmProfileModalMode] = useState<'create' | 'edit' | null>(null)
  const [lastFmEditingProfileId, setLastFmEditingProfileId] = useState<string | null>(null)
  const [lastFmProfileProtocolInput, setLastFmProfileProtocolInput] = useState<LastFmScrobbleProtocol>('lastfm2')
  const [lastFmProfileNameInput, setLastFmProfileNameInput] = useState('')
  const [lastFmProfileUrlInput, setLastFmProfileUrlInput] = useState('')
  const [lastFmProfileUsernameInput, setLastFmProfileUsernameInput] = useState('')
  const [lastFmProfileSessionKeyInput, setLastFmProfileSessionKeyInput] = useState('')
  const [localApiFeedback, setLocalApiFeedback] = useState('')
  const [phoneRemoteFeedback, setPhoneRemoteFeedback] = useState('')
  const [lastFmProfileFeedback, setLastFmProfileFeedback] = useState('')
  const [infoFeedback, setInfoFeedback] = useState('')
  const [infoFeedbackTone, setInfoFeedbackTone] = useState<'success' | 'error'>('success')
  const [sleepTimerCustomMinutesInput, setSleepTimerCustomMinutesInput] = useState(
    String(SLEEP_TIMER_PRESET_MINUTES[1] ?? SLEEP_TIMER_PRESET_MINUTES[0] ?? 30)
  )
  const [sleepTimerFeedback, setSleepTimerFeedback] = useState('')
  const [sleepTimerFeedbackTone, setSleepTimerFeedbackTone] = useState<'success' | 'error'>('success')
  const [normalizationDisableStep, setNormalizationDisableStep] = useState<NormalizationDisableStep>(null)
  const [normalizationTargetInput, setNormalizationTargetInput] = useState(() => formatNormalizationTargetLufs(normalizationTargetLufs))
  const [normalizationTargetError, setNormalizationTargetError] = useState('')
  const [lyricsTranslationPriorityInput, setLyricsTranslationPriorityInput] = useState(() => (
    lyricsDisplaySettings.translationLanguagePriority.join(', ')
  ))
  const [lyricsLrclibBaseUrlInput, setLyricsLrclibBaseUrlInput] = useState(LRCLIB_OFFICIAL_BASE_URL)
  const [showBitPerfectWarning, setShowBitPerfectWarning] = useState(false)
  useTranslationSurface('Settings ▸ Bit-perfect warning', () => setShowBitPerfectWarning(true))
  const [dontShowBitPerfectWarningAgain, setDontShowBitPerfectWarningAgain] = useState(false)
  const [bitPerfectWarningDismissed, setBitPerfectWarningDismissed] = useState(() => {
    return localStorage.getItem(BIT_PERFECT_WARNING_DISMISSED_STORAGE_KEY) === '1'
  })
  const developerRevealClickCountRef = useRef(0)
  const developerRevealResetTimeoutRef = useRef<number | null>(null)
  const uiScalePercent = useUIStore((state) => state.uiScalePercent)
  const setUIScalePercent = useUIStore((state) => state.setUIScalePercent)
  const resetUIScalePercent = useUIStore((state) => state.resetUIScalePercent)
  const homeGreetingTextMode = useUIStore((state) => state.homeGreetingTextMode)
  const setHomeGreetingTextMode = useUIStore((state) => state.setHomeGreetingTextMode)
  const transportInfoLineMode = useUIStore((state) => state.transportInfoLineMode)
  const setTransportInfoLineMode = useUIStore((state) => state.setTransportInfoLineMode)
  const activityIndicatorExperimentEnabled = useUIStore((state) => state.activityIndicatorExperimentEnabled)
  const setActivityIndicatorExperimentEnabled = useUIStore((state) => state.setActivityIndicatorExperimentEnabled)
  const controllerSupportEnabled = useUIStore((state) => state.controllerSupportEnabled)
  const setControllerSupportEnabled = useUIStore((state) => state.setControllerSupportEnabled)
  const jumpToPlayingDestination = useUIStore((state) => state.jumpToPlayingDestination)
  const setJumpToPlayingDestination = useUIStore((state) => state.setJumpToPlayingDestination)
  const parallaxExperimentEnabled = useUIStore((state) => state.parallaxExperimentEnabled)
  const setParallaxExperimentEnabled = useUIStore((state) => state.setParallaxExperimentEnabled)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const pendingSettingsSection = useUIStore((state) => state.pendingSettingsSection)
  const consumePendingSettingsSection = useUIStore((state) => state.consumePendingSettingsSection)
  const trackRatingsEnabled = useRatingsStore((state) => state.enabled)
  const setTrackRatingsEnabled = useRatingsStore((state) => state.setEnabled)
  const libraryGraphEnabled = useGraphStore((state) => state.enabled)
  const setLibraryGraphEnabled = useGraphStore((state) => state.setEnabled)
  const openFullGraph = useGraphStore((state) => state.openFullMap)
  const listeningStatsEnabled = useListeningStatsStore((state) => state.enabled)
  const setListeningStatsEnabled = useListeningStatsStore((state) => state.setEnabled)
  const clearDetailedListeningHistory = useListeningStatsStore((state) => state.clearDetailedHistory)
  const libraryIntegrityEnabled = useLibraryIntegrityStore((state) => state.enabled)
  const setLibraryIntegrityEnabled = useLibraryIntegrityStore((state) => state.setEnabled)
  const openLibraryIntegrityPanel = useLibraryIntegrityStore((state) => state.openPanel)
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const playbackState = usePlayerStore((state) => state.playbackState)
  const sleepTimerIsActive = useSleepTimerStore((state) => state.isActive)
  const sleepTimerExpiresAtMs = useSleepTimerStore((state) => state.expiresAtMs)
  const sleepTimerRemainingMs = useSleepTimerStore((state) => state.remainingMs)
  const startSleepTimer = useSleepTimerStore((state) => state.startTimer)
  const replaceSleepTimer = useSleepTimerStore((state) => state.replaceTimer)
  const cancelSleepTimer = useSleepTimerStore((state) => state.cancelTimer)

  const selectedPreset = useMemo(
    () => THEME_PRESET_LIST.find((preset) => preset.id === presetId) ?? THEME_PRESET_LIST[0],
    [presetId]
  )
  const defaultPresetAccent = useMemo(
    () => THEME_PRESET_LIST.find((preset) => preset.id === 'default')?.accent ?? DEFAULT_THEME_ACCENT,
    []
  )
  const fallbackAccent = customAccent ?? selectedPreset.accent
  const canStartSleepTimer = Boolean(
    currentTrack &&
    (playbackState === 'playing' || playbackState === 'paused')
  )
  const bitPerfectModeActive = playbackOutputMode === 'bitperfect'
  const nativeBackendLabel = useMemo(() => {
    switch (nativeAudioCapabilities.activeBackend) {
      case 'coreaudio':
        return 'CoreAudio'
      case 'wasapi-exclusive':
        return 'WASAPI Exclusive'
      case 'alsa-hw':
        return 'ALSA hw'
      default:
        return 'Unavailable'
    }
  }, [nativeAudioCapabilities.activeBackend])
  const sleepTimerRemainingLabel = useMemo(
    () => formatSleepTimerRemaining(sleepTimerRemainingMs),
    [sleepTimerRemainingMs]
  )
  const sleepTimerEndsAtLabel = useMemo(() => {
    if (sleepTimerExpiresAtMs == null) return null
    return formatLocaleDate(sleepTimerExpiresAtMs, {
      hour: 'numeric',
      minute: '2-digit'
    })
  }, [displayLanguage, sleepTimerExpiresAtMs])
  const sleepTimerStatusLabel = useMemo(() => {
    if (!sleepTimerIsActive) {
      return 'No active sleep timer.'
    }
    if (sleepTimerEndsAtLabel) {
      return `Sleep timer active • ${sleepTimerRemainingLabel} remaining • ends at ${sleepTimerEndsAtLabel}`
    }
    return `Sleep timer active • ${sleepTimerRemainingLabel} remaining.`
  }, [sleepTimerEndsAtLabel, sleepTimerIsActive, sleepTimerRemainingLabel])
  const visibleSettingsSections = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => {
      if (!('hidden' in section && section.hidden)) return true
      // Parallax is revealed by its own Experimental master toggle; other hidden sections
      // (Developer) stay gated behind the developer visibility preference.
      if (section.id === 'parallax') return parallaxExperimentEnabled
      return developerSectionVisible
    }),
    [developerSectionVisible, parallaxExperimentEnabled]
  )

  // Master on/off for the experimental Parallax feature. Enabling reveals + jumps to the dedicated
  // section; disabling fully stops host/sink networking before the section disappears (it is an
  // experimental feature — "off" means off, not just hidden).
  const handleToggleParallaxExperiment = (enabled: boolean) => {
    setParallaxExperimentEnabled(enabled)
    if (enabled) {
      setActiveSectionId('parallax')
    } else {
      const parallax = useParallaxStore.getState()
      void parallax.setHostEnabled(false)
      void parallax.setSinkEnabled(false)
    }
  }

  useEffect(() => {
    setAccentInputValue(fallbackAccent)
  }, [fallbackAccent])

  useEffect(() => {
    void initLocalApi()
    void initPhoneRemote()
  }, [initLocalApi, initPhoneRemote])

  useEffect(() => {
    void initDiagnostics()
  }, [initDiagnostics])

  useEffect(() => {
    if (!localApiStatus) return
    setLocalApiPortInput(String(localApiStatus.port))
  }, [localApiStatus?.port])

  useEffect(() => {
    if (!phoneRemoteStatus) return
    setPhoneRemotePortInput(String(phoneRemoteStatus.port))
  }, [phoneRemoteStatus?.port])

  useEffect(() => {
    const lanUrls = phoneRemoteStatus?.lanUrls ?? []
    if (lanUrls.length === 0) {
      setLocalApiSelectedPairingBaseUrl('')
      return
    }
    if (localApiSelectedPairingBaseUrl && lanUrls.includes(localApiSelectedPairingBaseUrl)) {
      return
    }
    setLocalApiSelectedPairingBaseUrl(lanUrls[0])
  }, [phoneRemoteStatus?.lanUrls, localApiSelectedPairingBaseUrl])

  useEffect(() => {
    if (!localApiFeedback) return
    const timeoutId = window.setTimeout(() => {
      setLocalApiFeedback('')
    }, 2600)
    return () => window.clearTimeout(timeoutId)
  }, [localApiFeedback])

  useEffect(() => {
    if (!phoneRemoteFeedback) return
    const timeoutId = window.setTimeout(() => {
      setPhoneRemoteFeedback('')
    }, 2600)
    return () => window.clearTimeout(timeoutId)
  }, [phoneRemoteFeedback])

  useEffect(() => {
    if (!lastFmProfileFeedback) return
    const timeoutId = window.setTimeout(() => {
      setLastFmProfileFeedback('')
    }, 3200)
    return () => window.clearTimeout(timeoutId)
  }, [lastFmProfileFeedback])

  useEffect(() => {
    if (!sleepTimerFeedback) return
    const timeoutId = window.setTimeout(() => {
      setSleepTimerFeedback('')
    }, 2600)
    return () => window.clearTimeout(timeoutId)
  }, [sleepTimerFeedback])

  useEffect(() => {
    setNormalizationTargetInput(formatNormalizationTargetLufs(normalizationTargetLufs))
  }, [normalizationTargetLufs])

  useEffect(() => {
    setLyricsTranslationPriorityInput(lyricsDisplaySettings.translationLanguagePriority.join(', '))
  }, [lyricsDisplaySettings.translationLanguagePriority])

  useEffect(() => {
    if (!lyricsStatus?.lrclibBaseUrl) return
    setLyricsLrclibBaseUrlInput(lyricsStatus.lrclibBaseUrl)
  }, [lyricsStatus?.lrclibBaseUrl])

  useEffect(() => {
    if (!showBitPerfectWarning) {
      setDontShowBitPerfectWarningAgain(false)
    }
  }, [showBitPerfectWarning])

  useEffect(() => {
    return () => {
      if (developerRevealResetTimeoutRef.current != null) {
        window.clearTimeout(developerRevealResetTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (pendingSettingsSection === null) return

    const pendingSection = consumePendingSettingsSection()
    if (!pendingSection) return

    const pendingSectionDefinition = SETTINGS_SECTIONS.find((section) => section.id === pendingSection)
    if (
      pendingSectionDefinition != null &&
      'hidden' in pendingSectionDefinition &&
      pendingSectionDefinition.hidden &&
      !developerSectionVisible
    ) {
      return
    }

    setActiveSectionId(pendingSection)
  }, [consumePendingSettingsSection, developerSectionVisible, pendingSettingsSection])

  useEffect(() => {
    if (!developerSectionVisible && activeSectionId === DEVELOPER_SETTINGS_SECTION_ID) {
      setActiveSectionId('info')
    }
  }, [activeSectionId, developerSectionVisible])

  const resetDeveloperRevealProgress = () => {
    developerRevealClickCountRef.current = 0
    if (developerRevealResetTimeoutRef.current != null) {
      window.clearTimeout(developerRevealResetTimeoutRef.current)
      developerRevealResetTimeoutRef.current = null
    }
  }

  const revealDeveloperSection = () => {
    persistDeveloperSectionVisibilityPreference(true)
    setDeveloperSectionVisible(true)
    setActiveSectionId(DEVELOPER_SETTINGS_SECTION_ID)
    resetDeveloperRevealProgress()
  }

  const handleAppVersionClick = () => {
    if (developerSectionVisible) {
      setActiveSectionId(DEVELOPER_SETTINGS_SECTION_ID)
      return
    }

    developerRevealClickCountRef.current += 1
    if (developerRevealResetTimeoutRef.current != null) {
      window.clearTimeout(developerRevealResetTimeoutRef.current)
    }
    developerRevealResetTimeoutRef.current = window.setTimeout(() => {
      developerRevealClickCountRef.current = 0
      developerRevealResetTimeoutRef.current = null
    }, DEVELOPER_SETTINGS_REVEAL_RESET_MS)

    if (developerRevealClickCountRef.current >= DEVELOPER_SETTINGS_REVEAL_CLICK_TARGET) {
      revealDeveloperSection()
    }
  }

  const handleHideDeveloperSection = () => {
    persistDeveloperSectionVisibilityPreference(false)
    setDeveloperSectionVisible(false)
    resetDeveloperRevealProgress()
  }

  const resetActions = useMemo<ResetActionDefinition[]>(() => ([
    {
      id: 'reset-theme',
      title: 'Reset Theme',
      description: 'Restore the default Astra theme and accent.',
      buttonLabel: 'Reset Theme',
      confirmTitle: 'Reset Theme to Default',
      confirmMessage: 'This will restore the default preset and accent color.',
      confirmLabel: 'Reset Theme',
      destructive: false,
      run: resetThemeSettings,
    },
    {
      id: 'reset-audio',
      title: 'Reset Audio Settings',
      description: 'Clear output device, routing, delay, calibration settings, and saved volume.',
      buttonLabel: 'Reset Audio',
      confirmTitle: 'Reset Audio Settings',
      confirmMessage: 'This will clear custom output routing, delay calibration profiles, and saved volume.',
      confirmLabel: 'Reset Audio',
      destructive: false,
      run: resetAudioSettings,
    },
    {
      id: 'reset-integrations',
      title: 'Reset Integrations',
      description: 'Disable Discord, scrobbling, Lyrics lookup, and the Local API.',
      buttonLabel: 'Reset Integrations',
      confirmTitle: 'Reset Integration Settings',
      confirmMessage: 'This will disable Discord, scrobbling, online lyrics lookup, and the local integration API, then clear related preferences.',
      confirmLabel: 'Reset Integrations',
      destructive: false,
      run: resetIntegrationSettings,
    },
    {
      id: 'reset-discord-cover-art-cache',
      title: 'Reset Discord Cover Art Cache',
      description: 'Clear saved cover art lookup hits and misses for Discord Rich Presence.',
      buttonLabel: 'Reset Cover Art Cache',
      confirmTitle: 'Reset Discord Cover Art Cache',
      confirmMessage: 'This clears cached Discord cover art lookup results and allows fresh lookups.',
      confirmLabel: 'Reset Cover Art Cache',
      destructive: false,
      run: resetDiscordCoverArtCache,
    },
    {
      id: 'reset-eq',
      title: 'Reset EQ Presets',
      description: 'Remove custom EQ presets and restore default EQ curve.',
      buttonLabel: 'Reset EQ',
      confirmTitle: 'Reset EQ Presets',
      confirmMessage: 'Custom EQ presets will be removed and EQ will return to defaults.',
      confirmLabel: 'Reset EQ',
      destructive: false,
      run: resetEqSettings,
    },
    {
      id: 'reset-all',
      title: 'Reset All Settings',
      description: 'Reset theme, audio, integrations, EQ, and visualizer settings.',
      buttonLabel: 'Reset All Settings',
      confirmTitle: 'Reset All Renderer Settings',
      confirmMessage: 'This clears all renderer settings but keeps your library data and folders.',
      confirmLabel: 'Reset All',
      destructive: false,
      run: resetAllSettings,
    },
    {
      id: 'reset-ratings',
      title: 'Reset Track Ratings',
      description: 'Permanently remove every star rating. Favorites, playlists, and library data are untouched.',
      buttonLabel: 'Reset Ratings',
      confirmTitle: 'Reset Track Ratings',
      confirmMessage: 'This permanently deletes all star ratings from the library database. Dynamic playlists that filter by rating will match no rated tracks until you rate again.',
      confirmLabel: 'Reset Ratings',
      destructive: true,
      typedPhrase: 'RESET RATINGS',
      run: resetTrackRatings,
    },
    {
      id: 'reset-listening-history',
      title: 'Clear Listening History',
      description: 'Delete detailed Stats sessions and listening time while preserving play counts, recents, and last-played values.',
      buttonLabel: 'Clear Listening History',
      confirmTitle: 'Clear Detailed Listening History',
      confirmMessage: 'This permanently removes detailed listening sessions, time totals, rankings, and the Stats baseline. Track play counts, recently played, last-played values, and dynamic playlist behavior are preserved.',
      confirmLabel: 'Clear History',
      destructive: true,
      typedPhrase: 'CLEAR LISTENING HISTORY',
      run: async () => {
        await clearDetailedListeningHistory()
        return 'Detailed listening history cleared. Play counts were preserved.'
      },
    },
    {
      id: 'reset-folders',
      title: 'Reset Mapped Folders',
      description: 'Remove mapped folders and indexed library data while preserving playlists.',
      buttonLabel: 'Reset Mapped Folders',
      confirmTitle: 'Reset Mapped Folders',
      confirmMessage: 'This deletes mapped folders, indexed tracks, favorites, and recently played history.',
      confirmLabel: 'Reset Folders',
      destructive: true,
      typedPhrase: 'RESET FOLDERS',
      disabled: isScanning,
      run: resetMappedFolders,
    },
    {
      id: 'factory-reset',
      title: 'Factory Reset',
      description: 'Wipe all settings and all library-side data including playlists and app metadata.',
      buttonLabel: 'Factory Reset',
      confirmTitle: 'Factory Reset Astra',
      confirmMessage: 'This removes all settings and all library data, then reloads the app.',
      confirmLabel: 'Factory Reset',
      destructive: true,
      typedPhrase: 'FACTORY RESET',
      disabled: isScanning,
      run: factoryResetApplication,
    },
  ]), [clearDetailedListeningHistory, isScanning])

  const resetActionMap = useMemo(() => {
    return new Map<ResetActionId, ResetActionDefinition>(resetActions.map((action) => [action.id, action]))
  }, [resetActions])
  const safeResetActions = useMemo(
    () => resetActions.filter((action) => !action.destructive),
    [resetActions]
  )
  const destructiveResetActions = useMemo(
    () => resetActions.filter((action) => action.destructive),
    [resetActions]
  )

  const pendingReset = pendingResetId ? (resetActionMap.get(pendingResetId) ?? null) : null
  const isAnyResetRunning = Object.values(resetStatuses).some((status) => status.state === 'running')
  const updateStatusTone = updateCheckState === 'update-available'
    ? 'available'
    : updateCheckState === 'error'
      ? 'error'
      : updateCheckState === 'checking'
        ? 'checking'
        : 'default'
  const lastCheckedLabel = lastCheckedAt
    ? formatLocaleDate(lastCheckedAt, { dateStyle: 'medium', timeStyle: 'short' })
    : translate('settings:dates.noUpdateChecks')
  const localApiEnabled = localApiStatus?.enabled ?? false
  const localApiControlsEnabled = localApiStatus?.controlsEnabled ?? false
  const localApiLibrarySearchEnabled = localApiStatus?.librarySearchEnabled ?? false
  const localApiLibraryWriteEnabled = localApiStatus?.libraryWriteEnabled ?? false
  const localApiBaseUrl = localApiStatus?.baseUrl ?? `http://127.0.0.1:${LOCAL_API_DEFAULT_PORT}`
  const localApiToken = localApiStatus?.token ?? ''
  const phoneRemoteEnabled = phoneRemoteStatus?.enabled ?? false
  const phoneRemoteControlsEnabled = phoneRemoteStatus?.controlsEnabled ?? localApiControlsEnabled
  const phoneRemoteSync = phoneRemoteStatus?.sync ?? null
  const phoneRemoteSyncEnabled = phoneRemoteSync?.enabled ?? true
  const phoneRemoteSyncConflictCount = phoneRemoteSync?.conflicts.length ?? 0
  const phoneRemoteSyncPendingCount = phoneRemoteSync?.pendingResolutions.length ?? 0
  const phoneRemoteLanUrls = phoneRemoteStatus?.lanUrls ?? []
  const phoneRemoteControllerUrls = phoneRemoteLanUrls.map((url) => `${url}/remote/`)
  const localApiSelectedPairingUrl = localApiSelectedPairingBaseUrl
    ? `${localApiSelectedPairingBaseUrl}/remote/`
    : phoneRemoteControllerUrls[0] ?? ''
  const phoneRemotePairedDeviceCount = phoneRemoteStatus?.pairedDeviceCount ?? phoneRemotePairedDevices.length
  const phoneRemotePendingPairingCount = phoneRemoteStatus?.pendingPairingCount ?? phoneRemotePendingPairingRequests.length
  const localApiPhoneRemoteSummary = !phoneRemoteEnabled
    ? 'Phone remote is off. Turn it on when you want Astra to expose `/remote/` on your LAN.'
    : phoneRemoteLanUrls.length === 0
      ? 'Phone remote is enabled, but Astra has not found a usable `192.168.*` LAN address yet.'
      : phoneRemotePendingPairingCount > 0
        ? `${phoneRemotePendingPairingCount} phone${phoneRemotePendingPairingCount === 1 ? '' : 's'} waiting for approval.`
        : phoneRemotePairedDeviceCount > 0
          ? `${phoneRemotePairedDeviceCount} phone${phoneRemotePairedDeviceCount === 1 ? '' : 's'} paired.`
          : phoneRemoteControlsEnabled
            ? 'Phone remote is ready for full control.'
            : 'Phone remote is ready in read-only mode until playback controls are enabled.'
  const localApiStatusLabel = !localApiStatus
    ? 'Loading local API status...'
    : localApiStatus.active
      ? `Local integration API active on ${localApiStatus.baseUrl}.`
      : localApiStatus.enabled
        ? `Local integration API enabled but not active${localApiStatus.lastError ? `: ${localApiStatus.lastError}` : '.'}`
        : 'Local integration API is disabled.'
  const localApiActiveDevices = useMemo(
    () => phoneRemotePairedDevices.filter((d) => d.revokedAt == null),
    [phoneRemotePairedDevices]
  )
  const localApiControllerUrl = phoneRemoteControllerUrls[0] ?? ''
  const localApiInlineQrSvg = useMemo(() => {
    if (!localApiControllerUrl) return ''
    try { return renderPairingQrSvg(localApiControllerUrl) } catch { return '' }
  }, [localApiControllerUrl])
  // §20 Commit 4 — Codex round 1 finding (medium): the Parallax host QR was for the legacy
  // sink-types-PIN flow which is gone. Removed.
  const lastFmEnabled = lastFmStatus?.enabled ?? false
  const lastFmAuthPending = lastFmStatus?.authPending ?? false
  const lastFmAuthPendingProfileId = lastFmStatus?.authPendingProfileId ?? null
  const lastFmHasApiCredentials = lastFmStatus?.hasApiCredentials ?? true
  const lastFmProfiles = lastFmStatus?.profiles ?? []
  const lastFmPendingScrobbles = lastFmStatus?.pendingScrobbles ?? 0
  const lastFmStatusLabel = lastFmStatus?.statusMessage ?? 'Loading scrobbling status...'
  const lastFmQueueLabel = `Pending scrobbles: ${lastFmPendingScrobbles}.`
  const lastFmResolvedError = lastFmErrorMessage || (lastFmStatus?.lastError ?? '')
  const lastFmProfileModalOpen = lastFmProfileModalMode != null
  const lastFmProfileModalTitle = lastFmProfileModalMode === 'edit' ? 'Edit Destination' : 'Add Destination'
  const lastFmProfilePresence = usePresence(lastFmProfileModalOpen ? lastFmProfileModalTitle : null)
  const lastFmProfileSaveDisabled = !lastFmProfileNameInput.trim() ||
    !lastFmProfileUrlInput.trim() ||
    (isScrobbleUsernameRequired(lastFmProfileProtocolInput) && !lastFmProfileUsernameInput.trim()) ||
    (lastFmProfileModalMode === 'create' && !lastFmProfileSessionKeyInput.trim())
  const lyricsEnabled = lyricsStatus?.enabled ?? false
  const lyricsStatusLabel = lyricsStatus?.statusMessage ?? 'Loading lyrics status...'
  const lyricsResolvedError = lyricsErrorMessage || (lyricsStatus?.lastError ?? '')
  const diagnosticsEnabled = diagnosticsStatus?.enabled ?? false
  const diagnosticsSampleIntervalLabel = `${Math.round((diagnosticsStatus?.sampleIntervalMs ?? 15000) / 1000)} seconds`
  const diagnosticsCurrentLogPath = diagnosticsStatus?.currentLogPath ?? 'Loading diagnostics paths...'
  const diagnosticsPreviousLogPath = diagnosticsStatus?.previousLogPath ?? 'Loading diagnostics paths...'
  const diagnosticsSessionLabel = diagnosticsStatus?.sessionStartedAt
    ? translate('settings:dates.diagnosticsSession', {
        date: formatLocaleDate(diagnosticsStatus.sessionStartedAt, { dateStyle: 'medium', timeStyle: 'short' })
      })
    : diagnosticsEnabled
      ? 'Waiting for the current diagnostics session header.'
      : 'Diagnostics are disabled.'
  const diagnosticsLastBundleLabel = diagnosticsLastCaptureResult
    ? translate('settings:dates.diagnosticsBundle', {
        date: formatLocaleDate(diagnosticsLastCaptureResult.capturedAt, { dateStyle: 'medium', timeStyle: 'short' })
      })
    : 'No memory bundle captured in this session.'

  const handlePlaybackPathChange = (mode: 'standard' | 'bitperfect') => {
    if (mode === playbackOutputMode) return
    if (mode === 'standard') {
      void setPlaybackOutputMode('standard')
      return
    }

    if (bitPerfectWarningDismissed) {
      void setPlaybackOutputMode('bitperfect')
      return
    }

    setShowBitPerfectWarning(true)
  }

  const handleConfirmBitPerfectWarning = () => {
    if (dontShowBitPerfectWarningAgain) {
      localStorage.setItem(BIT_PERFECT_WARNING_DISMISSED_STORAGE_KEY, '1')
      setBitPerfectWarningDismissed(true)
    }
    setShowBitPerfectWarning(false)
    void setPlaybackOutputMode('bitperfect')
  }

  useEffect(() => {
    let isMounted = true

    const loadAppBuildInfo = async () => {
      if (window.electronAPI?.getAppBuildInfo) {
        try {
          const buildInfo = await window.electronAPI.getAppBuildInfo()
          if (!isMounted) return
          setAppVersionLabel(buildInfo.version ? `v${buildInfo.version}` : 'Unavailable')
          setAppBuildLabel(formatBuildLabel(buildInfo))
          setAppBuildTooltip(formatBuildTooltip(buildInfo) ?? '')
          setAppBuildCopyValue(formatBuildCopyValue(buildInfo))
        } catch {
          if (!isMounted) return
          setAppVersionLabel('Unavailable')
          setAppBuildLabel('')
          setAppBuildTooltip('')
          setAppBuildCopyValue('')
        }
        return
      }

      if (!window.electronAPI?.getAppVersion) {
        if (!isMounted) return
        setAppVersionLabel('Unavailable')
        setAppBuildLabel('')
        setAppBuildTooltip('')
        setAppBuildCopyValue('')
        return
      }

      try {
        const version = await window.electronAPI.getAppVersion()
        if (!isMounted) return
        setAppVersionLabel(version ? `v${version}` : 'Unavailable')
        setAppBuildLabel('')
        setAppBuildTooltip('')
        setAppBuildCopyValue('')
      } catch {
        if (!isMounted) return
        setAppVersionLabel('Unavailable')
        setAppBuildLabel('')
        setAppBuildTooltip('')
        setAppBuildCopyValue('')
      }
    }

    void loadAppBuildInfo()
    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    let isMounted = true

    void window.electronAPI.miniPlayer.getWindowState().then((state) => {
      if (!isMounted) return
      setMiniPlayerVisualizerMode(state.visualizerMode)
    })

    const unsubscribe = window.electronAPI.miniPlayer.onWindowState((state) => {
      setMiniPlayerVisualizerMode(state.visualizerMode)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  const executeResetAction = async (actionId: ResetActionId): Promise<void> => {
    const action = resetActionMap.get(actionId)
    if (!action) return

    setResetStatuses((prev) => ({
      ...prev,
      [actionId]: { state: 'running', message: 'Running...' },
    }))

    try {
      const result = await action.run()
      setResetStatuses((prev) => ({
        ...prev,
        [actionId]: { state: 'success', message: result ?? 'Completed.' },
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to complete action.'
      setResetStatuses((prev) => ({
        ...prev,
        [actionId]: { state: 'error', message },
      }))
    } finally {
      setPendingResetId(null)
    }
  }

  const handleAccentColorInput = (value: string) => {
    setAccentInputValue(value)
    const normalized = normalizeHexColor(value)
    if (!normalized) return
    setCustomAccent(normalized)
  }

  const openExternalLink = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleMiniPlayerVisualizerModeChange = (mode: MiniPlayerVisualizerMode) => {
    setMiniPlayerVisualizerMode(mode)
    void window.electronAPI.miniPlayer.setVisualizerMode(mode).then((state) => {
      setMiniPlayerVisualizerMode(state.visualizerMode)
    })
  }

  const copyToClipboard = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setLocalApiFeedback(`${label} copied.`)
    } catch {
      setLocalApiFeedback(`Failed to copy ${label.toLowerCase()}.`)
    }
  }

  const copyPhoneRemoteToClipboard = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setPhoneRemoteFeedback(`${label} copied.`)
    } catch {
      setPhoneRemoteFeedback(`Failed to copy ${label.toLowerCase()}.`)
    }
  }

  const copyInfoToClipboard = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setInfoFeedbackTone('success')
      setInfoFeedback(`${label} copied.`)
    } catch {
      setInfoFeedbackTone('error')
      setInfoFeedback(`Failed to copy ${label.toLowerCase()}.`)
    }
  }

  const handleSaveLocalApiPort = () => {
    const parsedPort = Number(localApiPortInput)
    if (!Number.isInteger(parsedPort) || parsedPort < LOCAL_API_MIN_PORT || parsedPort > LOCAL_API_MAX_PORT) {
      setLocalApiFeedback(`Port must be an integer between ${LOCAL_API_MIN_PORT} and ${LOCAL_API_MAX_PORT}.`)
      return
    }

    void setLocalApiPort(parsedPort).then((status) => {
      if (!status) return
      setLocalApiFeedback(`API port set to ${status.port}.`)
    })
  }

  const handleRotateLocalApiToken = () => {
    void rotateLocalApiToken().then((status) => {
      if (!status) return
      setLocalApiFeedback('API key regenerated.')
    })
  }

  const handleSavePhoneRemotePort = () => {
    const parsedPort = Number(phoneRemotePortInput)
    if (!Number.isInteger(parsedPort) || parsedPort < PHONE_REMOTE_MIN_PORT || parsedPort > PHONE_REMOTE_MAX_PORT) {
      setPhoneRemoteFeedback(`Port must be an integer between ${PHONE_REMOTE_MIN_PORT} and ${PHONE_REMOTE_MAX_PORT}.`)
      return
    }

    void setPhoneRemotePort(parsedPort).then((status) => {
      if (!status) return
      setPhoneRemoteFeedback(`Phone remote port set to ${status.port}.`)
    })
  }

  const openLastFmCreateProfileModal = () => {
    const protocol: LastFmScrobbleProtocol = 'lastfm2'
    setLastFmProfileModalMode('create')
    setLastFmEditingProfileId(null)
    setLastFmProfileProtocolInput(protocol)
    setLastFmProfileNameInput(getDefaultScrobbleProfileName(protocol))
    setLastFmProfileUrlInput('')
    setLastFmProfileUsernameInput('')
    setLastFmProfileSessionKeyInput('')
  }

  const openLastFmEditProfileModal = (profile: LastFmProfileStatus) => {
    if (profile.kind !== 'custom') return
    setLastFmProfileModalMode('edit')
    setLastFmEditingProfileId(profile.id)
    setLastFmProfileProtocolInput(profile.protocol)
    setLastFmProfileNameInput(profile.name)
    setLastFmProfileUrlInput(profile.apiBaseUrl)
    setLastFmProfileUsernameInput(profile.username ?? '')
    setLastFmProfileSessionKeyInput('')
  }

  const closeLastFmProfileModal = () => {
    setLastFmProfileModalMode(null)
    setLastFmEditingProfileId(null)
    setLastFmProfileSessionKeyInput('')
  }

  const handleLastFmProfileProtocolChange = (protocol: LastFmScrobbleProtocol) => {
    const previousProtocol = lastFmProfileProtocolInput
    setLastFmProfileProtocolInput(protocol)
    if (
      lastFmProfileModalMode === 'create' &&
      lastFmProfileNameInput === getDefaultScrobbleProfileName(previousProtocol)
    ) {
      setLastFmProfileNameInput(getDefaultScrobbleProfileName(protocol))
    }
  }

  const handleSaveLastFmProfile = () => {
    const input = {
      protocol: lastFmProfileProtocolInput,
      name: lastFmProfileNameInput,
      apiBaseUrl: lastFmProfileUrlInput,
      username: lastFmProfileUsernameInput,
      sessionKey: lastFmProfileSessionKeyInput.trim() ? lastFmProfileSessionKeyInput : null
    }

    const savePromise = lastFmProfileModalMode === 'edit' && lastFmEditingProfileId
      ? updateLastFmCustomProfile(lastFmEditingProfileId, input)
      : createLastFmCustomProfile(input)

    void savePromise.then((status) => {
      if (!status || status.lastError) return
      setLastFmProfileFeedback(lastFmProfileModalMode === 'edit' ? 'Destination updated.' : 'Destination added.')
      closeLastFmProfileModal()
    })
  }

  const handleDeleteLastFmProfile = (profile: LastFmProfileStatus) => {
    if (profile.kind !== 'custom') return
    if (!window.confirm(`Delete ${profile.name}?`)) return
    void deleteLastFmCustomProfile(profile.id).then((status) => {
      if (!status || status.lastError) return
      setLastFmProfileFeedback('Destination deleted.')
    })
  }

  const canToggleLastFmProfile = (profile: LastFmProfileStatus): boolean => {
    return profile.connected && (!profile.requiresApiCredentials || lastFmHasApiCredentials)
  }

  const handleToggleLastFmProfile = (profile: LastFmProfileStatus) => {
    if (!canToggleLastFmProfile(profile)) return
    void setLastFmProfileEnabled(profile.id, !profile.enabled).then((status) => {
      if (!status || status.lastError) return
      setLastFmProfileFeedback(`${profile.name} ${profile.enabled ? 'disabled' : 'enabled'}.`)
    })
  }

  const handleEnablePhoneRemoteControl = () => {
    void (async () => {
      if (!phoneRemoteEnabled) {
        const status = await setPhoneRemoteEnabled(true)
        if (!status) return
      }

      if (!localApiControlsEnabled) {
        const status = await setLocalApiControlsEnabled(true)
        if (!status) return
      }

      setPhoneRemoteFeedback('Phone remote control enabled.')
    })()
  }

  const handleOpenPhoneRemotePairingModal = () => {
    setLocalApiPairingModalOpen(true)
  }

  const handleClosePhoneRemotePairingModal = () => {
    setLocalApiPairingModalOpen(false)
    clearPhoneRemoteActivePairingTicket()
  }

  const handleCreatePhoneRemotePairingTicket = () => {
    void createPhoneRemotePairingTicket(localApiSelectedPairingBaseUrl || undefined).then((ticket) => {
      if (!ticket) return
      setPhoneRemoteFeedback('Pairing ticket generated.')
    })
  }

  const handleRefreshPhoneRemotePairingTicket = () => {
    void createPhoneRemotePairingTicket(
      localApiSelectedPairingBaseUrl || undefined,
      phoneRemoteActivePairingTicket?.clientKind ?? 'native'
    ).then((ticket) => {
      if (!ticket) return
      setPhoneRemoteFeedback('Pairing ticket refreshed.')
    })
  }

  const handleCreatePhoneRemoteWebPairingTicket = () => {
    void createPhoneRemotePairingTicket(localApiSelectedPairingBaseUrl || undefined, 'web').then((ticket) => {
      if (!ticket) return
      setPhoneRemoteFeedback('Control-only browser pairing ticket generated.')
    })
  }

  const handleApprovePhoneRemotePairingRequest = (id: string, scopes: CompanionApiScope[]) => {
    void approvePhoneRemotePairingRequest(id, scopes).then(() => {
      setPhoneRemoteFeedback('Pairing request approved.')
    })
  }

  const handleRejectPhoneRemotePairingRequest = (id: string) => {
    void rejectPhoneRemotePairingRequest(id).then(() => {
      setPhoneRemoteFeedback('Pairing request rejected.')
    })
  }

  const handleRevokePhoneRemotePairedDevice = (id: string) => {
    void revokePhoneRemotePairedDevice(id).then(() => {
      setPhoneRemoteFeedback('Paired phone revoked.')
    })
  }

  const handleRevokeAllPhoneRemoteDevices = () => {
    void revokeAllPhoneRemotePairedDevices().then((revokedCount) => {
      if (revokedCount > 0) {
        setPhoneRemoteFeedback(`${revokedCount} paired phone${revokedCount === 1 ? '' : 's'} revoked.`)
        return
      }
      setPhoneRemoteFeedback('No paired phones to revoke.')
    })
  }

  const handleSleepTimerStartResult = (
    result: ReturnType<typeof startSleepTimer>,
    successMessage: string
  ) => {
    if (result.ok) {
      setSleepTimerFeedbackTone('success')
      setSleepTimerFeedback(successMessage)
      return
    }

    setSleepTimerFeedbackTone('error')
    if (result.reason === 'invalid-duration') {
      setSleepTimerFeedback(
        `Minutes must be an integer between ${SLEEP_TIMER_MIN_MINUTES} and ${SLEEP_TIMER_MAX_MINUTES}.`
      )
      return
    }

    setSleepTimerFeedback('Load a track and keep playback in playing or paused state before starting a sleep timer.')
  }

  const handleSleepTimerPreset = (minutes: number) => {
    const result = sleepTimerIsActive
      ? replaceSleepTimer(minutes)
      : startSleepTimer(minutes)
    handleSleepTimerStartResult(result, `Sleep timer set for ${minutes} minute${minutes === 1 ? '' : 's'}.`)
  }

  const handleSleepTimerCustomStart = () => {
    const parsedMinutes = parseSleepTimerMinutesInput(sleepTimerCustomMinutesInput)
    if (parsedMinutes == null) {
      setSleepTimerFeedbackTone('error')
      setSleepTimerFeedback(
        `Minutes must be an integer between ${SLEEP_TIMER_MIN_MINUTES} and ${SLEEP_TIMER_MAX_MINUTES}.`
      )
      return
    }

    const result = sleepTimerIsActive
      ? replaceSleepTimer(parsedMinutes)
      : startSleepTimer(parsedMinutes)
    handleSleepTimerStartResult(
      result,
      `Sleep timer set for ${parsedMinutes} minute${parsedMinutes === 1 ? '' : 's'}.`
    )
  }

  const handleSleepTimerCancel = () => {
    cancelSleepTimer()
    setSleepTimerFeedbackTone('success')
    setSleepTimerFeedback('Sleep timer canceled.')
  }

  const handleNormalizationToggle = () => {
    if (bitPerfectModeActive) return
    if (normalizationEnabled) {
      setNormalizationDisableStep('warning')
      return
    }
    setNormalizationEnabled(true)
  }

  const handleConfirmDisableNormalization = () => {
    if (normalizationDisableStep === 'warning') {
      setNormalizationDisableStep('final')
      return
    }
    if (normalizationDisableStep === 'final') {
      setNormalizationEnabled(false)
      setNormalizationDisableStep(null)
    }
  }

  const commitNormalizationTarget = () => {
    if (bitPerfectModeActive) return
    const parsed = parseNormalizationTargetLufsInput(normalizationTargetInput)
    if (parsed == null) {
      setNormalizationTargetError(
        `Enter a value between ${NORMALIZATION_TARGET_MIN_LUFS} and ${NORMALIZATION_TARGET_MAX_LUFS} LUFS.`
      )
      setNormalizationTargetInput(formatNormalizationTargetLufs(normalizationTargetLufs))
      return
    }
    setNormalizationTargetError('')
    setNormalizationTargetLufs(parsed)
    setNormalizationTargetInput(formatNormalizationTargetLufs(parsed))
  }

  const resetNormalizationTarget = () => {
    if (bitPerfectModeActive) return
    setNormalizationTargetError('')
    setNormalizationTargetLufs(DEFAULT_NORMALIZATION_TARGET_LUFS)
    setNormalizationTargetInput(formatNormalizationTargetLufs(DEFAULT_NORMALIZATION_TARGET_LUFS))
  }

  const replayGainSelectorValue: ReplayGainSelectorValue = replayGainScanEnabled
    ? replayGainMode
    : 'disabled'

  const handleReplayGainSelectorChange = async (value: ReplayGainSelectorValue): Promise<void> => {
    if (bitPerfectModeActive) return
    if (value === 'disabled') {
      await setReplayGainScanEnabled(false)
      return
    }

    setReplayGainMode(value)
    if (!replayGainScanEnabled) {
      await setReplayGainScanEnabled(true)
      await backfillReplayGainMetadata()
    }
  }

  const renderResetAction = (action: ResetActionDefinition) => {
    const status = resetStatuses[action.id]
    return (
      <div
        key={action.id}
        className={`settings-danger-item ${action.destructive ? 'settings-danger-item-destructive' : ''}`}
      >
        <div className="settings-danger-item-copy">
          <p className="settings-danger-item-title">{translateSourceText(action.title)}</p>
          <p className="settings-danger-item-description">{translateSourceText(action.description)}</p>
          {status.state !== 'idle' && (
            <p className={`settings-danger-status settings-danger-status-${status.state}`}>
              {translateSourceText(status.message)}
            </p>
          )}
        </div>
        <button
          className={`settings-btn ${action.destructive ? 'settings-btn-danger' : ''}`}
          onClick={() => setPendingResetId(action.id)}
          disabled={Boolean(action.disabled) || isAnyResetRunning}
        >
          {action.buttonLabel}
        </button>
      </div>
    )
  }

  return (
    <div className="settings-view">
      <div className="settings-shell">
        <div className="settings-header">
          <div>
            <p className="settings-kicker">{t('settings:kicker')}</p>
            <h2>{t('settings:title')}</h2>
            <p className="settings-subtitle">{t('settings:subtitle')}</p>
          </div>
          {isScanning && (
            <div className="settings-scan-badge">
              <span>
                {scanStage?.stage === 'backfill'
                  ? t('settings:scan.metadata')
                  : scanStage?.stage === 'cleanup'
                    ? t('settings:scan.finalizing')
                    : t('settings:scan.scanning')}
                {scanProgress ? translate('settings:auto.settingsview.current_total', { current: scanProgress.current, total: scanProgress.total }) : '...'}
              </span>
              <button
                className="settings-scan-badge-cancel"
                onClick={() => void cancelScan()}
                disabled={isCancelingScan}
                aria-label={t('common:accessibility.cancelScan')}
                title={t('common:accessibility.cancelScan')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
          )}
        </div>

        <div className="settings-layout">
          <nav className="settings-sidebar" aria-label={t('common:accessibility.settingsSections')}>
            {visibleSettingsSections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`settings-sidebar-item ${activeSectionId === section.id ? 'active' : ''}`}
                aria-current={activeSectionId === section.id ? 'true' : undefined}
                onClick={() => setActiveSectionId(section.id)}
              >
                {t(`settings:sections.${section.id}`)}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {activeSectionId === 'appearance' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>{t('settings:sections.appearance')}</h3>
            </div>
            <div className="settings-theme-grid">
              {THEME_PRESET_LIST.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`settings-theme-card ${presetId === preset.id ? 'active' : ''}`}
                  onClick={() => setPreset(preset.id as ThemePresetId)}
                >
                  <span className="settings-theme-card-title">{translateSourceText(preset.label)}</span>
                  <span className="settings-theme-card-description">{translateSourceText(preset.description)}</span>
                </button>
              ))}
            </div>
            <div className="settings-cards">
              <div className="settings-card">
                <div className="settings-card-label">{t('settings:appearance.language.cardTitle')}</div>
                <div className="settings-grid">
                  <label className="settings-field">
                    <span className="settings-field-label">{t('settings:appearance.language.fieldLabel')}</span>
                    <select
                      className="settings-select"
                      value={displayLanguage}
                      onChange={(event) => void setDisplayLanguage(event.target.value)}
                      aria-label={t('settings:appearance.language.selectLabel')}
                    >
                      {displayLanguageOptions.map((locale) => (
                        <option key={locale.code} value={locale.code}>{locale.nativeName}</option>
                      ))}
                    </select>
                  </label>
                  <p className="settings-note">{t('settings:appearance.language.description')}</p>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.accent" /></div>
                <div className="settings-grid">
                  <label className="settings-field">
                    <span className="settings-field-label">
                      {accentSource === 'cover-art' ? translate('settings:auto.settingsview.fallback_accent_color') : translate('settings:auto.settingsview.accent_color')}
                    </span>
                    <div className="settings-accent-inputs">
                      <input
                        className="settings-color settings-color-wide"
                        type="color"
                        value={fallbackAccent}
                        onChange={(event) => {
                          const next = event.target.value.toLowerCase()
                          setAccentInputValue(next)
                          setCustomAccent(next)
                        }}
                      />
                      <input
                        className="settings-select settings-accent-hex-input"
                        type="text"
                        value={accentInputValue}
                        onChange={(event) => handleAccentColorInput(event.target.value)}
                        onBlur={() => {
                          const normalized = normalizeHexColor(accentInputValue)
                          if (!normalized) {
                            setAccentInputValue(fallbackAccent)
                            return
                          }
                          setAccentInputValue(normalized)
                        }}
                        placeholder={defaultPresetAccent}
                        spellCheck={false}
                      />
                    </div>
                  </label>
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.accent_source" /></span>
                    <SettingsSegmentedControl
                      ariaLabel="Accent source"
                      fullWidth
                      options={ACCENT_SOURCE_OPTIONS}
                      value={accentSource}
                      onChange={setAccentSource}
                    />
                  </div>
                  {accentSource === 'cover-art' && (
                    <div className="settings-field">
                      <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.cover_art_method" /></span>
                      <SettingsSegmentedControl
                        ariaLabel="Cover art accent method"
                        fullWidth
                        options={COVER_ART_ACCENT_METHOD_OPTIONS}
                        value={coverArtAccentMethod}
                        onChange={setCoverArtAccentMethod}
                      />
                    </div>
                  )}
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label">
                      {accentSource === 'cover-art' ? translate('settings:auto.settingsview.fallback_accent') : translate('settings:auto.settingsview.preset_accent')}
                    </span>
                    {customAccent ? (
                      <button className="settings-btn" onClick={usePresetAccent}>

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.use_preset_accent" />
                      </button>
                    ) : (
                      <span className="settings-chip"><LocalizedText ns="settings" i18nKey="auto.settingsview.using_preset_accent" /></span>
                    )}
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.theme" /></span>
                    <button
                      className="settings-btn settings-btn-primary"
                      onClick={() => {
                        resetThemeToDefault()
                        setAccentInputValue(defaultPresetAccent)
                      }}
                    >

                      <LocalizedText ns="settings" i18nKey="auto.settingsview.reset_theme_to_default" />
                    </button>
                  </div>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.interface_scale" /></div>
                <div className="settings-grid">
                  <label className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.ui_scale" /></span>
                    <div className="settings-scale-row">
                      <input
                        className="settings-scale-slider"
                        type="range"
                        min={MIN_UI_SCALE_PERCENT}
                        max={MAX_UI_SCALE_PERCENT}
                        step={UI_SCALE_STEP_PERCENT}
                        value={uiScalePercent}
                        onChange={(event) => setUIScalePercent(Number(event.target.value))}
                        aria-label={translate('settings:auto.settingsview.ui_scale_b24ae33')}
                      />
                      <span className="settings-chip settings-chip-mono settings-scale-value">
                        {uiScalePercent}%
                      </span>
                      <button
                        type="button"
                        className="settings-chip settings-chip-mono settings-chip-danger"
                        onClick={resetUIScalePercent}
                        disabled={uiScalePercent === DEFAULT_UI_SCALE_PERCENT}
                      >

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.reset" />
                      </button>
                    </div>
                  </label>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.home_greeting" /></div>
                <div className="settings-grid">
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.text" /></span>
                    <SettingsSegmentedControl
                      ariaLabel="Home greeting text"
                      fullWidth
                      options={HOME_GREETING_TEXT_OPTIONS}
                      value={homeGreetingTextMode}
                      onChange={setHomeGreetingTextMode}
                    />
                  </div>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.transport_bar" /></div>
                <div className="settings-grid">
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.info_line" /></span>
                    <SettingsSegmentedControl
                      ariaLabel="Transport bar info line"
                      fullWidth
                      options={TRANSPORT_INFO_LINE_OPTIONS}
                      value={transportInfoLineMode}
                      onChange={setTransportInfoLineMode}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>
            )}

            {activeSectionId === 'library' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3><LocalizedText ns="settings" i18nKey="auto.settingsview.library" /></h3>
            </div>
            <div className="settings-actions settings-actions-grid settings-actions-grid-spaced">
              <button className="settings-btn settings-btn-primary" onClick={() => setShowFolderSettings(true)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                </svg>

                <LocalizedText ns="settings" i18nKey="auto.settingsview.manage_folders" />
              </button>
              <button className="settings-btn" onClick={rescan} disabled={isScanning}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>

                <LocalizedText ns="settings" i18nKey="auto.settingsview.scan_for_changes" />
              </button>
              <button className="settings-btn" onClick={forceRescanAll} disabled={isScanning}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>

                <LocalizedText ns="settings" i18nKey="auto.settingsview.force_rescan_all" />
              </button>
            </div>
            <div className="settings-cards">
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.normalization" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.normalization" /></span>
                    <button
                      className={`settings-toggle ${normalizationEnabled ? 'active' : ''}`}
                      onClick={handleNormalizationToggle}
                      disabled={bitPerfectModeActive}
                      title={bitPerfectModeActive ? BIT_PERFECT_DSP_DISABLED_MESSAGE : undefined}
                    >
                      {normalizationEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <label className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.normalization_target" /></span>
                    <div className="settings-inline-row">
                      <input
                        className="settings-select settings-inline-input settings-inline-input-compact"
                        type="number"
                        min={NORMALIZATION_TARGET_MIN_LUFS}
                        max={NORMALIZATION_TARGET_MAX_LUFS}
                        step={0.5}
                        value={normalizationTargetInput}
                        disabled={!normalizationEnabled || bitPerfectModeActive}
                        onChange={(event) => {
                          setNormalizationTargetInput(event.target.value)
                          if (normalizationTargetError) {
                            setNormalizationTargetError('')
                          }
                        }}
                        onBlur={commitNormalizationTarget}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return
                          event.preventDefault()
                          commitNormalizationTarget()
                        }}
                      />
                      <span className="settings-chip settings-chip-mono">LUFS</span>
                      <button
                        type="button"
                        className="settings-chip settings-chip-mono settings-chip-danger"
                        disabled={!normalizationEnabled || bitPerfectModeActive}
                        onClick={resetNormalizationTarget}
                      >

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.reset" />
                      </button>
                    </div>
                  </label>
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.replaygain" /></span>
                    <SettingsSegmentedControl
                      ariaLabel="ReplayGain preference"
                      fullWidth
                      options={REPLAYGAIN_OPTIONS}
                      value={replayGainSelectorValue}
                      disabled={bitPerfectModeActive}
                      onChange={(value) => void handleReplayGainSelectorChange(value)}
                    />
                  </div>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.artist_parsing" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.artist_parsing" /></span>
                    <div className="settings-inline-row">
                      <button
                        className={`settings-toggle ${artistBrowseMode === 'strict' ? 'active' : ''}`}
                        onClick={() => setArtistBrowseMode('strict')}
                        aria-pressed={artistBrowseMode === 'strict'}
                        title={translate('settings:auto.settingsview.use_stored_album_artist_and_artist_tags_as_written')}
                      >

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.file_tags" />
                      </button>
                      <button
                        className={`settings-toggle ${artistBrowseMode === 'canonical' ? 'active' : ''}`}
                        onClick={() => setArtistBrowseMode('canonical')}
                        aria-pressed={artistBrowseMode === 'canonical'}
                        title={translate('settings:auto.settingsview.use_astra_s_primary_artist_and_collaboration_grouping')}
                      >

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.astra_grouping" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.track_ratings" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.ratings" /></span>
                    <button
                      className={`settings-toggle ${trackRatingsEnabled ? 'active' : ''}`}
                      onClick={() => setTrackRatingsEnabled(!trackRatingsEnabled)}
                      title={translate('settings:auto.settingsview.rate_tracks_with_1_5_stars_in_half_star_steps')}
                    >
                      {trackRatingsEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <p className="settings-note">

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.rate_tracks_with_1_5_stars_in_half_star_steps_adds_a_rat" />
                  </p>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.tracklist_columns" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.bpm_key" /></span>
                    <button
                      className={`settings-toggle ${showTracklistBpmKey ? 'active' : ''}`}
                      onClick={() => setShowTracklistBpmKey(!showTracklistBpmKey)}
                    >
                      {showTracklistBpmKey ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.genre" /></span>
                    <button
                      className={`settings-toggle ${showTracklistGenre ? 'active' : ''}`}
                      onClick={() => setShowTracklistGenre(!showTracklistGenre)}
                    >
                      {showTracklistGenre ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.added_date" /></span>
                    <button
                      className={`settings-toggle ${showTracklistAddedDate ? 'active' : ''}`}
                      onClick={() => setShowTracklistAddedDate(!showTracklistAddedDate)}
                    >
                      {showTracklistAddedDate ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.play_count" /></span>
                    <button
                      className={`settings-toggle ${showTracklistPlayCount ? 'active' : ''}`}
                      onClick={() => setShowTracklistPlayCount(!showTracklistPlayCount)}
                    >
                      {showTracklistPlayCount ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            {bitPerfectModeActive && (
              <p className="settings-note">
                {BIT_PERFECT_DSP_DISABLED_MESSAGE}
              </p>
            )}
            {normalizationTargetError && (
              <p className="settings-note settings-note-error">{normalizationTargetError}</p>
            )}
            {!normalizationEnabled && (
              <p className="settings-note settings-note-error">

                <LocalizedText ns="settings" i18nKey="auto.settingsview.replaygain_is_configured_but_playback_gain_is_bypassed_w" />
              </p>
            )}
            <RemoteServersPanel />
          </section>
            )}

            {activeSectionId === 'analyzer' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3><LocalizedText ns="settings" i18nKey="auto.settingsview.analyzer" /></h3>
            </div>
            <div className="settings-cards">
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.visualizer" /></div>
                <div className="settings-grid">
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.mini_player_visualizer" /></span>
                    <SettingsSegmentedControl
                      ariaLabel="Mini player visualizer"
                      fullWidth
                      options={MINI_PLAYER_VISUALIZER_OPTIONS}
                      value={miniPlayerVisualizerMode}
                      onChange={handleMiniPlayerVisualizerModeChange}
                    />
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.visualizer" /></span>
                    <button
                      className={`settings-toggle ${isRunning ? 'active' : ''}`}
                      onClick={() => setIsRunning(!isRunning)}
                    >
                      {isRunning ? translate('settings:auto.settingsview.running') : translate('settings:auto.settingsview.paused')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
            )}

            {activeSectionId === 'audio' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3><LocalizedText ns="settings" i18nKey="auto.settingsview.audio_output" /></h3>
            </div>
            <div className="settings-cards">
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.playback_path" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.playback_path" /></span>
                    <div className="settings-inline-row">
                      <button
                        className={`settings-toggle ${playbackOutputMode === 'standard' ? 'active' : ''}`}
                        onClick={() => handlePlaybackPathChange('standard')}
                      >

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.standard" />
                      </button>
                      <div className="settings-inline-row">
                        <button
                          className={`settings-toggle ${playbackOutputMode === 'bitperfect' ? 'active' : ''}`}
                          onClick={() => handlePlaybackPathChange('bitperfect')}
                        >

                          <LocalizedText ns="settings" i18nKey="auto.settingsview.bit_perfect_exclusive" />
                        </button>
                        <span className="settings-chip settings-chip-mono settings-chip-danger">

                          <LocalizedText ns="settings" i18nKey="auto.settingsview.experimental" />
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.native_status" /></span>
                    <div className="settings-inline-row">
                      <span className="settings-chip settings-chip-mono">
                        {nativeBackendLabel}
                      </span>
                      {nativeAudioCapabilities.activeSampleRate && (
                        <span className="settings-chip settings-chip-mono">
                          {(nativeAudioCapabilities.activeSampleRate / 1000).toFixed(1)} kHz
                        </span>
                      )}
                      <span className="settings-chip settings-chip-mono">
                        {nativeAudioCapabilities.activeDeviceExclusive ? translate('settings:auto.settingsview.exclusive') : translate('settings:auto.settingsview.shared_off')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="settings-audio-control">
              <AudioOutputSelect />
            </div>
            {playbackModeStatusMessage && (
              <p className="settings-note">
                {playbackModeStatusMessage}
              </p>
            )}
            {bitPerfectModeActive && (
              <p className="settings-note">
                {BIT_PERFECT_DSP_DISABLED_MESSAGE}
              </p>
            )}
            <DelayCompensationPanel />
            <ChannelRoutingPanel />
          </section>
            )}

            {activeSectionId === 'playback' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3><LocalizedText ns="settings" i18nKey="auto.settingsview.playback" /></h3>
            </div>
            <div className="settings-cards">
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.navigation" /></div>
                <div className="settings-grid">
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.jump_to_playing_opens" /></span>
                    <SettingsSegmentedControl
                      ariaLabel="Jump to Playing destination"
                      fullWidth
                      options={JUMP_TO_PLAYING_OPTIONS}
                      value={jumpToPlayingDestination}
                      onChange={setJumpToPlayingDestination}
                    />
                  </div>
                </div>
                {jumpToPlayingDestination !== DEFAULT_JUMP_TO_PLAYING_DESTINATION && (
                  <p className="settings-note"><LocalizedText ns="settings" i18nKey="auto.settingsview.default_smart_source" /></p>
                )}
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.sleep_timer" /></div>
                <div className="settings-sleep-controls">
                  <div className="settings-sleep-presets">
                    {SLEEP_TIMER_PRESET_MINUTES.map((minutes) => (
                      <button
                        key={minutes}
                        type="button"
                        className="settings-btn"
                        onClick={() => handleSleepTimerPreset(minutes)}
                        disabled={!canStartSleepTimer}
                      >
                        {minutes}  <LocalizedText ns="settings" i18nKey="auto.settingsview.min" />
                      </button>
                    ))}
                  </div>
                  <div className="settings-sleep-custom-row">
                    <input
                      className="settings-select"
                      type="number"
                      min={SLEEP_TIMER_MIN_MINUTES}
                      max={SLEEP_TIMER_MAX_MINUTES}
                      step={1}
                      value={sleepTimerCustomMinutesInput}
                      onChange={(event) => setSleepTimerCustomMinutesInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        handleSleepTimerCustomStart()
                      }}
                    />
                    <button
                      type="button"
                      className="settings-btn settings-btn-primary"
                      onClick={handleSleepTimerCustomStart}
                      disabled={!canStartSleepTimer}
                    >
                      {sleepTimerIsActive ? translate('settings:auto.settingsview.replace_timer') : translate('settings:auto.settingsview.start_timer')}
                    </button>
                    {sleepTimerIsActive && (
                      <button
                        type="button"
                        className="settings-btn"
                        onClick={handleSleepTimerCancel}
                      >

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.cancel" />
                      </button>
                    )}
                  </div>
                </div>
                <p className={`settings-note settings-sleep-status${sleepTimerIsActive ? ' settings-sleep-status-active' : ''}`}>
                  {sleepTimerStatusLabel}
                </p>
                {sleepTimerFeedback && (
                  <p className={`settings-note ${sleepTimerFeedbackTone === 'error' ? 'settings-note-error' : 'settings-note-success'}`}>
                    {sleepTimerFeedback}
                  </p>
                )}
                {!canStartSleepTimer && (
                  <p className="settings-note">

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.load_a_track_to_start_a_sleep_timer" />
                  </p>
                )}
              </div>
            </div>
          </section>
            )}

            {activeSectionId === 'keybinds' && <KeybindSettings />}

            {activeSectionId === 'integrations' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3><LocalizedText ns="settings" i18nKey="auto.settingsview.integrations" /></h3>
            </div>
            <div className="settings-integration-cards">
              <div className="settings-integration-card">
                <div className="settings-integration-card-head">
                  <h4><LocalizedText ns="settings" i18nKey="auto.settingsview.scrobbling" /></h4>
                  <p><LocalizedText ns="settings" i18nKey="auto.settingsview.now_playing_updates_and_scrobbles_for_your_connected_des" /></p>
                </div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.scrobbling" /></span>
                    <button
                      className={`settings-toggle ${lastFmEnabled ? 'active' : ''}`}
                      onClick={() => void setLastFmEnabled(!lastFmEnabled)}
                    >
                      {lastFmEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>

                  <div className="settings-field settings-lastfm-profiles-field">
                    <div className="settings-lastfm-profiles-head">
                      <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.destinations" /></span>
                      <button
                        type="button"
                        className="settings-btn settings-btn-primary"
                        onClick={openLastFmCreateProfileModal}
                      >

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.add_destination" />
                      </button>
                    </div>
                    <div className="settings-lastfm-profile-list">
                      {lastFmProfiles.map((profile) => {
                        const canToggleProfile = canToggleLastFmProfile(profile)
                        const profileAuthPending = lastFmAuthPending && lastFmAuthPendingProfileId === profile.id
                        const canConnectProfile = lastFmHasApiCredentials &&
                          profile.kind === 'official' &&
                          profile.protocol === 'lastfm2' &&
                          !profile.connected &&
                          !lastFmIsAuthorizing
                        const rowClassName = [
                          'settings-lastfm-profile-row',
                          profile.enabled ? 'active' : 'inactive',
                          !canToggleProfile ? 'blocked' : ''
                        ].filter(Boolean).join(' ')

                        return (
                          <div key={profile.id} className={rowClassName}>
                            <label className="settings-lastfm-profile-check">
                              <input
                                type="checkbox"
                                checked={profile.enabled}
                                disabled={!canToggleProfile}
                                onChange={() => handleToggleLastFmProfile(profile)}
                                aria-label={translate('settings:auto.settingsview.value1_name', { value1: profile.enabled ? 'Disable' : 'Enable', name: profile.name })}
                              />
                              <span aria-hidden="true" />
                            </label>
                            <div className="settings-lastfm-profile-main">
                              <div className="settings-lastfm-profile-title-row">
                                <span className="settings-lastfm-profile-name">{profile.name}</span>
                                <span className="settings-chip settings-chip-mono">
                                  {profile.protocolLabel}
                                </span>
                              </div>
                              <div className="settings-lastfm-profile-meta">
                                <span>{profile.apiBaseUrl}</span>
                                <span>
                                  {profile.connected
                                    ? profile.username
                                      ? translate('settings:auto.settingsview.connected_as_username', { username: profile.username })
                                      : translate('settings:auto.settingsview.token_configured')
                                    : translate('settings:auto.settingsview.not_connected')}
                                </span>
                                <span>{profile.pendingScrobbles}  <LocalizedText ns="settings" i18nKey="auto.settingsview.pending" /></span>
                                {profile.lastError && (
                                  <span className="settings-lastfm-profile-error">{profile.lastError}</span>
                                )}
                              </div>
                            </div>
                            <div className="settings-lastfm-profile-actions">
                              {profile.kind === 'official' && profile.protocol === 'lastfm2' && (!profile.connected || profileAuthPending) && (
                                <button
                                  type="button"
                                  className="settings-lastfm-icon-btn"
                                  onClick={() => void beginLastFmAuth(profile.id)}
                                  disabled={!canConnectProfile && !profileAuthPending}
                                  title={profileAuthPending ? translate('settings:auto.settingsview.authorization_pending') : translate('settings:auto.settingsview.connect')}
                                  aria-label={profileAuthPending ? translate('settings:auto.settingsview.authorization_pending') : translate('settings:auto.settingsview.connect_name', { name: profile.name })}
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M10.5 13.5L13.5 10.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                    <path d="M8.2 15.8L6.8 17.2C5.6 18.4 3.8 18.4 2.6 17.2C1.5 16 1.5 14.2 2.6 13L6.1 9.5C7.3 8.3 9.1 8.3 10.3 9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                    <path d="M15.8 8.2L17.2 6.8C18.4 5.6 20.2 5.6 21.4 6.8C22.5 8 22.5 9.8 21.4 11L17.9 14.5C16.7 15.7 14.9 15.7 13.7 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                  </svg>
                                </button>
                              )}
                              {profile.connected && (
                                <button
                                  type="button"
                                  className="settings-lastfm-icon-btn"
                                  onClick={() => void disconnectLastFmProfile(profile.id)}
                                  title={translate('settings:auto.settingsview.disconnect')}
                                  aria-label={translate('settings:auto.settingsview.disconnect_name', { name: profile.name })}
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M7 7L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                    <path d="M17 7L7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                  </svg>
                                </button>
                              )}
                              {profile.kind === 'custom' && (
                                <button
                                  type="button"
                                  className="settings-lastfm-icon-btn"
                                  onClick={() => openLastFmEditProfileModal(profile)}
                                  title={translate('settings:auto.settingsview.edit')}
                                  aria-label={translate('settings:auto.settingsview.edit_name', { name: profile.name })}
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M4 20H8.4L19.2 9.2C20.1 8.3 20.1 6.9 19.2 6L18 4.8C17.1 3.9 15.7 3.9 14.8 4.8L4 15.6V20Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                    <path d="M13.8 5.8L18.2 10.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                  </svg>
                                </button>
                              )}
                              {profile.canDelete && (
                                <button
                                  type="button"
                                  className="settings-lastfm-icon-btn danger"
                                  onClick={() => handleDeleteLastFmProfile(profile)}
                                  title={translate('settings:auto.settingsview.delete')}
                                  aria-label={translate('settings:auto.settingsview.delete_name', { name: profile.name })}
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M5 7H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                    <path d="M9 7V5H15V7" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                    <path d="M8 10V19H16V10" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
                <p className="settings-note">{lastFmStatusLabel}</p>
                <p className="settings-note">{lastFmQueueLabel}</p>
                {lastFmProfileFeedback && <p className="settings-note settings-note-success">{lastFmProfileFeedback}</p>}
                {lastFmAuthHint && <p className="settings-note settings-note-success">{lastFmAuthHint}</p>}
                {lastFmResolvedError && <p className="settings-note settings-note-error">{lastFmResolvedError}</p>}
                {!lastFmHasApiCredentials && (
                  <p className="settings-note settings-note-error">

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.last_fm_api_credentials_are_missing_in_this_build" />
                  </p>
                )}
              </div>

              <div className="settings-integration-card">
                <div className="settings-integration-card-head">
                  <h4><LocalizedText ns="settings" i18nKey="auto.settingsview.lyrics" /></h4>
                  <p><LocalizedText ns="settings" i18nKey="auto.settingsview.lrc_xlrc_embedded_lyrics_and_optional_xlrcdb_lrclib_look" /></p>
                </div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.online_lyrics_lookup" /></span>
                    <button
                      className={`settings-toggle ${lyricsEnabled ? 'active' : ''}`}
                      onClick={() => void setLyricsEnabled(!lyricsEnabled)}
                    >
                      {lyricsEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <label className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.lrclib_base_url" /></span>
                    <input
                      className="settings-select"
                      type="url"
                      value={lyricsLrclibBaseUrlInput}
                      onChange={(event) => setLyricsLrclibBaseUrlInput(event.target.value)}
                      onBlur={() => {
                        if (lyricsLrclibBaseUrlInput.trim() === lyricsStatus?.lrclibBaseUrl) return
                        void setLyricsLrclibBaseUrl(lyricsLrclibBaseUrlInput).then((status) => {
                          if (status) setLyricsLrclibBaseUrlInput(status.lrclibBaseUrl)
                        })
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      }}
                      placeholder={LRCLIB_OFFICIAL_BASE_URL}
                      spellCheck={false}
                    />
                  </label>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.xlrc_word_timing" /></span>
                    <button
                      className={`settings-toggle ${lyricsDisplaySettings.wordTimingEnabled ? 'active' : ''}`}
                      onClick={() => setLyricsWordTimingEnabled(!lyricsDisplaySettings.wordTimingEnabled)}
                    >
                      {lyricsDisplaySettings.wordTimingEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.xlrc_furigana" /></span>
                    <button
                      className={`settings-toggle ${lyricsDisplaySettings.furiganaEnabled ? 'active' : ''}`}
                      onClick={() => setLyricsFuriganaEnabled(!lyricsDisplaySettings.furiganaEnabled)}
                    >
                      {lyricsDisplaySettings.furiganaEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.xlrc_translations" /></span>
                    <button
                      className={`settings-toggle ${lyricsDisplaySettings.translationsEnabled ? 'active' : ''}`}
                      onClick={() => setLyricsTranslationsEnabled(!lyricsDisplaySettings.translationsEnabled)}
                    >
                      {lyricsDisplaySettings.translationsEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.xlrc_voice_labels" /></span>
                    <button
                      className={`settings-toggle ${lyricsDisplaySettings.voiceLabelsEnabled ? 'active' : ''}`}
                      onClick={() => setLyricsVoiceLabelsEnabled(!lyricsDisplaySettings.voiceLabelsEnabled)}
                    >
                      {lyricsDisplaySettings.voiceLabelsEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <label className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.translation_priority" /></span>
                    <input
                      className="settings-select"
                      type="text"
                      value={lyricsTranslationPriorityInput}
                      onChange={(event) => setLyricsTranslationPriorityInput(event.target.value)}
                      onBlur={() => setLyricsTranslationLanguagePriority(lyricsTranslationPriorityInput)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          setLyricsTranslationLanguagePriority(lyricsTranslationPriorityInput)
                        }
                      }}
                      placeholder={translate('settings:auto.settingsview.en_ja_latn')}
                    />
                  </label>
                </div>
                <p className="settings-note">{lyricsStatusLabel}</p>
                <p className="settings-note"><Trans ns="settings" i18nKey="auto.settingsview.astra_appends_1_api_get_1_and_3_api_search_3_http_is">Astra appends <code>/api/get</code> and <code>/api/search</code>. HTTP is supported for local mirrors.</Trans></p>
                <p className="settings-note"><LocalizedText ns="settings" i18nKey="auto.settingsview.xlrc_translation_codes_are_matched_left_to_right_with_th" /></p>
                {lyricsResolvedError && <p className="settings-note settings-note-error">{lyricsResolvedError}</p>}
              </div>

              <div className="settings-integration-card">
                <div className="settings-integration-card-head">
                  <h4><LocalizedText ns="settings" i18nKey="auto.settingsview.discord" /></h4>
                  <p><LocalizedText ns="settings" i18nKey="auto.settingsview.discord_rich_presence_integration" /></p>
                </div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.discord_rich_presence" /></span>
                    <button
                      className={`settings-toggle ${discordEnabled ? 'active' : ''}`}
                      onClick={() => void setDiscordEnabled(!discordEnabled)}
                    >
                      {discordEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.discord_cover_art_internet_lookup" /></span>
                    <button
                      className={`settings-toggle ${discordCoverArtEnabled ? 'active' : ''}`}
                      onClick={() => void setDiscordCoverArtEnabled(!discordCoverArtEnabled)}
                      disabled={!discordEnabled}
                    >
                      {discordCoverArtEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.astra_icon_on_cover_art" /></span>
                    <button
                      className={`settings-toggle ${discordSmallIconEnabled ? 'active' : ''}`}
                      onClick={() => void setDiscordSmallIconEnabled(!discordSmallIconEnabled)}
                      disabled={!discordEnabled || !discordCoverArtEnabled}
                    >
                      {discordSmallIconEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.compact_status" /></span>
                    <SettingsSegmentedControl
                      ariaLabel="Discord compact status"
                      disabled={!discordEnabled}
                      options={DISCORD_COMPACT_STATUS_OPTIONS}
                      value={discordCompactStatusMode}
                      onChange={(value) => void setDiscordCompactStatusMode(value)}
                    />
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.profile_info_line" /></span>
                    <SettingsSegmentedControl
                      ariaLabel="Discord profile info line"
                      disabled={!discordEnabled}
                      options={DISCORD_EXPANDED_INFO_OPTIONS}
                      value={discordExpandedInfoMode}
                      onChange={(value) => void setDiscordExpandedInfoMode(value)}
                    />
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.title_artist_links" /></span>
                    <SettingsSegmentedControl
                      ariaLabel="Discord title and artist links"
                      className="settings-segmented-control-wide"
                      disabled={!discordEnabled}
                      options={DISCORD_LINK_DESTINATION_OPTIONS}
                      value={discordLinkDestination}
                      onChange={(value) => void setDiscordLinkDestination(value)}
                    />
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.clear_when_paused" /></span>
                    <SettingsSegmentedControl
                      ariaLabel="Discord clear presence when paused"
                      className="settings-segmented-control-wide"
                      disabled={!discordEnabled}
                      options={DISCORD_PAUSE_CLEAR_OPTIONS}
                      value={discordPauseClearMinutes}
                      onChange={(value) => void setDiscordPauseClearMinutes(value)}
                    />
                  </div>
                </div>
                <p className="settings-note">{discordStatusMessage}</p>
              </div>

              <div className="settings-integration-card">
                <div className="settings-integration-card-head">
                  <h4><LocalizedText ns="settings" i18nKey="auto.settingsview.local_api" /></h4>
                  <p><LocalizedText ns="settings" i18nKey="auto.settingsview.companion_api_for_local_automations_launchers_widgets_an" /></p>
                </div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.local_integration_api" /></span>
                    <button
                      className={`settings-toggle ${localApiEnabled ? 'active' : ''}`}
                      onClick={() => void setLocalApiEnabled(!localApiEnabled)}
                    >
                      {localApiEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>

                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.external_playback_controls" /></span>
                    <button
                      className={`settings-toggle ${localApiControlsEnabled ? 'active' : ''}`}
                      onClick={() => void setLocalApiControlsEnabled(!localApiControlsEnabled)}
                    >
                      {localApiControlsEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>

                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.library_search" /></span>
                    <button
                      className={`settings-toggle ${localApiLibrarySearchEnabled ? 'active' : ''}`}
                      onClick={() => void setLocalApiLibrarySearchEnabled(!localApiLibrarySearchEnabled)}
                    >
                      {localApiLibrarySearchEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>

                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.favorites_playlist_changes" /></span>
                    <button
                      className={`settings-toggle ${localApiLibraryWriteEnabled ? 'active' : ''}`}
                      onClick={() => void setLocalApiLibraryWriteEnabled(!localApiLibraryWriteEnabled)}
                    >
                      {localApiLibraryWriteEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>

                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.local_api_port" /></span>
                    <div className="settings-inline-row">
                      <input
                        className="settings-select settings-inline-input settings-inline-input-compact"
                        type="number"
                        min={LOCAL_API_MIN_PORT}
                        max={LOCAL_API_MAX_PORT}
                        step={1}
                        value={localApiPortInput}
                        onChange={(event) => setLocalApiPortInput(event.target.value)}
                        onBlur={handleSaveLocalApiPort}
                      />
                      <button className="settings-btn" onClick={handleSaveLocalApiPort}>

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.save" />
                      </button>
                    </div>
                  </div>

                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.local_api_endpoint" /></span>
                    <div className="settings-inline-row">
                      <span className="settings-chip settings-chip-mono settings-chip-grow">
                        {localApiBaseUrl}
                      </span>
                      <button
                        className="settings-btn"
                        onClick={() => void copyToClipboard(`${localApiBaseUrl}/v2/capabilities`, 'Endpoint')}
                      >

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.copy" />
                      </button>
                    </div>
                  </div>

                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.local_api_key" /></span>
                    <div className="settings-inline-row">
                      <span className="settings-chip settings-chip-mono settings-chip-grow">
                        {localApiToken
                          ? (showApiKey ? localApiToken : '•'.repeat(Math.min(localApiToken.length, 24)))
                          : translate('settings:auto.settingsview.unavailable')}
                      </span>
                      <button
                        className="settings-btn"
                        onClick={() => setShowApiKey((v) => !v)}
                        disabled={!localApiToken}
                      >
                        {showApiKey ? translate('settings:auto.settingsview.hide') : translate('settings:auto.settingsview.show')}
                      </button>
                      <button
                        className="settings-btn"
                        onClick={() => void copyToClipboard(localApiToken, 'API key')}
                        disabled={!localApiToken}
                      >

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.copy" />
                      </button>
                      <button className="settings-btn settings-btn-primary" onClick={handleRotateLocalApiToken}>

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.regenerate" />
                      </button>
                    </div>
                  </div>
                </div>
                <p className="settings-note">{localApiStatusLabel}</p>
                {localApiFeedback && <p className="settings-note settings-note-success">{localApiFeedback}</p>}
                {localApiErrorMessage && <p className="settings-note settings-note-error">{localApiErrorMessage}</p>}
              </div>
            </div>
          </section>
            )}

            {activeSectionId === 'experimental' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3><LocalizedText ns="settings" i18nKey="auto.settingsview.experimental" /></h3>
            </div>
            <div className="settings-cards">
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.controller_support" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.controller_support" /></span>
                    <button
                      className={`settings-toggle ${controllerSupportEnabled ? 'active' : ''}`}
                      onClick={() => setControllerSupportEnabled(!controllerSupportEnabled)}
                    >
                      {controllerSupportEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <p className="settings-note">

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.navigate_astra_with_an_xbox_or_playstation_controller_d_" />
                  </p>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.activity_indicator" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.scope_rail_activity_indicator" /></span>
                    <button
                      className={`settings-toggle ${activityIndicatorExperimentEnabled ? 'active' : ''}`}
                      onClick={() => setActivityIndicatorExperimentEnabled(!activityIndicatorExperimentEnabled)}
                    >
                      {activityIndicatorExperimentEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <p className="settings-note">

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.replaces_the_scope_editor_rail_dot_with_an_adaptive_5x5_" />
                  </p>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.library_graph" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.library_graph" /></span>
                    <button
                      className={`settings-toggle ${libraryGraphEnabled ? 'active' : ''}`}
                      onClick={() => setLibraryGraphEnabled(!libraryGraphEnabled)}
                    >
                      {libraryGraphEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.open_graph" /></span>
                    <button
                      className="settings-btn"
                      disabled={!libraryGraphEnabled}
                      onClick={() => {
                        openFullGraph()
                        setActiveView('graph')
                      }}
                    >

                      <LocalizedText ns="settings" i18nKey="auto.settingsview.open_full_map" />
                    </button>
                  </div>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.listening_stats" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.listening_stats" /></span>
                    <button
                      className={`settings-toggle ${listeningStatsEnabled ? 'active' : ''}`}
                      onClick={() => setListeningStatsEnabled(!listeningStatsEnabled)}
                    >
                      {listeningStatsEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.open_stats" /></span>
                    <button
                      className="settings-btn"
                      disabled={!listeningStatsEnabled}
                      onClick={() => setActiveView('stats')}
                    >

                      <LocalizedText ns="settings" i18nKey="auto.settingsview.open_listening_stats" />
                    </button>
                  </div>
                  <p className="settings-note">

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.shows_local_listening_time_plays_and_rankings_detailed_h" />
                  </p>
                </div>
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.library_integrity_check" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.integrity_check" /></span>
                    <button
                      className={`settings-toggle ${libraryIntegrityEnabled ? 'active' : ''}`}
                      onClick={() => setLibraryIntegrityEnabled(!libraryIntegrityEnabled)}
                    >
                      {libraryIntegrityEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.open_scanner" /></span>
                    <button
                      className="settings-btn"
                      disabled={!libraryIntegrityEnabled}
                      onClick={openLibraryIntegrityPanel}
                    >

                      <LocalizedText ns="settings" i18nKey="auto.settingsview.open_integrity_check" />
                    </button>
                  </div>
                  <p className="settings-note">

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.quick_scans_inspect_local_file_headers_and_metadata_deep" />
                  </p>
                </div>
              </div>
              <div className="settings-integration-card">
                <div className="settings-integration-card-head">
                  <h4><LocalizedText ns="settings" i18nKey="auto.settingsview.phone_remote" /></h4>
                  <p><LocalizedText ns="settings" i18nKey="auto.settingsview.opt_in_lan_controller_surface_for_the_phone_pwa" /></p>
                </div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.phone_remote" /></span>
                    <button
                      className={`settings-toggle ${phoneRemoteEnabled ? 'active' : ''}`}
                      onClick={() => void setPhoneRemoteEnabled(!phoneRemoteEnabled)}
                    >
                      {phoneRemoteEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.phone_remote_port" /></span>
                    <div className="settings-inline-row">
                      <input
                        className="settings-select settings-inline-input settings-inline-input-compact"
                        type="number"
                        min={PHONE_REMOTE_MIN_PORT}
                        max={PHONE_REMOTE_MAX_PORT}
                        step={1}
                        value={phoneRemotePortInput}
                        onChange={(event) => setPhoneRemotePortInput(event.target.value)}
                        onBlur={handleSavePhoneRemotePort}
                      />
                      <button className="settings-btn" onClick={handleSavePhoneRemotePort}>

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.save" />
                      </button>
                    </div>
                  </div>
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.status" /></span>
                    <span className="settings-info-value">{localApiPhoneRemoteSummary}</span>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.pair_a_new_phone" /></span>
                    <button
                      className="settings-btn settings-btn-primary"
                      onClick={handleOpenPhoneRemotePairingModal}
                    >

                      <LocalizedText ns="settings" i18nKey="auto.settingsview.pair_phone" />
                    </button>
                  </div>
                </div>
                {phoneRemoteFeedback && <p className="settings-note settings-note-success">{phoneRemoteFeedback}</p>}
                {phoneRemoteErrorMessage && <p className="settings-note settings-note-error">{phoneRemoteErrorMessage}</p>}

                {/* Inline paired devices */}
                {localApiActiveDevices.length > 0 && (
                  <div className="local-api-inline-devices">
                    <div className="local-api-inline-devices-header">
                      <span className="local-api-inline-devices-count">
                        {localApiActiveDevices.length}  <LocalizedText ns="settings" i18nKey="auto.settingsview.paired_phone" />{localApiActiveDevices.length !== 1 ? translate('settings:auto.settingsview.s') : ''}
                      </span>
                      {localApiControllerUrl && localApiInlineQrSvg && (
                        <button
                          className={`settings-btn${showInlinePhoneQr ? ' settings-btn-primary' : ''}`}
                          onClick={() => setShowInlinePhoneQr((prev) => !prev)}
                        >
                          {showInlinePhoneQr ? translate('settings:auto.settingsview.hide_qr') : translate('settings:auto.settingsview.open_on_phone')}
                        </button>
                      )}
                    </div>

                    {showInlinePhoneQr && localApiControllerUrl && localApiInlineQrSvg && (
                      <div className="local-api-inline-qr">
                        <div className="local-api-pairing-qr" dangerouslySetInnerHTML={{ __html: localApiInlineQrSvg }} />
                        <p className="settings-note" style={{ textAlign: 'center', margin: 0 }}><LocalizedText ns="settings" i18nKey="auto.settingsview.scan_to_open_the_remote_no_new_pairing_needed" /></p>
                        <button
                          className="settings-btn settings-btn-primary"
                          onClick={() => { void navigator.clipboard.writeText(localApiControllerUrl) }}
                        >

                          <LocalizedText ns="settings" i18nKey="auto.settingsview.copy_link" />
                        </button>
                      </div>
                    )}

                    <div className="local-api-inline-devices-list">
                      {localApiActiveDevices.map((device) => (
                        <div key={device.id} className="local-api-inline-device">
                          <div className="local-api-inline-device-info">
                            <span className="local-api-inline-device-name">{device.name}</span>
                            <span className="local-api-inline-device-detail">

                              <LocalizedText ns="settings" i18nKey="auto.settingsview.last_seen" /> {device.lastSeenAt
                                ? formatLocaleDate(device.lastSeenAt, { dateStyle: 'medium', timeStyle: 'short' })
                                : translate('settings:auto.settingsview.never')}
                            </span>
                          </div>
                          <button
                            className="settings-btn settings-btn-danger"
                            onClick={() => handleRevokePhoneRemotePairedDevice(device.id)}
                          >

                            <LocalizedText ns="settings" i18nKey="auto.settingsview.revoke" />
                          </button>
                        </div>
                      ))}
                      {localApiActiveDevices.length >= 2 && (
                        <button className="settings-btn settings-btn-danger" onClick={handleRevokeAllPhoneRemoteDevices}>

                          <LocalizedText ns="settings" i18nKey="auto.settingsview.revoke_all" />
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="settings-integration-card">
                <div className="settings-integration-card-head">
                  <h4><LocalizedText ns="settings" i18nKey="auto.settingsview.library_sync" /></h4>
                  <p><LocalizedText ns="settings" i18nKey="auto.settingsview.two_way_favorites_and_playlist_sync_with_paired_phones_i" /></p>
                </div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.library_sync" /></span>
                    <button
                      className={`settings-toggle ${phoneRemoteSyncEnabled ? 'active' : ''}`}
                      onClick={() => void setPhoneRemoteSyncEnabled(!phoneRemoteSyncEnabled)}
                    >
                      {phoneRemoteSyncEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.sync_now" /></span>
                    <button
                      className="settings-btn settings-btn-primary"
                      disabled={!phoneRemoteEnabled || !phoneRemoteSyncEnabled || phoneRemotePairedDeviceCount === 0}
                      onClick={() => void requestPhoneRemoteSync()}
                    >
                      {phoneRemoteSync?.requestedAt ? translate('settings:auto.settingsview.waiting_for_phone') : translate('settings:auto.settingsview.sync_now')}
                    </button>
                  </div>
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.last_synced" /></span>
                    <span className="settings-info-value">
                      {phoneRemoteSync?.lastSyncedAt
                        ? formatLocaleDate(phoneRemoteSync.lastSyncedAt, { dateStyle: 'medium', timeStyle: 'short' })
                        : translate('settings:auto.settingsview.never_the_phone_runs_the_sync_it_picks_requests_up_when_')}
                    </span>
                  </div>
                </div>
                {phoneRemoteSyncConflictCount > 0 && (
                  <div className="local-api-inline-devices">
                    <div className="local-api-inline-devices-header">
                      <span className="local-api-inline-devices-count">
                        {phoneRemoteSyncConflictCount}  <LocalizedText ns="settings" i18nKey="auto.settingsview.sync_conflict" />{phoneRemoteSyncConflictCount !== 1 ? translate('settings:auto.settingsview.s') : ''}  <LocalizedText ns="settings" i18nKey="auto.settingsview.need_attention" />
                      </span>
                      <button className="settings-btn settings-btn-primary" onClick={openPhoneSyncConflictResolver}>

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.review_conflicts" />
                      </button>
                    </div>
                    <p className="settings-note">
                      {phoneRemoteSyncPendingCount > 0
                        ? translate('settings:auto.settingsview.phoneremotesyncpendingcount_choice_value2_waiting_for_th', { phoneremotesyncpendingcount: phoneRemoteSyncPendingCount, value2: phoneRemoteSyncPendingCount === 1 ? '' : 's' })
                        : translate('settings:auto.settingsview.open_the_resolver_to_compare_both_playlists_and_preview_')}
                    </p>
                  </div>
                )}
              </div>
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.parallax" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.enable_parallax" /></span>
                    <button
                      className={`settings-toggle ${parallaxExperimentEnabled ? 'active' : ''}`}
                      onClick={() => handleToggleParallaxExperiment(!parallaxExperimentEnabled)}
                    >
                      {parallaxExperimentEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                    </button>
                  </div>
                  <p className="settings-note">

                    <Trans ns="settings" i18nKey="auto.settingsview.experimental_lan_multi_room_sync_reveals_a_dedicated_1">Experimental LAN multi-room sync. Reveals a dedicated <strong>Parallax</strong> section where you choose whether this machine plays music or acts as a speaker. Turning this off stops all Parallax networking on this machine and hides the section.</Trans>
                  </p>
                </div>
              </div>
            </div>
          </section>
            )}

            {activeSectionId === 'parallax' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3><LocalizedText ns="settings" i18nKey="auto.settingsview.parallax" /></h3>
            </div>
            <div className="settings-cards">
              <ParallaxSettingsPanel />
            </div>
          </section>
            )}

            {activeSectionId === 'info' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3><LocalizedText ns="settings" i18nKey="auto.settingsview.info" /></h3>
            </div>
            <div className="settings-cards">
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.updates" /></div>
                <div className="settings-grid">
                  <div className="settings-field">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.app_version_055c4ce" /></span>
                    <div className="settings-version-inline">
                      <button
                        type="button"
                        className="settings-version-reveal-btn settings-info-value"
                        onClick={handleAppVersionClick}
                        aria-label={developerSectionVisible ? translate('settings:auto.settingsview.open_developer_settings') : translate('settings:auto.settingsview.app_version')}
                      >
                        {appVersionLabel}
                      </button>
                      {appBuildLabel && (
                        <button
                          type="button"
                          className="settings-build-copy-btn"
                          title={appBuildTooltip || undefined}
                          aria-label={translate('settings:auto.settingsview.copy_full_build_hash')}
                          onClick={() => void copyInfoToClipboard(appBuildCopyValue, 'Build hash')}
                        >
                          {appBuildLabel}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="settings-fields-row">
                    <div className="settings-field settings-field-inline">
                      <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.auto_check_on_startup" /></span>
                      <button
                        className={`settings-toggle ${autoCheckEnabled ? 'active' : ''}`}
                        onClick={() => setAutoCheckEnabled(!autoCheckEnabled)}
                      >
                        {autoCheckEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                      </button>
                    </div>
                    <div className="settings-field settings-field-inline">
                      <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.check_for_updates" /></span>
                      <button
                        className="settings-btn settings-btn-primary"
                        onClick={() => void checkForUpdates()}
                        disabled={updateCheckState === 'checking'}
                      >
                        {updateCheckState === 'checking' ? translate('settings:auto.settingsview.checking') : translate('settings:auto.settingsview.check_now')}
                      </button>
                    </div>
                    <div className="settings-field settings-field-inline">
                      <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.download" /></span>
                      <button
                        className="settings-btn"
                        onClick={() => void openReleasesPage()}
                      >

                        <LocalizedText ns="settings" i18nKey="auto.settingsview.open_releases" />
                      </button>
                    </div>
                  </div>
                </div>
                {infoFeedback && (
                  <p className={`settings-note ${infoFeedbackTone === 'success' ? 'settings-note-success' : 'settings-note-error'}`}>
                    {infoFeedback}
                  </p>
                )}
                <p className={`settings-note settings-update-status settings-update-status-${updateStatusTone}`}>
                  {updateStatusMessage}
                </p>
                {updateAvailable && latestTag && (
                  <p className="settings-note settings-update-meta">

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.latest_release" /> {latestTag}{releaseName ? translate('settings:auto.settingsview.releasename', { releasename: releaseName }) : ''}
                  </p>
                )}
                <p className="settings-note settings-update-meta">
                  {lastCheckedAt ? translate('settings:auto.settingsview.last_checked_lastcheckedlabel', { lastcheckedlabel: lastCheckedLabel }) : lastCheckedLabel}
                </p>
              </div>
            </div>
            <div className="settings-info-panels">
              <div className="settings-info-panel">
                <h4><LocalizedText ns="settings" i18nKey="auto.settingsview.attribution" /></h4>
                <p><LocalizedText ns="settings" i18nKey="auto.settingsview.astra_is_created_and_maintained_by_boof2015" /></p>
                <p className="settings-info-meta"><LocalizedText ns="settings" i18nKey="auto.settingsview.contact_contact_novaml_ai" /></p>
                <div className="settings-info-links">
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(ASTRA_REPOSITORY_URL)}
                  >

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.github_repository" />
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(ASTRA_DISCORD_URL)}
                  >

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.discord" />
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-link-btn settings-link-btn-kofi"
                    onClick={() => openExternalLink(ASTRA_SUPPORT_URL)}
                  >

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.ko_fi" />
                    <span className="settings-link-btn-heart" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="settings-info-panel">
                <h4><LocalizedText ns="settings" i18nKey="auto.settingsview.license" /></h4>
                <p><LocalizedText ns="settings" i18nKey="auto.settingsview.astra_is_distributed_under_gpl_3_0_only" /></p>
                <div className="settings-info-links">
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(ASTRA_LICENSE_URL)}
                  >

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.view_license" />
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(GPL_V3_URL)}
                  >

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.gpl_v3_text" />
                  </button>
                </div>
              </div>
            </div>
            <div className="settings-cards settings-info-transfer-card">
              <div className="settings-card">
                <div className="settings-card-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.settings_transfer" /></div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.portable_settings" /></span>
                    <button
                      type="button"
                      className="settings-btn settings-btn-primary"
                      onClick={() => setSettingsTransferWizardOpen(true)}
                    >

                      <LocalizedText ns="settings" i18nKey="auto.settingsview.open_settings_transfer_wizard" />
                    </button>
                  </div>
                </div>
                <p className="settings-note">

                  <LocalizedText ns="settings" i18nKey="auto.settingsview.import_or_export_your_astra_settings_to_move_preferences" />
                </p>
              </div>
            </div>
          </section>
            )}

            {activeSectionId === 'developer' && developerSectionVisible && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3><LocalizedText ns="settings" i18nKey="auto.settingsview.developer" /></h3>
            </div>
            <div className="settings-actions settings-info-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={handleHideDeveloperSection}
              >

                <LocalizedText ns="settings" i18nKey="auto.settingsview.hide_developer_section" />
              </button>
            </div>
            <div className="settings-info-panels">
              <div className="settings-info-panel">
                <h4><LocalizedText ns="settings" i18nKey="auto.settingsview.memory_diagnostics" /></h4>
                <p>

                  <LocalizedText ns="settings" i18nKey="auto.settingsview.writes_a_csv_memory_log_every" /> {diagnosticsSampleIntervalLabel}  <LocalizedText ns="settings" i18nKey="auto.settingsview.plus_playback_breadcrumbs_so_you_can_correlate_growth_wi" />
                </p>
                <div className="settings-field settings-field-inline">
                  <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.diagnostics_logging" /></span>
                  <button
                    type="button"
                    className={`settings-toggle ${diagnosticsEnabled ? 'active' : ''}`}
                    onClick={() => void setDiagnosticsEnabled(!diagnosticsEnabled)}
                    disabled={diagnosticsIsLoading && diagnosticsStatus === null}
                  >
                    {diagnosticsEnabled ? translate('settings:auto.settingsview.enabled') : translate('settings:auto.settingsview.disabled')}
                  </button>
                </div>
                <p className="settings-info-meta"><LocalizedText ns="settings" i18nKey="auto.settingsview.current_log" /></p>
                <p className="settings-info-path">{diagnosticsCurrentLogPath}</p>
                <p className="settings-info-meta"><LocalizedText ns="settings" i18nKey="auto.settingsview.previous_log" /></p>
                <p className="settings-info-path">{diagnosticsPreviousLogPath}</p>
                <p className="settings-info-meta">{diagnosticsSessionLabel}</p>
                <div className="settings-info-links">
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => void captureDiagnosticsBundle()}
                    disabled={diagnosticsIsCapturingBundle}
                  >
                    {diagnosticsIsCapturingBundle ? translate('settings:auto.settingsview.capturing_bundle') : translate('settings:auto.settingsview.capture_memory_bundle')}
                  </button>
                </div>
                <p className="settings-info-meta">{diagnosticsLastBundleLabel}</p>
                {diagnosticsLastCaptureResult && (
                  <p className="settings-info-path">{diagnosticsLastCaptureResult.directoryPath}</p>
                )}
                {diagnosticsErrorMessage && (
                  <p className="settings-note settings-note-error">{diagnosticsErrorMessage}</p>
                )}
                <div className="settings-info-links">
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => void revealCurrentLog()}
                    disabled={!diagnosticsStatus?.hasCurrentLog}
                  >

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.reveal_current_log" />
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => void revealPreviousLog()}
                    disabled={!diagnosticsStatus?.hasPreviousLog}
                  >

                    <LocalizedText ns="settings" i18nKey="auto.settingsview.reveal_previous_log" />
                  </button>
                </div>
              </div>
              <div className="settings-info-panel">
                <h4><LocalizedText ns="settings" i18nKey="auto.settingsview.playback_overrides" /></h4>
                {import.meta.env.DEV ? (
                  <>
                    <p><LocalizedText ns="settings" i18nKey="auto.settingsview.temporary_switches_for_isolating_standard_mode_playback_" /></p>
                    <div className="settings-grid">
                      <div className="settings-field settings-field-inline">
                        <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.disable_gapless_prebuffer" /></span>
                        <button
                          className={`settings-toggle ${disableGaplessPrebufferDev ? 'active' : ''}`}
                          onClick={() => setDisableGaplessPrebufferDev(!disableGaplessPrebufferDev)}
                        >
                          {disableGaplessPrebufferDev ? translate('settings:auto.settingsview.disabled') : translate('settings:auto.settingsview.enabled')}
                        </button>
                      </div>
                      <div className="settings-field settings-field-inline">
                        <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.disable_analysis_eq_taps" /></span>
                        <button
                          className={`settings-toggle ${disableStandardAnalysisGraphDev ? 'active' : ''}`}
                          onClick={() => setDisableStandardAnalysisGraphDev(!disableStandardAnalysisGraphDev)}
                        >
                          {disableStandardAnalysisGraphDev ? translate('settings:auto.settingsview.disabled') : translate('settings:auto.settingsview.enabled')}
                        </button>
                      </div>
                    </div>
                    <p className="settings-note">

                      <LocalizedText ns="settings" i18nKey="auto.settingsview.when_gapless_prebuffer_is_disabled_astra_stops_preloadin" />
                    </p>
                    <p className="settings-note">

                      <LocalizedText ns="settings" i18nKey="auto.settingsview.when_analysis_and_eq_taps_are_disabled_astra_bypasses_th" />
                    </p>
                  </>
                ) : (
                  <>
                    <p><LocalizedText ns="settings" i18nKey="auto.settingsview.playback_override_switches_are_only_available_in_develop" /></p>
                    <p className="settings-note">

                      <LocalizedText ns="settings" i18nKey="auto.settingsview.production_builds_keep_these_toggles_off_and_ignore_thei" />
                    </p>
                  </>
                )}
              </div>
            </div>
          </section>
            )}

            {activeSectionId === 'danger' && (
            <section className="settings-section settings-section-panel settings-danger-zone">
            <div className="settings-section-head">
              <h3><LocalizedText ns="settings" i18nKey="auto.settingsview.danger_zone" /></h3>
            </div>
            <div className="settings-danger-groups">
              <div className="settings-danger-group">
                <p className="settings-danger-group-title"><LocalizedText ns="settings" i18nKey="auto.settingsview.safe_resets" /></p>
                <p className="settings-danger-group-description">

                  <LocalizedText ns="settings" i18nKey="auto.settingsview.reset_app_preferences_while_keeping_primary_library_data" />
                </p>
                <div className="settings-danger-list">
                  {safeResetActions.map((action) => renderResetAction(action))}
                </div>
              </div>
              <div className="settings-danger-group settings-danger-group-destructive">
                <p className="settings-danger-group-title"><LocalizedText ns="settings" i18nKey="auto.settingsview.destructive_resets" /></p>
                <p className="settings-danger-group-description">

                  <LocalizedText ns="settings" i18nKey="auto.settingsview.remove_indexed_media_data_or_perform_a_full_wipe" />
                </p>
                <div className="settings-danger-list">
                  {destructiveResetActions.map((action) => renderResetAction(action))}
                </div>
              </div>
            </div>
            {isScanning && (
              <p className="settings-note settings-danger-note">

                <LocalizedText ns="settings" i18nKey="auto.settingsview.destructive_resets_are_disabled_while_library_scanning_i" />
              </p>
            )}
          </section>
            )}
          </div>
        </div>
      </div>
      <FolderSettings
        isOpen={showFolderSettings}
        onClose={() => setShowFolderSettings(false)}
      />
      <ConfirmActionModal
        isOpen={pendingReset != null}
        title={pendingReset?.confirmTitle ?? ''}
        message={pendingReset?.confirmMessage ?? ''}
        confirmLabel={pendingReset?.confirmLabel ?? 'Confirm'}
        typedPhrase={pendingReset?.typedPhrase ?? null}
        isDestructive={pendingReset?.destructive ?? false}
        isBusy={pendingReset ? resetStatuses[pendingReset.id].state === 'running' : false}
        onCancel={() => {
          if (pendingReset && resetStatuses[pendingReset.id].state === 'running') return
          setPendingResetId(null)
        }}
        onConfirm={() => {
          if (!pendingReset) return
          void executeResetAction(pendingReset.id)
        }}
      />
      <ConfirmActionModal
        isOpen={normalizationDisableStep != null}
        title={normalizationDisableStep === 'warning' ? translate('settings:auto.settingsview.disable_normalization') : translate('settings:auto.settingsview.final_safety_check')}
        message={normalizationDisableStep === 'warning'
          ? 'Disabling normalization removes automatic loudness protection. Tracks can jump to unsafe levels and may cause hearing damage.'
          : 'You are about to disable all playback normalization (including ReplayGain gain application). Continue only if you understand the risks and control output volume carefully.'}
        confirmLabel={normalizationDisableStep === 'warning' ? 'Continue' : 'Disable Normalization'}
        isDestructive
        onCancel={() => setNormalizationDisableStep(null)}
        onConfirm={handleConfirmDisableNormalization}
      />
      <BitPerfectModeWarningModal
        isOpen={showBitPerfectWarning}
        dontShowAgain={dontShowBitPerfectWarningAgain}
        onDontShowAgainChange={setDontShowBitPerfectWarningAgain}
        onCancel={() => setShowBitPerfectWarning(false)}
        onConfirm={handleConfirmBitPerfectWarning}
      />
      {lastFmProfilePresence.shouldRender && (
        <div
          className="modal-overlay"
          data-presence={lastFmProfilePresence.phase}
          aria-hidden={lastFmProfilePresence.phase === 'exiting'}
          onClick={closeLastFmProfileModal}
        >
          <div
            className="modal-content settings-lastfm-profile-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2>{lastFmProfilePresence.presentValue}</h2>
              <button className="modal-close" onClick={closeLastFmProfileModal} aria-label={translate('settings:auto.settingsview.close')}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
            <div className="modal-body settings-lastfm-profile-form">
              <label className="settings-field">
                <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.destination_name" /></span>
                <input
                  className="settings-select"
                  type="text"
                  value={lastFmProfileNameInput}
                  autoFocus
                  onChange={(event) => setLastFmProfileNameInput(event.target.value)}
                />
              </label>
              <div className="settings-field">
                <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.protocol" /></span>
                <SettingsSegmentedControl
                  ariaLabel="Scrobble protocol"
                  fullWidth
                  options={CUSTOM_SCROBBLE_PROTOCOL_OPTIONS}
                  value={lastFmProfileProtocolInput}
                  onChange={handleLastFmProfileProtocolChange}
                />
              </div>
              <label className="settings-field">
                <span className="settings-field-label"><LocalizedText ns="settings" i18nKey="auto.settingsview.api_base_url" /></span>
                <input
                  className="settings-select"
                  type="url"
                  value={lastFmProfileUrlInput}
                  placeholder={getScrobbleUrlPlaceholder(lastFmProfileProtocolInput)}
                  onChange={(event) => setLastFmProfileUrlInput(event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span className="settings-field-label">{getScrobbleUsernameLabel(lastFmProfileProtocolInput)}</span>
                <input
                  className="settings-select"
                  type="text"
                  value={lastFmProfileUsernameInput}
                  autoComplete="off"
                  onChange={(event) => setLastFmProfileUsernameInput(event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span className="settings-field-label">{getScrobbleSecretLabel(lastFmProfileProtocolInput)}</span>
                <input
                  className="settings-select"
                  type="password"
                  value={lastFmProfileSessionKeyInput}
                  placeholder={lastFmProfileModalMode === 'edit' ? translate('settings:auto.settingsview.leave_blank_to_keep_current_value1', { value1: getScrobbleSecretLabel(lastFmProfileProtocolInput).toLowerCase() }) : ''}
                  autoComplete="off"
                  onChange={(event) => setLastFmProfileSessionKeyInput(event.target.value)}
                />
              </label>
            </div>
            <div className="modal-footer">
              <button className="settings-btn" onClick={closeLastFmProfileModal}>

                <LocalizedText ns="settings" i18nKey="auto.settingsview.cancel" />
              </button>
              <button
                className="settings-btn settings-btn-primary"
                onClick={handleSaveLastFmProfile}
                disabled={lastFmProfileSaveDisabled}
              >
                {lastFmProfileModalMode === 'edit' ? translate('settings:auto.settingsview.save_destination') : translate('settings:auto.settingsview.add_destination')}
              </button>
            </div>
          </div>
        </div>
      )}
      <SettingsTransferWizard
        isOpen={settingsTransferWizardOpen}
        onClose={() => setSettingsTransferWizardOpen(false)}
      />
      <LocalApiPairingModal
          isOpen={localApiPairingModalOpen}
          ticket={phoneRemoteActivePairingTicket}
          pairedDevices={phoneRemotePairedDevices}
          pendingRequests={phoneRemotePendingPairingRequests}
          apiEnabled={phoneRemoteEnabled}
          remoteWebEnabled={phoneRemoteEnabled}
          controlsEnabled={localApiControlsEnabled}
          lanUrls={phoneRemoteLanUrls}
          selectedBaseUrl={localApiSelectedPairingBaseUrl}
          selectedControllerUrl={localApiSelectedPairingUrl}
          feedbackMessage={phoneRemoteFeedback}
          errorMessage={phoneRemoteErrorMessage}
          onClose={handleClosePhoneRemotePairingModal}
          onEnableRemoteControl={handleEnablePhoneRemoteControl}
          onSelectBaseUrl={setLocalApiSelectedPairingBaseUrl}
          onGenerateTicket={handleCreatePhoneRemotePairingTicket}
          onGenerateWebTicket={handleCreatePhoneRemoteWebPairingTicket}
          onRefreshTicket={handleRefreshPhoneRemotePairingTicket}
          onCopyPairingUrl={() => {
            if (!phoneRemoteActivePairingTicket) return
            void copyPhoneRemoteToClipboard(phoneRemoteActivePairingTicket.pairingUrl, 'Pairing link')
          }}
          onApproveRequest={handleApprovePhoneRemotePairingRequest}
          onRejectRequest={handleRejectPhoneRemotePairingRequest}
          onRevokeDevice={handleRevokePhoneRemotePairedDevice}
          onRevokeAllDevices={handleRevokeAllPhoneRemoteDevices}
        />
    </div>
  )
}
