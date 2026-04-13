import { useEffect, useMemo, useRef, useState } from 'react'
import FolderSettings from '../settings/FolderSettings'
import AudioOutputSelect from '../settings/AudioOutputSelect'
import ChannelRoutingPanel from '../settings/ChannelRoutingPanel'
import DelayCompensationPanel from '../settings/DelayCompensationPanel'
import ConfirmActionModal from '../settings/ConfirmActionModal'
import BitPerfectModeWarningModal from '../settings/BitPerfectModeWarningModal'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import {
  BIT_PERFECT_DSP_DISABLED_MESSAGE,
  DEFAULT_NORMALIZATION_TARGET_LUFS,
  useAudioSettingsStore,
  type ReplayGainMode
} from '../../stores/audioSettingsStore'
import { useVisualizerSettingsStore } from '../../stores/visualizerSettingsStore'
import { useDiscordSettingsStore } from '../../stores/discordSettingsStore'
import { useLocalApiSettingsStore } from '../../stores/localApiSettingsStore'
import { useLastFmSettingsStore } from '../../stores/lastFmSettingsStore'
import { useLyricsStore } from '../../stores/lyricsStore'
import { useUpdateStore } from '../../stores/updateStore'
import { useDiagnosticsStore } from '../../stores/diagnosticsStore'
import { useGraphStore } from '../../stores/graphStore'
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
} from '../settings/resetActions'
import type { MiniPlayerVisualizerMode } from '../../../types/miniPlayer'
import {
  LOCAL_API_DEFAULT_PORT,
  LOCAL_API_MAX_PORT,
  LOCAL_API_MIN_PORT
} from '../../../types/localApi'

type ResetActionId =
  | 'reset-theme'
  | 'reset-audio'
  | 'reset-integrations'
  | 'reset-discord-cover-art-cache'
  | 'reset-eq'
  | 'reset-all'
  | 'reset-folders'
  | 'factory-reset'

type ResetActionState = 'idle' | 'running' | 'success' | 'error'
type NormalizationDisableStep = 'warning' | 'final' | null
type ReplayGainSelectorValue = ReplayGainMode | 'disabled'
const NORMALIZATION_TARGET_MIN_LUFS = -30
const NORMALIZATION_TARGET_MAX_LUFS = 0

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

