import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSubsonicSettingsStore } from '../../stores/subsonicSettingsStore'
import { useJellyfinSettingsStore } from '../../stores/jellyfinSettingsStore'
import type {
  JellyfinSourceCreateInput,
  JellyfinSourceTestResult,
  JellyfinSourceUpdateInput,
  SubsonicSourceCreateInput,
  SubsonicSourceTestResult,
  SubsonicSourceUpdateInput
} from '../../../types/subsonic'

type RemoteSourceType = 'subsonic' | 'jellyfin'
type WizardMode = null | 'add' | 'edit'
type WizardStep = 0 | 1
type TestStatus = 'idle' | 'testing' | 'success' | 'failed'

interface RemoteEditingSourceRef {
  sourceType: RemoteSourceType
  sourceId: number
}

interface RemoteSourceListItem {
  sourceType: RemoteSourceType
  id: number
  name: string
  base_url: string
  username: string
  enabled: number
  last_status: string
  last_error: string | null
  last_sync_at: number | null
  last_checked_at: number | null
  created_at: number
  updated_at: number
  has_stored_secret: boolean
}

interface RemoteSourceStatusItem {
  status: string
  error: string | null
  lastSyncAt: number | null
  lastCheckedAt: number | null
  progress: {
    activity: string
    current: number | null
    total: number | null
    detail: string | null
  } | null
}

const REMOTE_PROVIDER_LABEL: Record<RemoteSourceType, string> = {
  subsonic: 'Subsonic / Navidrome',
  jellyfin: 'Jellyfin'
}

const STEP_LABELS = ['Connection', 'Details'] as const

function formatTimeAgo(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDays = Math.floor(diffHr / 24)
  return `${diffDays}d ago`
}

function createRemoteSyncSessionKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (typeof randomUuid === 'string' && randomUuid.length > 0) {
    return randomUuid
  }
  return `sync-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getStatusDotClass(source: RemoteSourceListItem, statusItem: RemoteSourceStatusItem | undefined): string {
  if (source.enabled !== 1) return 'remote-status-dot remote-status-dot-disabled'
  const status = statusItem?.status ?? source.last_status
  if (status === 'syncing') return 'remote-status-dot remote-status-dot-syncing'
  if (status === 'error') return 'remote-status-dot remote-status-dot-error'
  if (status === 'ok') return 'remote-status-dot remote-status-dot-ok'
  return 'remote-status-dot'
}

export default function RemoteServersPanel() {
  const {
    sources: subsonicSources,
    status: subsonicStatus,
    errorMessage: subsonicErrorMessage,
    createSource: createSubsonicSource,
    updateSource: updateSubsonicSource,
    deleteSource: deleteSubsonicSource,
    testSource: testSubsonicSource,
    syncSource: syncSubsonicSource,
    syncAll: syncAllSubsonicSources
  } = useSubsonicSettingsStore()

  const {
    sources: jellyfinSources,
    status: jellyfinStatus,
    errorMessage: jellyfinErrorMessage,
    createSource: createJellyfinSource,
    updateSource: updateJellyfinSource,
    deleteSource: deleteJellyfinSource,
    testSource: testJellyfinSource,
    syncSource: syncJellyfinSource,
    syncAll: syncAllJellyfinSources
  } = useJellyfinSettingsStore()

  // Derived data
  const remoteSources = useMemo<RemoteSourceListItem[]>(() => {
    const items: RemoteSourceListItem[] = [
      ...subsonicSources.map((s) => ({ ...s, sourceType: 'subsonic' as const })),
      ...jellyfinSources.map((s) => ({ ...s, sourceType: 'jellyfin' as const }))
    ]
    return items.sort((a, b) => b.updated_at - a.updated_at)
  }, [subsonicSources, jellyfinSources])

  const remoteStatusBySourceKey = useMemo(() => {
    const map = new Map<string, RemoteSourceStatusItem>()
    for (const ss of subsonicStatus?.sources ?? []) {
      map.set(`subsonic:${ss.sourceId}`, {
        status: ss.status,
        error: ss.error,
        lastSyncAt: ss.lastSyncAt,
        lastCheckedAt: ss.lastCheckedAt,
        progress: ss.progress
          ? { activity: ss.progress.activity, current: ss.progress.current, total: ss.progress.total, detail: ss.progress.detail }
          : null
      })
    }
    for (const js of jellyfinStatus?.sources ?? []) {
      map.set(`jellyfin:${js.sourceId}`, {
        status: js.status,
        error: js.error,
        lastSyncAt: js.lastSyncAt,
        lastCheckedAt: js.lastCheckedAt,
        progress: js.progress
          ? { activity: js.progress.activity, current: js.progress.current, total: js.progress.total, detail: js.progress.detail }
          : null
      })
    }
    return map
  }, [subsonicStatus, jellyfinStatus])

  const isAnyRemoteSyncing = (subsonicStatus?.isSyncing ?? false) || (jellyfinStatus?.isSyncing ?? false)

  const remoteErrorMessages = useMemo(() => {
    const messages: string[] = []
    if (subsonicErrorMessage) messages.push(`Subsonic: ${subsonicErrorMessage}`)
    if (jellyfinErrorMessage) messages.push(`Jellyfin: ${jellyfinErrorMessage}`)
    return messages
  }, [subsonicErrorMessage, jellyfinErrorMessage])

  // View state
  const [wizardMode, setWizardMode] = useState<WizardMode>(null)
  const [wizardStep, setWizardStep] = useState<WizardStep>(0)

  // Form fields
  const [nameInput, setNameInput] = useState('')
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [usernameInput, setUsernameInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [enabledInput, setEnabledInput] = useState(true)
  const [editingSource, setEditingSource] = useState<RemoteEditingSourceRef | null>(null)

  // Test gate
  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [resolvedServerType, setResolvedServerType] = useState<RemoteSourceType | null>(null)
  // Fallback: only shown if auto-detect fails both APIs
  const [showTypeFallback, setShowTypeFallback] = useState(false)
  const [fallbackType, setFallbackType] = useState<RemoteSourceType>('subsonic')

  // List state
  const [feedback, setFeedback] = useState('')
  const [deleteConfirmKey, setDeleteConfirmKey] = useState<string | null>(null)
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)

  // Track field changes to reset test status
  const prevFieldsRef = useRef({ baseUrlInput, usernameInput, passwordInput })
  useEffect(() => {
    const prev = prevFieldsRef.current
    if (
      prev.baseUrlInput !== baseUrlInput ||
      prev.usernameInput !== usernameInput ||
      prev.passwordInput !== passwordInput
    ) {
      if (testStatus !== 'idle') {
        setTestStatus('idle')
        setTestMessage('')
        setResolvedServerType(null)
        setShowTypeFallback(false)
      }
    }
    prevFieldsRef.current = { baseUrlInput, usernameInput, passwordInput }
  })

  // Auto-clear feedback
  useEffect(() => {
    if (!feedback) return
    const id = window.setTimeout(() => setFeedback(''), 3200)
    return () => window.clearTimeout(id)
  }, [feedback])

  // Click-outside for overflow menu
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!openMenuKey) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuKey(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenuKey])

  // Helpers
  const runRemoteSourceTest = useCallback(async (
    sourceType: RemoteSourceType,
    input: { sourceId?: number; baseUrl?: string; username?: string; password?: string }
  ): Promise<SubsonicSourceTestResult | JellyfinSourceTestResult> => {
    if (sourceType === 'subsonic') return testSubsonicSource(input)
    return testJellyfinSource(input)
  }, [testSubsonicSource, testJellyfinSource])

  const detectServerTypeOrder = (baseUrl: string): RemoteSourceType[] => {
    const normalized = baseUrl.toLowerCase()
    if (normalized.includes('8096') || normalized.includes('/jellyfin')) return ['jellyfin', 'subsonic']
    return ['subsonic', 'jellyfin']
  }

  const resolveAutoServerType = useCallback(async (
    baseUrl: string,
    username: string,
    password: string
  ): Promise<{ sourceType: RemoteSourceType | null; message: string }> => {
    const attempts: Array<{ sourceType: RemoteSourceType; message: string }> = []
    for (const sourceType of detectServerTypeOrder(baseUrl)) {
      const result = await runRemoteSourceTest(sourceType, { baseUrl, username, password })
      if (result.ok) {
        return { sourceType, message: `Detected ${REMOTE_PROVIDER_LABEL[sourceType]}.` }
      }
      attempts.push({ sourceType, message: result.error ?? result.message })
    }
    const failureReason = attempts
      .map((a) => `${REMOTE_PROVIDER_LABEL[a.sourceType]}: ${a.message}`)
      .join(' | ')
    return { sourceType: null, message: `Could not detect server type. ${failureReason}` }
  }, [runRemoteSourceTest])

  // Sync a source by type and id
  const syncSourceByType = useCallback((sourceType: RemoteSourceType, sourceId: number) => {
    if (sourceType === 'subsonic') {
      void syncSubsonicSource(sourceId)
    } else {
      void syncJellyfinSource(sourceId)
    }
  }, [syncSubsonicSource, syncJellyfinSource])

  // Reset wizard
  const resetWizard = () => {
    setWizardMode(null)
    setWizardStep(0)
    setNameInput('')
    setBaseUrlInput('')
    setUsernameInput('')
    setPasswordInput('')
    setEnabledInput(true)
    setEditingSource(null)
    setTestStatus('idle')
    setTestMessage('')
    setResolvedServerType(null)
    setShowTypeFallback(false)
  }

  // Open wizard for adding
  const openAddWizard = () => {
    resetWizard()
    setWizardMode('add')
  }

  // Open wizard for editing
  const openEditWizard = (source: RemoteSourceListItem) => {
    setWizardMode('edit')
    setWizardStep(0)
    setEditingSource({ sourceType: source.sourceType, sourceId: source.id })
    setNameInput(source.name)
    setBaseUrlInput(source.base_url)
    setUsernameInput(source.username)
    setPasswordInput('')
    setEnabledInput(source.enabled === 1)
    setTestStatus('idle')
    setTestMessage('')
    setResolvedServerType(source.sourceType)
    setShowTypeFallback(false)
    setOpenMenuKey(null)
  }

  // Test connection (wizard step 0)
  const handleTestConnection = async () => {
    setTestStatus('testing')
    setTestMessage('')

    const url = baseUrlInput.trim()
    const user = usernameInput.trim()
    const pass = passwordInput

    // Edit mode with no new password: test with stored credentials
    if (editingSource && !pass) {
      const result = await runRemoteSourceTest(editingSource.sourceType, {
        sourceId: editingSource.sourceId
      })
      setTestStatus(result.ok ? 'success' : 'failed')
      setTestMessage(result.ok ? result.message : (result.error ?? result.message))
      return
    }

    if (!url || !user || !pass) {
      setTestStatus('failed')
      setTestMessage('URL, username, and password are required.')
      return
    }

    // For new sources: always auto-detect
    if (!editingSource) {
      const detected = await resolveAutoServerType(url, user, pass)
      if (detected.sourceType) {
        setResolvedServerType(detected.sourceType)
        setTestStatus('success')
        setTestMessage(detected.message)
        setShowTypeFallback(false)
      } else {
        setTestStatus('failed')
        setTestMessage(detected.message)
        // Show type fallback so user can manually pick
        setShowTypeFallback(true)
      }
      return
    }

    // Edit mode with new password: test the known type
    const result = await runRemoteSourceTest(editingSource.sourceType, { baseUrl: url, username: user, password: pass })
    setTestStatus(result.ok ? 'success' : 'failed')
    setTestMessage(result.ok ? result.message : (result.error ?? result.message))
  }

  // Retry test with manually selected type (fallback)
  const handleTestWithFallbackType = async () => {
    setTestStatus('testing')
    setTestMessage('')

    const url = baseUrlInput.trim()
    const user = usernameInput.trim()
    const pass = passwordInput

    const result = await runRemoteSourceTest(fallbackType, { baseUrl: url, username: user, password: pass })
    if (result.ok) {
      setResolvedServerType(fallbackType)
      setTestStatus('success')
      setTestMessage(`${REMOTE_PROVIDER_LABEL[fallbackType]}: ${result.message}`)
      setShowTypeFallback(false)
    } else {
      setTestStatus('failed')
      setTestMessage(`${REMOTE_PROVIDER_LABEL[fallbackType]}: ${result.error ?? result.message}`)
    }
  }

  // Handle the combined test/next button
  const handleConnectionStepAction = () => {
    if (testStatus === 'success') {
      // Test passed — advance to details step
      setWizardStep(1)
      return
    }
    // Otherwise run the test
    void handleTestConnection()
  }

  // Save source (wizard step 1), then sync
  const handleSaveSource = async () => {
    const name = nameInput.trim()
    const baseUrl = baseUrlInput.trim()
    const username = usernameInput.trim()
    const password = passwordInput

    if (!name || !baseUrl || !username) {
      setFeedback('Name, server URL, and username are required.')
      return
    }

    if (editingSource === null) {
      // Creating new source
      if (!password) {
        setFeedback('Password is required for new sources.')
        return
      }

      const finalType = resolvedServerType
      if (!finalType) {
        setFeedback('Server type could not be determined.')
        return
      }

      const payload: SubsonicSourceCreateInput | JellyfinSourceCreateInput = {
        name,
        baseUrl,
        username,
        password,
        enabled: enabledInput
      }
      const created = finalType === 'subsonic'
        ? await createSubsonicSource(payload)
        : await createJellyfinSource(payload)

      if (!created) return

      resetWizard()
      setFeedback(`Added ${REMOTE_PROVIDER_LABEL[finalType]} source "${created.name}". Syncing...`)
      // Auto-sync the new source
      syncSourceByType(finalType, created.id)
      return
    }

    // Updating existing source
    const sourceType = editingSource.sourceType
    const sourceId = editingSource.sourceId
    const updatePayload: SubsonicSourceUpdateInput | JellyfinSourceUpdateInput = {
      name,
      baseUrl,
      username,
      enabled: enabledInput
    }
    if (password) {
      updatePayload.password = password
    }

    const updated = sourceType === 'subsonic'
      ? await updateSubsonicSource(sourceId, updatePayload)
      : await updateJellyfinSource(sourceId, updatePayload)

    if (!updated) return

    resetWizard()
    setFeedback(`Updated ${REMOTE_PROVIDER_LABEL[sourceType]} source "${updated.name}". Syncing...`)
    // Auto-sync after update
    syncSourceByType(sourceType, sourceId)
  }

  // Toggle enabled — sync when re-enabling
  const handleToggleEnabled = (source: RemoteSourceListItem) => {
    const nextEnabled = source.enabled !== 1
    const promise = source.sourceType === 'subsonic'
      ? updateSubsonicSource(source.id, { enabled: nextEnabled })
      : updateJellyfinSource(source.id, { enabled: nextEnabled })
    void promise.then((updated) => {
      if (!updated) return
      if (nextEnabled) {
        setFeedback(`${REMOTE_PROVIDER_LABEL[source.sourceType]} source "${updated.name}" enabled. Syncing...`)
        syncSourceByType(source.sourceType, source.id)
      } else {
        setFeedback(`${REMOTE_PROVIDER_LABEL[source.sourceType]} source "${updated.name}" disabled.`)
      }
    })
    setOpenMenuKey(null)
  }

  // Sync one source
  const handleSyncSource = (source: RemoteSourceListItem) => {
    const promise = source.sourceType === 'subsonic'
      ? syncSubsonicSource(source.id)
      : syncJellyfinSource(source.id)
    void promise.then((ok) => {
      if (!ok) return
      setFeedback(`Sync finished for ${REMOTE_PROVIDER_LABEL[source.sourceType]} source "${source.name}".`)
    })
  }

  // Sync all
  const handleSyncAll = () => {
    if (remoteSources.length === 0) return
    const syncSessionKey = createRemoteSyncSessionKey()
    void Promise.all([
      subsonicSources.length > 0 ? syncAllSubsonicSources(syncSessionKey) : Promise.resolve(true),
      jellyfinSources.length > 0 ? syncAllJellyfinSources(syncSessionKey) : Promise.resolve(true)
    ]).then(([subOk, jelOk]) => {
      if (!subOk || !jelOk) return
      setFeedback('Sync finished for all configured remote sources.')
    })
  }

  // Delete source
  const handleDeleteSource = async (source: RemoteSourceListItem, purgeTracks: boolean) => {
    const deleted = source.sourceType === 'subsonic'
      ? await deleteSubsonicSource(source.id, purgeTracks)
      : await deleteJellyfinSource(source.id, purgeTracks)
    if (!deleted) return

    setFeedback(
      purgeTracks
        ? `Deleted ${REMOTE_PROVIDER_LABEL[source.sourceType]} source "${source.name}" and purged synced tracks.`
        : `Deleted ${REMOTE_PROVIDER_LABEL[source.sourceType]} source "${source.name}". Tracks remain as unavailable placeholders.`
    )
    setDeleteConfirmKey(null)
    if (editingSource && editingSource.sourceType === source.sourceType && editingSource.sourceId === source.id) {
      resetWizard()
    }
  }

  // Can the edit-mode user skip the test? (blank password = using stored creds)
  const canSkipTest = wizardMode === 'edit' && passwordInput.trim() === '' && testStatus === 'idle'

  // Connection step button label
  const connectionButtonLabel = (() => {
    if (testStatus === 'testing') return 'Testing...'
    if (testStatus === 'success') return 'Continue'
    if (canSkipTest) return 'Continue'
    return 'Test Connection'
  })()

  // Render
  if (wizardMode !== null) {
    return (
      <div className="settings-integration-card settings-library-remote-card">
        <div className="remote-wizard">
          <button className="remote-wizard-back" onClick={resetWizard}>
            ← Back to Sources
          </button>

          <div className="remote-wizard-title-row">
            <h4 className="remote-wizard-title">
              {wizardMode === 'add' ? 'Add Remote Server' : `Edit "${nameInput || 'Source'}"`}
            </h4>
            <span className="remote-wizard-step-label">Step {wizardStep + 1} of 2</span>
          </div>

          {/* Step indicators */}
          <div className="remote-wizard-steps">
            {STEP_LABELS.map((label, i) => {
              const isActive = wizardStep === i
              const isCompleted = wizardStep > i
              return (
                <div key={label} style={{ display: 'contents' }}>
                  {i > 0 && <div className="remote-wizard-step-connector" />}
                  <div
                    className={`remote-wizard-step-indicator ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}
                    onClick={isCompleted ? () => setWizardStep(i as WizardStep) : undefined}
                  >
                    <span className="remote-wizard-step-number">{i + 1}</span>
                    {label}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Step content */}
          <div className="remote-wizard-body">
            {wizardStep === 0 && (
              <>
                <label className="settings-field">
                  <span className="settings-field-label">Server URL</span>
                  <input
                    className="settings-select"
                    type="text"
                    value={baseUrlInput}
                    onChange={(e) => setBaseUrlInput(e.target.value)}
                    placeholder="http://localhost:4533"
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field-label">Username</span>
                  <input
                    className="settings-select"
                    type="text"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                  />
                </label>
                <label className="settings-field">
                  <span className="settings-field-label">
                    Password{editingSource !== null ? ' (leave blank to keep existing)' : ''}
                  </span>
                  <input
                    className="settings-select"
                    type="password"
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                  />
                </label>
                {testMessage && (
                  <p className={`remote-test-status ${
                    testStatus === 'success' ? 'remote-test-status-success' :
                    testStatus === 'failed' ? 'remote-test-status-error' :
                    testStatus === 'testing' ? 'remote-test-status-testing' : ''
                  }`}>
                    {testMessage}
                  </p>
                )}
                {showTypeFallback && (
                  <div className="remote-type-fallback">
                    <p className="settings-note">
                      Could not auto-detect. Select your server type:
                    </p>
                    <div className="remote-type-fallback-row">
                      <button
                        className={`remote-type-option ${fallbackType === 'subsonic' ? 'selected' : ''}`}
                        onClick={() => setFallbackType('subsonic')}
                      >
                        <span className="remote-type-option-title">Subsonic / Navidrome</span>
                      </button>
                      <button
                        className={`remote-type-option ${fallbackType === 'jellyfin' ? 'selected' : ''}`}
                        onClick={() => setFallbackType('jellyfin')}
                      >
                        <span className="remote-type-option-title">Jellyfin</span>
                      </button>
                    </div>
                    <button
                      className="settings-btn settings-btn-primary"
                      onClick={() => void handleTestWithFallbackType()}
                      disabled={testStatus === 'testing'}
                    >
                      {testStatus === 'testing' ? 'Testing...' : 'Retry with Selected Type'}
                    </button>
                  </div>
                )}
              </>
            )}

            {wizardStep === 1 && (
              <>
                <label className="settings-field">
                  <span className="settings-field-label">Source Name</span>
                  <input
                    className="settings-select"
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    placeholder="My Remote Library"
                  />
                </label>
                <div className="settings-field settings-field-inline">
                  <span className="settings-field-label">Enabled</span>
                  <button
                    className={`settings-toggle ${enabledInput ? 'active' : ''}`}
                    onClick={() => setEnabledInput(!enabledInput)}
                  >
                    {enabledInput ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
                <div className="remote-summary">
                  <div className="remote-summary-row">
                    <span className="remote-summary-label">Type</span>
                    <span className="remote-summary-value">
                      {resolvedServerType
                        ? REMOTE_PROVIDER_LABEL[resolvedServerType]
                        : 'Unknown'}
                    </span>
                  </div>
                  <div className="remote-summary-row">
                    <span className="remote-summary-label">URL</span>
                    <span className="remote-summary-value">{baseUrlInput.trim()}</span>
                  </div>
                  <div className="remote-summary-row">
                    <span className="remote-summary-label">Username</span>
                    <span className="remote-summary-value">{usernameInput.trim()}</span>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="remote-wizard-footer">
            <button className="settings-btn" onClick={resetWizard}>
              Cancel
            </button>
            <div className="remote-wizard-footer-right">
              {wizardStep > 0 && (
                <button
                  className="settings-btn"
                  onClick={() => setWizardStep(0)}
                >
                  Back
                </button>
              )}
              {wizardStep === 0 && !showTypeFallback && (
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={handleConnectionStepAction}
                  disabled={testStatus === 'testing'}
                >
                  {connectionButtonLabel}
                </button>
              )}
              {wizardStep === 1 && (
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={() => void handleSaveSource()}
                  disabled={!nameInput.trim()}
                >
                  {wizardMode === 'add' ? 'Add Source' : 'Save Changes'}
                </button>
              )}
            </div>
          </div>

          <p className="settings-note">
            Passwords are encrypted with OS secure storage and never stored in track URLs.
          </p>
        </div>
      </div>
    )
  }

  // Source list view
  return (
    <div className="settings-integration-card settings-library-remote-card">
      <div className="settings-integration-card-head">
        <h4>Remote Music Servers</h4>
        <p>Connect to Subsonic/Navidrome and Jellyfin servers.</p>
      </div>

      <div className="remote-panel-header">
        <div className="remote-panel-header-actions">
          <button className="settings-btn settings-btn-primary" onClick={openAddWizard}>
            + Add Server
          </button>
        </div>
        <div className="remote-panel-header-actions">
          <button
            className="settings-btn"
            onClick={handleSyncAll}
            disabled={isAnyRemoteSyncing || remoteSources.length === 0}
          >
            {isAnyRemoteSyncing ? 'Syncing...' : 'Sync All'}
          </button>
        </div>
      </div>

      {remoteSources.length > 0 ? (
        <div className="remote-source-list">
          {remoteSources.map((source) => {
            const key = `${source.sourceType}:${source.id}`
            const statusItem = remoteStatusBySourceKey.get(key)
            const progress = statusItem?.progress ?? null
            const lastSyncTs = statusItem?.lastSyncAt ?? source.last_sync_at
            const statusText = statusItem?.status ?? source.last_status
            const errorText = statusItem?.error ?? source.last_error
            const isDeleting = deleteConfirmKey === key

            if (isDeleting) {
              return (
                <div key={key} className="remote-delete-confirm">
                  <p className="remote-delete-confirm-title">
                    Delete {REMOTE_PROVIDER_LABEL[source.sourceType]} source "{source.name}"?
                  </p>
                  <p className="remote-delete-confirm-desc">
                    Choose whether to keep synced tracks as unavailable placeholders or purge them completely.
                  </p>
                  <div className="remote-delete-confirm-actions">
                    <button className="settings-btn" onClick={() => void handleDeleteSource(source, false)}>
                      Keep Tracks
                    </button>
                    <button className="settings-btn settings-btn-danger" onClick={() => void handleDeleteSource(source, true)}>
                      Purge Tracks
                    </button>
                    <button className="settings-btn" onClick={() => setDeleteConfirmKey(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )
            }

            return (
              <div
                key={key}
                className={`remote-source-card ${openMenuKey === key ? 'remote-source-card-menu-open' : ''}`}
              >
                <div className="remote-source-card-header">
                  <span className={getStatusDotClass(source, statusItem)} />
                  <span className="remote-source-card-header-title">{source.name}</span>
                  <span className="settings-chip settings-chip-mono">{REMOTE_PROVIDER_LABEL[source.sourceType]}</span>
                </div>
                <p className="remote-source-card-meta">
                  {source.base_url} · {source.username}
                </p>
                {statusText === 'error' && errorText && (
                  <p className="remote-source-card-status remote-source-card-status-error">
                    Error: {errorText}
                  </p>
                )}
                {lastSyncTs && statusText !== 'error' && (
                  <p className="remote-source-card-status">
                    Synced {formatTimeAgo(lastSyncTs)}
                  </p>
                )}
                {progress && (
                  <p className="remote-source-card-progress">
                    {progress.activity}
                    {progress.total !== null ? ` (${progress.current ?? 0}/${progress.total})` : ''}
                    {progress.detail ? ` · ${progress.detail}` : ''}
                  </p>
                )}
                <div className="remote-source-card-footer">
                  <button
                    className="settings-btn"
                    onClick={() => handleSyncSource(source)}
                    disabled={isAnyRemoteSyncing || source.enabled !== 1}
                  >
                    Sync
                  </button>
                  <div className="remote-overflow-wrap" ref={openMenuKey === key ? menuRef : undefined}>
                    <button
                      className="remote-overflow-btn"
                      onClick={() => setOpenMenuKey(openMenuKey === key ? null : key)}
                    >
                      ···
                    </button>
                    {openMenuKey === key && (
                      <div className="remote-overflow-menu">
                        <button className="remote-overflow-menu-item" onClick={() => openEditWizard(source)}>
                          Edit
                        </button>
                        <button className="remote-overflow-menu-item" onClick={() => handleToggleEnabled(source)}>
                          {source.enabled === 1 ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          className="remote-overflow-menu-item remote-overflow-menu-item-danger"
                          onClick={() => {
                            setDeleteConfirmKey(key)
                            setOpenMenuKey(null)
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="remote-empty-state">
          <p className="remote-empty-state-title">No remote servers configured</p>
          <p className="remote-empty-state-desc">
            Connect a Subsonic, Navidrome, or Jellyfin server to stream your music library.
          </p>
          <button className="settings-btn settings-btn-primary" onClick={openAddWizard}>
            + Add Your First Server
          </button>
        </div>
      )}

      {feedback && <p className="settings-note settings-note-success">{feedback}</p>}
      {remoteErrorMessages.map((msg, i) => (
        <p key={`${msg}-${i}`} className="settings-note settings-note-error">{msg}</p>
      ))}
    </div>
  )
}