export default function SettingsView() {
  const [showFolderSettings, setShowFolderSettings] = useState(false)
  const [pendingResetId, setPendingResetId] = useState<ResetActionId | null>(null)
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id)
  const [developerSectionVisible, setDeveloperSectionVisible] = useState(() => readDeveloperSectionVisibilityPreference())
  const [appVersionLabel, setAppVersionLabel] = useState('Loading...')
  const [resetStatuses, setResetStatuses] = useState<Record<ResetActionId, ResetActionStatus>>(
    () => buildInitialResetStatusMap()
  )
  const { rescan, backfillReplayGainMetadata, isScanning, isCancelingScan, cancelScan, scanProgress, scanStage } = useLibraryStore()
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
  const showTracklistAddedDate = useLibraryStore((state) => state.showTracklistAddedDate)
  const setShowTracklistAddedDate = useLibraryStore((state) => state.setShowTracklistAddedDate)
  const {
    enabled: discordEnabled,
    coverArtEnabled: discordCoverArtEnabled,
    statusMessage: discordStatusMessage,
    setEnabled: setDiscordEnabled,
    setCoverArtEnabled: setDiscordCoverArtEnabled,
  } = useDiscordSettingsStore()
  const {
    status: localApiStatus,
    errorMessage: localApiErrorMessage,
    init: initLocalApi,
    setEnabled: setLocalApiEnabled,
    setControlsEnabled: setLocalApiControlsEnabled,
    setPort: setLocalApiPort,
    rotateToken: rotateLocalApiToken,
  } = useLocalApiSettingsStore()
  const {
    status: lastFmStatus,
    isAuthorizing: lastFmIsAuthorizing,
    errorMessage: lastFmErrorMessage,
    authHint: lastFmAuthHint,
    setEnabled: setLastFmEnabled,
    beginAuth: beginLastFmAuth,
    disconnect: disconnectLastFm,
  } = useLastFmSettingsStore()
  const {
    status: lyricsStatus,
    errorMessage: lyricsErrorMessage,
    setEnabled: setLyricsEnabled,
  } = useLyricsStore()
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
  const [miniPlayerVisualizerMode, setMiniPlayerVisualizerMode] = useState<MiniPlayerVisualizerMode>('spectrum')
  const [localApiPortInput, setLocalApiPortInput] = useState(String(LOCAL_API_DEFAULT_PORT))
  const [localApiFeedback, setLocalApiFeedback] = useState('')
  const [sleepTimerCustomMinutesInput, setSleepTimerCustomMinutesInput] = useState(
    String(SLEEP_TIMER_PRESET_MINUTES[1] ?? SLEEP_TIMER_PRESET_MINUTES[0] ?? 30)
  )
  const [sleepTimerFeedback, setSleepTimerFeedback] = useState('')
  const [sleepTimerFeedbackTone, setSleepTimerFeedbackTone] = useState<'success' | 'error'>('success')
  const [normalizationDisableStep, setNormalizationDisableStep] = useState<NormalizationDisableStep>(null)
  const [normalizationTargetInput, setNormalizationTargetInput] = useState(() => formatNormalizationTargetLufs(normalizationTargetLufs))
  const [normalizationTargetError, setNormalizationTargetError] = useState('')
  const [showBitPerfectWarning, setShowBitPerfectWarning] = useState(false)
  const [dontShowBitPerfectWarningAgain, setDontShowBitPerfectWarningAgain] = useState(false)
  const [bitPerfectWarningDismissed, setBitPerfectWarningDismissed] = useState(() => {
    return localStorage.getItem(BIT_PERFECT_WARNING_DISMISSED_STORAGE_KEY) === '1'
  })
  const developerRevealClickCountRef = useRef(0)
  const developerRevealResetTimeoutRef = useRef<number | null>(null)
  const openKeyboardShortcuts = useUIStore((state) => state.openKeyboardShortcuts)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const pendingSettingsSection = useUIStore((state) => state.pendingSettingsSection)
  const consumePendingSettingsSection = useUIStore((state) => state.consumePendingSettingsSection)
  const libraryGraphEnabled = useGraphStore((state) => state.enabled)
  const setLibraryGraphEnabled = useGraphStore((state) => state.setEnabled)
  const openFullGraph = useGraphStore((state) => state.openFullMap)
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
    return new Date(sleepTimerExpiresAtMs).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    })
  }, [sleepTimerExpiresAtMs])
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
    () => SETTINGS_SECTIONS.filter((section) => developerSectionVisible || !('hidden' in section && section.hidden)),
    [developerSectionVisible]
  )

  useEffect(() => {
    setAccentInputValue(fallbackAccent)
  }, [fallbackAccent])

  useEffect(() => {
    void initLocalApi()
  }, [initLocalApi])

  useEffect(() => {
    void initDiagnostics()
  }, [initDiagnostics])

  useEffect(() => {
    if (!localApiStatus) return
    setLocalApiPortInput(String(localApiStatus.port))
  }, [localApiStatus?.port])

  useEffect(() => {
    if (!localApiFeedback) return
    const timeoutId = window.setTimeout(() => {
      setLocalApiFeedback('')
    }, 2600)
    return () => window.clearTimeout(timeoutId)
  }, [localApiFeedback])

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
      description: 'Disable Discord, Last.fm, Lyrics lookup, and the Local API.',
      buttonLabel: 'Reset Integrations',
      confirmTitle: 'Reset Integration Settings',
      confirmMessage: 'This will disable Discord, Last.fm scrobbling, online lyrics lookup, and the local integration API, then clear related preferences.',
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
  ]), [isScanning])

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
    ? new Date(lastCheckedAt).toLocaleString()
    : 'No update checks have run yet.'
  const localApiEnabled = localApiStatus?.enabled ?? false
  const localApiControlsEnabled = localApiStatus?.controlsEnabled ?? false
  const localApiBaseUrl = localApiStatus?.baseUrl ?? `http://127.0.0.1:${LOCAL_API_DEFAULT_PORT}`
  const localApiToken = localApiStatus?.token ?? ''
  const localApiStatusLabel = !localApiStatus
    ? 'Loading local API status...'
    : localApiStatus.active
      ? `Local integration API active on ${localApiStatus.baseUrl}.`
      : localApiStatus.enabled
        ? `Local integration API enabled but not active${localApiStatus.lastError ? `: ${localApiStatus.lastError}` : '.'}`
        : 'Local integration API is disabled.'
  const lastFmConnected = lastFmStatus?.connected ?? false
  const lastFmEnabled = lastFmStatus?.enabled ?? false
  const lastFmAuthPending = lastFmStatus?.authPending ?? false
  const lastFmHasApiCredentials = lastFmStatus?.hasApiCredentials ?? true
  const lastFmUsername = lastFmStatus?.username
  const lastFmPendingScrobbles = lastFmStatus?.pendingScrobbles ?? 0
  const lastFmStatusLabel = lastFmStatus?.statusMessage ?? 'Loading Last.fm status...'
  const lastFmQueueLabel = `Pending scrobbles: ${lastFmPendingScrobbles}.`
  const lastFmResolvedError = lastFmErrorMessage || (lastFmStatus?.lastError ?? '')
  const lastFmCanConnect = lastFmHasApiCredentials && !lastFmConnected && !lastFmIsAuthorizing
  const lyricsEnabled = lyricsStatus?.enabled ?? false
  const lyricsStatusLabel = lyricsStatus?.statusMessage ?? 'Loading lyrics status...'
  const lyricsResolvedError = lyricsErrorMessage || (lyricsStatus?.lastError ?? '')
  const diagnosticsEnabled = diagnosticsStatus?.enabled ?? false
  const diagnosticsSampleIntervalLabel = `${Math.round((diagnosticsStatus?.sampleIntervalMs ?? 15000) / 1000)} seconds`
  const diagnosticsCurrentLogPath = diagnosticsStatus?.currentLogPath ?? 'Loading diagnostics paths...'
  const diagnosticsPreviousLogPath = diagnosticsStatus?.previousLogPath ?? 'Loading diagnostics paths...'
  const diagnosticsSessionLabel = diagnosticsStatus?.sessionStartedAt
    ? `Current session started ${new Date(diagnosticsStatus.sessionStartedAt).toLocaleString()}.`
    : diagnosticsEnabled
      ? 'Waiting for the current diagnostics session header.'
      : 'Diagnostics are disabled.'
  const diagnosticsLastBundleLabel = diagnosticsLastCaptureResult
    ? `Last bundle captured ${new Date(diagnosticsLastCaptureResult.capturedAt).toLocaleString()}.`
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

    const loadAppVersion = async () => {
      if (!window.electronAPI?.getAppVersion) {
        if (isMounted) setAppVersionLabel('Unavailable')
        return
      }

      try {
        const version = await window.electronAPI.getAppVersion()
        if (!isMounted) return
        setAppVersionLabel(version ? `v${version}` : 'Unavailable')
      } catch {
        if (isMounted) setAppVersionLabel('Unavailable')
      }
    }

    void loadAppVersion()
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
          <p className="settings-danger-item-title">{action.title}</p>
          <p className="settings-danger-item-description">{action.description}</p>
          {status.state !== 'idle' && (
            <p className={`settings-danger-status settings-danger-status-${status.state}`}>
              {status.message}
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
            <p className="settings-kicker">System Controls</p>
            <h2>Settings</h2>
            <p className="settings-subtitle">Manage playback behavior, library scanning, and application preferences.</p>
          </div>
          {isScanning && (
            <div className="settings-scan-badge">
              <span>
                {scanStage?.stage === 'backfill'
                  ? 'Metadata'
                  : scanStage?.stage === 'cleanup'
                    ? 'Finalizing'
                    : 'Scanning'}
                {scanProgress ? ` ${scanProgress.current}/${scanProgress.total}` : '...'}
              </span>
              <button
                className="settings-scan-badge-cancel"
                onClick={() => void cancelScan()}
                disabled={isCancelingScan}
                aria-label="Cancel scan"
                title="Cancel scan"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
          )}
        </div>

        <div className="settings-layout">
          <nav className="settings-sidebar" aria-label="Settings sections">
            {visibleSettingsSections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`settings-sidebar-item ${activeSectionId === section.id ? 'active' : ''}`}
                aria-current={activeSectionId === section.id ? 'true' : undefined}
                onClick={() => setActiveSectionId(section.id)}
              >
                {section.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {activeSectionId === 'appearance' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Appearance</h3>
              <p>Theme and accent preferences.</p>
            </div>
            <div className="settings-theme-grid">
              {THEME_PRESET_LIST.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`settings-theme-card ${presetId === preset.id ? 'active' : ''}`}
                  onClick={() => setPreset(preset.id as ThemePresetId)}
                >
                  <span className="settings-theme-card-title">{preset.label}</span>
                  <span className="settings-theme-card-description">{preset.description}</span>
                </button>
              ))}
            </div>
            <div className="settings-grid">
              <label className="settings-field">
                <span className="settings-field-label">
                  {accentSource === 'cover-art' ? 'Fallback Accent Color' : 'Accent Color'}
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
              <label className="settings-field">
                <span className="settings-field-label">Accent Source</span>
                <select
                  className="settings-select"
                  value={accentSource}
                  onChange={(event) => {
                    const source: AccentSource = event.target.value === 'cover-art' ? 'cover-art' : 'theme'
                    setAccentSource(source)
                  }}
                >
                  <option value="theme">Theme Accent</option>
                  <option value="cover-art">Cover Art (Now Playing)</option>
                </select>
              </label>
              {accentSource === 'cover-art' && (
                <label className="settings-field">
                  <span className="settings-field-label">Cover Art Method</span>
                  <select
                    className="settings-select"
                    value={coverArtAccentMethod}
                    onChange={(event) => {
                      const method: CoverArtAccentMethod = event.target.value === 'average'
                        ? 'average'
                        : event.target.value === 'vibrant'
                          ? 'vibrant'
                          : 'dominant'
                      setCoverArtAccentMethod(method)
                    }}
                  >
                    <option value="dominant">Dominant</option>
                    <option value="vibrant">Vibrant</option>
                    <option value="average">Average</option>
                  </select>
                </label>
              )}
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">
                  {accentSource === 'cover-art' ? 'Fallback Accent' : 'Preset Accent'}
                </span>
                {customAccent ? (
                  <button className="settings-btn" onClick={usePresetAccent}>
                    Use Preset Accent
                  </button>
                ) : (
                  <span className="settings-chip">Using Preset Accent</span>
                )}
              </div>
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Theme</span>
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={() => {
                    resetThemeToDefault()
                    setAccentInputValue(defaultPresetAccent)
                  }}
                >
                  Reset Theme to Default
                </button>
              </div>
            </div>
            <p className="settings-note">The current Astra look is preserved as the default preset.</p>
            {accentSource === 'cover-art' && (
              <p className="settings-note">
                Cover art accents use the selected method on the current track artwork. Vibrant favors richer, less-muted colors. If artwork is missing or no usable color is found, Astra uses the fallback accent color.
              </p>
            )}
          </section>
            )}

            {activeSectionId === 'library' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Library</h3>
              <p>Manage folders and refresh indexed metadata.</p>
            </div>
            <div className="settings-actions settings-actions-grid settings-actions-grid-spaced">
              <button className="settings-btn settings-btn-primary" onClick={() => setShowFolderSettings(true)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                </svg>
                Manage Folders
              </button>
              <button className="settings-btn" onClick={rescan} disabled={isScanning}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>
                Rescan Library
              </button>
            </div>
            <div className="settings-grid">
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Normalization</span>
                <button
                  className={`settings-toggle ${normalizationEnabled ? 'active' : ''}`}
                  onClick={handleNormalizationToggle}
                  disabled={bitPerfectModeActive}
                  title={bitPerfectModeActive ? BIT_PERFECT_DSP_DISABLED_MESSAGE : undefined}
                >
                  {normalizationEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
              <label className="settings-field">
                <span className="settings-field-label">Normalization Target</span>
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
                    RESET
                  </button>
                </div>
              </label>
              <label className="settings-field">
                <span className="settings-field-label">ReplayGain</span>
                <select
                  className="settings-select"
                  value={replayGainSelectorValue}
                  disabled={bitPerfectModeActive}
                  onChange={(event) => void handleReplayGainSelectorChange(event.target.value as ReplayGainSelectorValue)}
                >
                  <option value="disabled">Disabled</option>
                  <option value="auto">Auto</option>
                  <option value="track">Track</option>
                  <option value="album">Album</option>
                </select>
              </label>
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Tracklist BPM/Key Columns</span>
                <button
                  className={`settings-toggle ${showTracklistBpmKey ? 'active' : ''}`}
                  onClick={() => setShowTracklistBpmKey(!showTracklistBpmKey)}
                >
                  {showTracklistBpmKey ? 'Enabled' : 'Disabled'}
                </button>
              </div>
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Tracklist Added Column</span>
                <button
                  className={`settings-toggle ${showTracklistAddedDate ? 'active' : ''}`}
                  onClick={() => setShowTracklistAddedDate(!showTracklistAddedDate)}
                >
                  {showTracklistAddedDate ? 'Enabled' : 'Disabled'}
                </button>
              </div>
            </div>
            <p className="settings-note">Manage Folders includes folder-level permission warnings.</p>
            <p className="settings-note">
              Normalization Target applies to built-in normalization. ReplayGain values override it on tagged tracks when ReplayGain is active.
            </p>
            {bitPerfectModeActive && (
              <p className="settings-note">
                {BIT_PERFECT_DSP_DISABLED_MESSAGE}
              </p>
            )}
            <p className="settings-note">
              Experimental.
            </p>
            {normalizationTargetError && (
              <p className="settings-note settings-note-error">{normalizationTargetError}</p>
            )}
            {!normalizationEnabled && (
              <p className="settings-note settings-note-error">
                Normalization is disabled. ReplayGain can stay configured, but playback gain is bypassed until normalization is re-enabled.
              </p>
            )}
            <RemoteServersPanel />
          </section>
            )}

            {activeSectionId === 'analyzer' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Analyzer</h3>
              <p>Profiles, docked scope layout, and visualizer behavior.</p>
            </div>
            <div className="settings-grid">
              <label className="settings-field">
                <span className="settings-field-label">Mini Player Visualizer</span>
                <select
                  className="settings-select"
                  value={miniPlayerVisualizerMode}
                  onChange={(event) => handleMiniPlayerVisualizerModeChange(event.target.value as MiniPlayerVisualizerMode)}
                >
                  <option value="off">Off</option>
                  <option value="oscilloscope">Oscilloscope</option>
                  <option value="spectrum">Spectrum</option>
                </select>
              </label>

              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Visualizer</span>
                <button
                  className={`settings-toggle ${isRunning ? 'active' : ''}`}
                  onClick={() => setIsRunning(!isRunning)}
                >
                  {isRunning ? 'Running' : 'Paused'}
                </button>
              </div>
            </div>
            <p className="settings-note">Visualizer line color follows the active theme accent.</p>
            <p className="settings-note">For smoother mini-player visuals, use FFT 1024/2048 in the active analyzer profile, disable oscilloscope underfill there, and avoid hero mode on lower-end GPUs.</p>
          </section>
            )}

            {activeSectionId === 'audio' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Audio Output</h3>
              <p>Output device, delay compensation, and channel routing.</p>
            </div>
            <div className="settings-grid">
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Playback Path</span>
                <div className="settings-inline-row">
                  <button
                    className={`settings-toggle ${playbackOutputMode === 'standard' ? 'active' : ''}`}
                    onClick={() => handlePlaybackPathChange('standard')}
                  >
                    Standard
                  </button>
                  <div className="settings-inline-row">
                    <button
                      className={`settings-toggle ${playbackOutputMode === 'bitperfect' ? 'active' : ''}`}
                      onClick={() => handlePlaybackPathChange('bitperfect')}
                    >
                      Bit-Perfect (Exclusive)
                    </button>
                    <span className="settings-chip settings-chip-mono settings-chip-danger">
                      Experimental
                    </span>
                  </div>
                </div>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">Native Status</span>
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
                    {nativeAudioCapabilities.activeDeviceExclusive ? 'Exclusive' : 'Shared/Off'}
                  </span>
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
              <h3>Playback</h3>
              <p>Session-level playback behavior and sleep timer controls.</p>
            </div>
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
                    {minutes} min
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
                  {sleepTimerIsActive ? 'Replace Timer' : 'Start Timer'}
                </button>
                {sleepTimerIsActive && (
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={handleSleepTimerCancel}
                  >
                    Cancel
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
                Load a track and keep playback in playing or paused state to start a sleep timer.
              </p>
            )}
            <p className="settings-note">
              Sleep timer counts down in real time, pauses playback when it expires, and does not persist after restart.
            </p>
          </section>
            )}

            {activeSectionId === 'integrations' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Integrations</h3>
              <p>Optional platform integrations outside library sources.</p>
            </div>
            <div className="settings-integration-cards">
              <div className="settings-integration-card">
                <div className="settings-integration-card-head">
                  <h4>Last.fm</h4>
                  <p>Now Playing updates and scrobbling for your Last.fm profile.</p>
                </div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label">Last.fm Scrobbling</span>
                    <button
                      className={`settings-toggle ${lastFmEnabled ? 'active' : ''}`}
                      onClick={() => void setLastFmEnabled(!lastFmEnabled)}
                      disabled={!lastFmConnected || !lastFmHasApiCredentials}
                    >
                      {lastFmEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>

                  <div className="settings-field">
                    <span className="settings-field-label">Last.fm Account</span>
                    <div className="settings-inline-row">
                      <span className="settings-chip settings-chip-mono settings-chip-grow">
                        {lastFmConnected
                          ? `Connected as ${lastFmUsername ?? 'Unknown User'}`
                          : 'Not connected'}
                      </span>
                      <button
                        className="settings-btn settings-btn-primary"
                        onClick={() => void beginLastFmAuth()}
                        disabled={!lastFmCanConnect}
                      >
                        {lastFmIsAuthorizing ? 'Waiting...' : lastFmAuthPending ? 'Check Again' : 'Connect'}
                      </button>
                      <button
                        className="settings-btn"
                        onClick={() => void disconnectLastFm()}
                        disabled={!lastFmConnected && !lastFmAuthPending}
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                </div>
                <p className="settings-note">{lastFmStatusLabel}</p>
                <p className="settings-note">{lastFmQueueLabel}</p>
                {lastFmAuthHint && <p className="settings-note settings-note-success">{lastFmAuthHint}</p>}
                {lastFmResolvedError && <p className="settings-note settings-note-error">{lastFmResolvedError}</p>}
                <p className="settings-note">
                  Last.fm is optional, disabled by default, and only submits listening data when connected and enabled.
                </p>
                {!lastFmHasApiCredentials && (
                  <p className="settings-note settings-note-error">
                    Last.fm API credentials are missing in this build.
                  </p>
                )}
              </div>

              <div className="settings-integration-card">
                <div className="settings-integration-card-head">
                  <h4>Lyrics</h4>
                  <p>Embedded lyrics with optional LRCLIB fallback.</p>
                </div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label">Online Lyrics Lookup</span>
                    <button
                      className={`settings-toggle ${lyricsEnabled ? 'active' : ''}`}
                      onClick={() => void setLyricsEnabled(!lyricsEnabled)}
                    >
                      {lyricsEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                </div>
                <p className="settings-note">{lyricsStatusLabel}</p>
                {lyricsResolvedError && <p className="settings-note settings-note-error">{lyricsResolvedError}</p>}
                <p className="settings-note">
                  Online lookup is off by default. Astra only queries LRCLIB when the Lyrics tab is opened and embedded lyrics are missing.
                </p>
              </div>

              <div className="settings-integration-card">
                <div className="settings-integration-card-head">
                  <h4>Discord</h4>
                  <p>Discord Rich Presence integration.</p>
                </div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label">Discord Rich Presence</span>
                    <button
                      className={`settings-toggle ${discordEnabled ? 'active' : ''}`}
                      onClick={() => void setDiscordEnabled(!discordEnabled)}
                    >
                      {discordEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label">Discord Cover Art (Internet Lookup)</span>
                    <button
                      className={`settings-toggle ${discordCoverArtEnabled ? 'active' : ''}`}
                      onClick={() => void setDiscordCoverArtEnabled(!discordCoverArtEnabled)}
                      disabled={!discordEnabled}
                    >
                      {discordCoverArtEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                </div>
                <p className="settings-note">{discordStatusMessage}</p>
                <p className="settings-note">
                  Enabling Discord Cover Art performs internet lookups to MusicBrainz and Cover Art Archive.
                </p>
              </div>

              <div className="settings-integration-card">
                <div className="settings-integration-card-head">
                  <h4>Local API</h4>
                  <p>Local-only API for external integrations like editors and tools.</p>
                </div>
                <div className="settings-grid">
                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label">Local Integration API</span>
                    <button
                      className={`settings-toggle ${localApiEnabled ? 'active' : ''}`}
                      onClick={() => void setLocalApiEnabled(!localApiEnabled)}
                    >
                      {localApiEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>

                  <div className="settings-field settings-field-inline">
                    <span className="settings-field-label">External Playback Controls</span>
                    <button
                      className={`settings-toggle ${localApiControlsEnabled ? 'active' : ''}`}
                      onClick={() => void setLocalApiControlsEnabled(!localApiControlsEnabled)}
                      disabled={!localApiEnabled}
                    >
                      {localApiControlsEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>

                  <div className="settings-field">
                    <span className="settings-field-label">Local API Port</span>
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
                        Save
                      </button>
                    </div>
                  </div>

                  <div className="settings-field">
                    <span className="settings-field-label">Local API Endpoint</span>
                    <div className="settings-inline-row">
                      <span className="settings-chip settings-chip-mono settings-chip-grow">
                        {localApiBaseUrl}
                      </span>
                      <button
                        className="settings-btn"
                        onClick={() => void copyToClipboard(`${localApiBaseUrl}/v1/now-playing`, 'Endpoint')}
                      >
                        Copy
                      </button>
                    </div>
                  </div>

                  <div className="settings-field">
                    <span className="settings-field-label">Local API Key</span>
                    <div className="settings-inline-row">
                      <span className="settings-chip settings-chip-mono settings-chip-grow">
                        {localApiToken || 'Unavailable'}
                      </span>
                      <button
                        className="settings-btn"
                        onClick={() => void copyToClipboard(localApiToken, 'API key')}
                        disabled={!localApiToken}
                      >
                        Copy
                      </button>
                      <button className="settings-btn settings-btn-primary" onClick={handleRotateLocalApiToken}>
                        Regenerate
                      </button>
                    </div>
                  </div>
                </div>
                <p className="settings-note">{localApiStatusLabel}</p>
                {localApiFeedback && <p className="settings-note settings-note-success">{localApiFeedback}</p>}
                {localApiErrorMessage && <p className="settings-note settings-note-error">{localApiErrorMessage}</p>}
                <p className="settings-note">
                  The local API is loopback-only, off by default, and read-only unless controls are explicitly enabled.
                </p>
              </div>
            </div>
          </section>
            )}

            {activeSectionId === 'experimental' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Experimental</h3>
              <p>Preview features that may change, move, or disappear. They are not guaranteed to be stable.</p>
            </div>
            <div className="settings-grid">
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Library Graph</span>
                <button
                  className={`settings-toggle ${libraryGraphEnabled ? 'active' : ''}`}
                  onClick={() => setLibraryGraphEnabled(!libraryGraphEnabled)}
                >
                  {libraryGraphEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Open Graph</span>
                <button
                  className="settings-btn"
                  disabled={!libraryGraphEnabled}
                  onClick={() => {
                    openFullGraph()
                    setActiveView('graph')
                  }}
                >
                  Open Full Map
                </button>
              </div>
            </div>
            <p className="settings-note">
              Enable Library Graph adds a dedicated graph view and an artist-page graph entrypoint.
            </p>
            <p className="settings-note">
              The current version derives artist relationships from your existing library metadata only.
            </p>
          </section>
            )}

            {activeSectionId === 'info' && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Info</h3>
              <p>Version, updates, attribution, and license details.</p>
            </div>
            <div className="settings-grid settings-info-grid">
              <div className="settings-field">
                <span className="settings-field-label">App Version</span>
                <button
                  type="button"
                  className="settings-version-reveal-btn settings-info-value"
                  onClick={handleAppVersionClick}
                  aria-label={developerSectionVisible ? 'Open developer settings' : 'App version'}
                >
                  {appVersionLabel}
                </button>
              </div>

              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Auto-check on Startup</span>
                <button
                  className={`settings-toggle ${autoCheckEnabled ? 'active' : ''}`}
                  onClick={() => setAutoCheckEnabled(!autoCheckEnabled)}
                >
                  {autoCheckEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>

              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Check for Updates</span>
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={() => void checkForUpdates()}
                  disabled={updateCheckState === 'checking'}
                >
                  {updateCheckState === 'checking' ? 'Checking...' : 'Check Now'}
                </button>
              </div>

              <div className="settings-field settings-field-inline">
                <span className="settings-field-label">Download</span>
                <button
                  className="settings-btn"
                  onClick={() => void openReleasesPage()}
                >
                  Open Releases
                </button>
              </div>

            </div>
            <p className={`settings-note settings-update-status settings-update-status-${updateStatusTone}`}>
              {updateStatusMessage}
            </p>
            {updateAvailable && latestTag && (
              <p className="settings-note settings-update-meta">
                Latest release: {latestTag}{releaseName ? ` (${releaseName})` : ''}
              </p>
            )}
            <p className="settings-note settings-update-meta">
              {lastCheckedAt ? `Last checked: ${lastCheckedLabel}` : lastCheckedLabel}
            </p>
            <div className="settings-actions settings-info-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={openKeyboardShortcuts}
              >
                Keyboard Shortcuts
              </button>
            </div>
            <div className="settings-info-panels">
              <div className="settings-info-panel">
                <h4>Attribution</h4>
                <p>Astra is created and maintained by Boof2015.</p>
                <p className="settings-info-meta">Contact: contact@novaml.ai</p>
                <div className="settings-info-links">
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(ASTRA_REPOSITORY_URL)}
                  >
                    GitHub Repository
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(ASTRA_DISCORD_URL)}
                  >
                    Discord
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-link-btn settings-link-btn-kofi"
                    onClick={() => openExternalLink(ASTRA_SUPPORT_URL)}
                  >
                    Ko-fi
                    <span className="settings-link-btn-heart" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="settings-info-panel">
                <h4>License</h4>
                <p>Astra is distributed under GPL-3.0-only.</p>
                <div className="settings-info-links">
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(ASTRA_LICENSE_URL)}
                  >
                    View LICENSE
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => openExternalLink(GPL_V3_URL)}
                  >
                    GPL v3 Text
                  </button>
                </div>
              </div>
            </div>
          </section>
            )}

            {activeSectionId === 'developer' && developerSectionVisible && (
            <section className="settings-section settings-section-panel">
            <div className="settings-section-head">
              <h3>Developer</h3>
              <p>Hidden diagnostics and playback-debug controls.</p>
            </div>
            <div className="settings-actions settings-info-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={handleHideDeveloperSection}
              >
                Hide Developer Section
              </button>
            </div>
            <div className="settings-info-panels">
              <div className="settings-info-panel">
                <h4>Memory Diagnostics</h4>
                <p>
                  Writes a CSV memory log every {diagnosticsSampleIntervalLabel} plus playback breadcrumbs
                  so you can correlate growth with track changes, buffering, gapless handoffs, and remote streams.
                </p>
                <div className="settings-field settings-field-inline">
                  <span className="settings-field-label">Diagnostics Logging</span>
                  <button
                    type="button"
                    className={`settings-toggle ${diagnosticsEnabled ? 'active' : ''}`}
                    onClick={() => void setDiagnosticsEnabled(!diagnosticsEnabled)}
                    disabled={diagnosticsIsLoading && diagnosticsStatus === null}
                  >
                    {diagnosticsEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
                <p className="settings-info-meta">Current log</p>
                <p className="settings-info-path">{diagnosticsCurrentLogPath}</p>
                <p className="settings-info-meta">Previous log</p>
                <p className="settings-info-path">{diagnosticsPreviousLogPath}</p>
                <p className="settings-info-meta">{diagnosticsSessionLabel}</p>
                <div className="settings-info-links">
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => void captureDiagnosticsBundle()}
                    disabled={diagnosticsIsCapturingBundle}
                  >
                    {diagnosticsIsCapturingBundle ? 'Capturing Bundle...' : 'Capture Memory Bundle'}
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
                    Reveal Current Log
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-link-btn"
                    onClick={() => void revealPreviousLog()}
                    disabled={!diagnosticsStatus?.hasPreviousLog}
                  >
                    Reveal Previous Log
                  </button>
                </div>
              </div>
              <div className="settings-info-panel">
                <h4>Playback Overrides</h4>
                {import.meta.env.DEV ? (
                  <>
                    <p>Temporary switches for isolating standard-mode playback behavior during local debugging.</p>
                    <div className="settings-grid">
                      <div className="settings-field settings-field-inline">
                        <span className="settings-field-label">Disable Gapless Prebuffer</span>
                        <button
                          className={`settings-toggle ${disableGaplessPrebufferDev ? 'active' : ''}`}
                          onClick={() => setDisableGaplessPrebufferDev(!disableGaplessPrebufferDev)}
                        >
                          {disableGaplessPrebufferDev ? 'Disabled' : 'Enabled'}
                        </button>
                      </div>
                      <div className="settings-field settings-field-inline">
                        <span className="settings-field-label">Disable Analysis/EQ Taps</span>
                        <button
                          className={`settings-toggle ${disableStandardAnalysisGraphDev ? 'active' : ''}`}
                          onClick={() => setDisableStandardAnalysisGraphDev(!disableStandardAnalysisGraphDev)}
                        >
                          {disableStandardAnalysisGraphDev ? 'Disabled' : 'Enabled'}
                        </button>
                      </div>
                    </div>
                    <p className="settings-note">
                      When gapless prebuffer is disabled, Astra stops preloading the next track and clears scheduled handoffs so you can compare memory growth without gapless-style buffering.
                    </p>
                    <p className="settings-note">
                      When analysis and EQ taps are disabled, Astra bypasses the standard post-EQ analyser and analysis-worklet branches while keeping normal playback and EQ filters active.
                    </p>
                  </>
                ) : (
                  <>
                    <p>Playback override switches are only available in development builds.</p>
                    <p className="settings-note">
                      Production builds keep these toggles off and ignore their stored values.
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
              <h3>Danger Zone</h3>
              <p>Use these actions when troubleshooting or intentionally resetting data.</p>
            </div>
            <div className="settings-danger-groups">
              <div className="settings-danger-group">
                <p className="settings-danger-group-title">Safe Resets</p>
                <p className="settings-danger-group-description">
                  Reset app preferences while keeping primary library data.
                </p>
                <div className="settings-danger-list">
                  {safeResetActions.map((action) => renderResetAction(action))}
                </div>
              </div>
              <div className="settings-danger-group settings-danger-group-destructive">
                <p className="settings-danger-group-title">Destructive Resets</p>
                <p className="settings-danger-group-description">
                  Remove indexed media data or perform a full wipe.
                </p>
                <div className="settings-danger-list">
                  {destructiveResetActions.map((action) => renderResetAction(action))}
                </div>
              </div>
            </div>
            {isScanning && (
              <p className="settings-note settings-danger-note">
                Destructive resets are disabled while library scanning is in progress.
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
        title={normalizationDisableStep === 'warning' ? 'Disable Normalization?' : 'Final Safety Check'}
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
    </div>
  )
}
