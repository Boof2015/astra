(function () {
  const STORAGE_KEY = 'astra-remote-api-token-v1'
  const POLL_INTERVAL_MS = 5000
  const PAIR_POLL_INTERVAL_MS = 1500
  const RECONNECT_DELAY_MS = 2000
  const NOTICE_TIMEOUT_MS = 3600
  const ARTWORK_RETRY_DELAY_MS = 800
  const ARTWORK_MAX_RETRIES = 4
  const DEFAULT_ACCENT = '#38bdf8'
  const KEYBOARD_SEEK_SMALL_STEP_SECONDS = 5
  const KEYBOARD_SEEK_LARGE_STEP_SECONDS = 15

  const $ = (id) => document.getElementById(id)

  const elements = {
    themeColorMeta: document.getElementById('theme-color-meta'),
    pairIdle: $('pair-idle'),
    pairPending: $('pair-pending'),
    pairPendingTitle: $('pair-pending-title'),
    pairPendingCopy: $('pair-pending-copy'),
    pairPendingTimer: $('pair-pending-timer'),
    pairError: $('pair-error'),
    pairErrorTitle: $('pair-error-title'),
    pairErrorCopy: $('pair-error-copy'),
    pairRetryButton: $('pair-retry-button'),
    pairLinkForm: $('pair-link-form'),
    pairLinkInput: $('pair-link-input'),
    pairLinkButton: $('pair-link-button'),
    showManualAuthButton: $('show-manual-auth-button'),
    hideManualAuthButton: $('hide-manual-auth-button'),
    authPanel: $('auth-panel'),
    authForm: $('auth-form'),
    authToken: $('auth-token'),
    connectButton: $('connect-button'),
    originChip: $('origin-chip'),
    statusPill: $('status-pill'),
    connectionLabel: $('connection-label'),
    noticeBanner: $('notice-banner'),
    noticeText: $('notice-text'),

    remoteController: $('remote-controller'),
    transportPanel: $('transport-panel'),
    artworkImage: $('artwork-image'),
    artworkPlaceholder: $('artwork-placeholder'),
    trackTitle: $('track-title'),
    trackArtist: $('track-artist'),
    trackAlbum: $('track-album'),
    elapsedTime: $('elapsed-time'),
    remainingTime: $('remaining-time'),
    seekTrack: $('seek-track'),
    seekPreview: $('seek-preview'),
    seekFill: $('seek-fill'),
    seekThumb: $('seek-thumb'),
    previousButton: $('previous-button'),
    playButton: $('play-button'),
    nextButton: $('next-button'),
    favoriteButton: $('favorite-button'),
    reconnectButton: $('reconnect-button'),
    forgetButton: $('forget-button'),
    iconPlay: $('icon-play'),
    iconPause: $('icon-pause'),
    iconLoading: $('icon-loading')
  }

  const state = {
    token: (localStorage.getItem(STORAGE_KEY) || '').trim(),
    snapshot: null,
    connectionState: 'idle',
    connectionMessage: 'Waiting for pairing or a Local API key.',
    noticeMessage: '',
    noticeTone: 'info',
    noticeTimer: null,
    eventAbortController: null,
    reconnectTimer: null,
    pollTimer: null,
    pairPollTimer: null,
    artworkObjectUrl: null,
    artworkTrackId: null,
    artworkRequestId: 0,
    artworkRetryCount: 0,
    isScrubbing: false,
    scrubValue: 0,
    optimisticSeekTime: null,
    hasInitialSnapshot: false,
    manualAuthVisible: false,
    pairingState: 'idle',
    pairingMessage: '',
    pairingPollToken: '',
    pairingExpiresAt: 0,
    pairingAttemptCounter: 0,
    activePairingAttemptId: 0,
    isSeekFocused: false
  }

  elements.originChip.textContent = window.location.origin
  elements.authToken.value = state.token


  // ── Helpers ──

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

  function clampTime(value, duration) {
    if (!Number.isFinite(duration) || duration <= 0) return 0
    if (!Number.isFinite(value)) return 0
    return clamp(value, 0, duration)
  }

  function formatTime(totalSeconds) {
    const s = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`
  }

  function haptic(ms) { if (navigator.vibrate) navigator.vibrate(ms || 8) }

  function normalizeHexColor(value) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(trimmed)
    if (shortMatch) {
      const [r, g, b] = shortMatch[1].split('')
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
    }

    const fullMatch = /^#([0-9a-fA-F]{6})$/.exec(trimmed)
    if (!fullMatch) return null
    return `#${fullMatch[1].toLowerCase()}`
  }

  function hexToRgb(hex) {
    const normalized = normalizeHexColor(hex)
    if (!normalized) return null
    return {
      r: Number.parseInt(normalized.slice(1, 3), 16),
      g: Number.parseInt(normalized.slice(3, 5), 16),
      b: Number.parseInt(normalized.slice(5, 7), 16)
    }
  }

  function rgbToHex(r, g, b) {
    const clampChannel = (value) => clamp(Math.round(value), 0, 255)
    const toHex = (value) => clampChannel(value).toString(16).padStart(2, '0')
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }

  function mixRgb(base, target, amount) {
    return {
      r: Math.round(base.r + ((target.r - base.r) * amount)),
      g: Math.round(base.g + ((target.g - base.g) * amount)),
      b: Math.round(base.b + ((target.b - base.b) * amount))
    }
  }

  function deriveAccentHover(hex) {
    const rgb = hexToRgb(hex) || hexToRgb(DEFAULT_ACCENT)
    const mixed = mixRgb(rgb, { r: 255, g: 255, b: 255 }, 0.28)
    return rgbToHex(mixed.r, mixed.g, mixed.b)
  }

  function deriveAccentContrast(hex) {
    const rgb = hexToRgb(hex) || hexToRgb(DEFAULT_ACCENT)
    const brightness = ((rgb.r * 299) + (rgb.g * 587) + (rgb.b * 114)) / 1000
    return brightness >= 170 ? '#041017' : '#f8fbff'
  }

  function deriveThemeColor(hex) {
    const accentRgb = hexToRgb(hex) || hexToRgb(DEFAULT_ACCENT)
    const themeRgb = mixRgb({ r: 11, g: 17, b: 24 }, accentRgb, 0.18)
    return rgbToHex(themeRgb.r, themeRgb.g, themeRgb.b)
  }

  function setThemeAccent(color) {
    const accent = normalizeHexColor(color) || DEFAULT_ACCENT
    const accentHover = deriveAccentHover(accent)
    const accentRgb = hexToRgb(accent) || hexToRgb(DEFAULT_ACCENT)
    const accentHoverRgb = hexToRgb(accentHover) || accentRgb
    const accentContrast = deriveAccentContrast(accent)
    const themeColor = deriveThemeColor(accent)

    document.documentElement.style.setProperty('--accent', accent)
    document.documentElement.style.setProperty('--accent-rgb', `${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}`)
    document.documentElement.style.setProperty('--accent-hover', accentHover)
    document.documentElement.style.setProperty('--accent-hover-rgb', `${accentHoverRgb.r}, ${accentHoverRgb.g}, ${accentHoverRgb.b}`)
    document.documentElement.style.setProperty('--accent-glow', `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.34)`)
    document.documentElement.style.setProperty('--accent-contrast', accentContrast)
    document.documentElement.style.setProperty('--browser-theme-color', themeColor)
    if (elements.themeColorMeta) elements.themeColorMeta.setAttribute('content', themeColor)
  }

  // ── Artwork ──

  function revokeArtwork() {
    if (state.artworkObjectUrl) { URL.revokeObjectURL(state.artworkObjectUrl); state.artworkObjectUrl = null }
  }

  function setArtwork(trackId, objectUrl) {
    revokeArtwork()
    state.artworkTrackId = trackId
    state.artworkObjectUrl = objectUrl
    renderPlayer()
  }

  function clearArtwork(trackId) {
    revokeArtwork()
    state.artworkTrackId = trackId || null
    renderPlayer()
  }

  // ── Timers ──

  function stopPolling() { if (state.pollTimer !== null) { clearInterval(state.pollTimer); state.pollTimer = null } }
  function stopPairingPolling() { if (state.pairPollTimer !== null) { clearTimeout(state.pairPollTimer); state.pairPollTimer = null } }
  function stopEventStream() { if (state.eventAbortController) { state.eventAbortController.abort(); state.eventAbortController = null } }
  function stopReconnectTimer() { if (state.reconnectTimer !== null) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null } }
  function stopRealtime() { stopEventStream(); stopPolling(); stopReconnectTimer() }

  // ── Pairing state ──

  function setPairingState(next, message, expiresAt) {
    state.pairingState = next
    state.pairingMessage = message || ''
    state.pairingExpiresAt = typeof expiresAt === 'number' ? expiresAt : 0
    renderPage()
  }

  function getPairPhase() {
    const s = state.pairingState
    if (s === 'claiming' || s === 'pending') return 'pending'
    if (s === 'rejected' || s === 'expired' || s === 'consumed' || s === 'error') return 'error'
    return 'idle'
  }

  function getViewModel() {
    if (state.manualAuthVisible) return 'manual-auth'

    const pairPhase = getPairPhase()
    if (pairPhase === 'pending') return 'setup-pending'
    if (pairPhase === 'error') return 'setup-error'

    if (state.token) {
      return state.hasInitialSnapshot ? 'player-ready' : 'paired-connecting'
    }

    return 'setup-idle'
  }

  function beginPairingAttempt() {
    stopPairingPolling()
    state.pairingPollToken = ''
    state.pairingAttemptCounter += 1
    state.activePairingAttemptId = state.pairingAttemptCounter
    return state.activePairingAttemptId
  }

  function isActivePairingAttempt(attemptId) {
    return attemptId > 0 && state.activePairingAttemptId === attemptId
  }

  function clearPairingAttempt() {
    stopPairingPolling()
    state.pairingPollToken = ''
    state.activePairingAttemptId = 0
  }

  function completePairingAttempt(attemptId) {
    if (!isActivePairingAttempt(attemptId)) return false
    clearPairingAttempt()
    return true
  }

  function schedulePairingPoll(attemptId, delayMs) {
    if (!isActivePairingAttempt(attemptId) || !state.pairingPollToken) return
    stopPairingPolling()
    state.pairPollTimer = setTimeout(() => {
      state.pairPollTimer = null
      void fetchPairingStatus(attemptId)
    }, delayMs)
  }

  // ── Device detection ──

  function detectClientLabel() {
    const ua = navigator.userAgent || ''
    if (/iPhone/i.test(ua)) return 'iPhone'
    if (/iPad/i.test(ua)) return 'iPad'
    if (/Android/i.test(ua)) return 'Android Phone'
    if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac Browser'
    if (/Windows/i.test(ua)) return 'Windows Browser'
    return 'Remote Controller'
  }

  function deriveDeviceName() {
    const cl = detectClientLabel()
    return cl === 'Remote Controller' ? 'Astra Remote' : `${cl} Remote`
  }

  // ── URL helpers ──

  function clearPairingHash() {
    if (!window.location.hash) return
    window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`)
  }

  function extractPairingTicket(value) {
    const v = typeof value === 'string' ? value.trim() : ''
    if (!v) return ''
    const dh = new URLSearchParams(v.replace(/^#/, ''))
    const dt = (dh.get('pair') || '').trim()
    if (dt) return dt
    try {
      const u = new URL(v, window.location.origin)
      const hp = new URLSearchParams(u.hash.replace(/^#/, ''))
      const ht = (hp.get('pair') || '').trim()
      if (ht) return ht
      const st = (u.searchParams.get('pair') || '').trim()
      if (st) return st
    } catch { /* ignore */ }
    return /^[A-Za-z0-9_-]{16,}$/.test(v) ? v : ''
  }

  function prepareForPairingClaim() {
    stopRealtime()
    clearPairingAttempt()
    state.snapshot = null
    state.optimisticSeekTime = null
    state.hasInitialSnapshot = false
    state.token = ''
    state.manualAuthVisible = false
    state.pairingState = 'idle'
    state.pairingMessage = ''
    state.pairingExpiresAt = 0
    state.connectionState = 'idle'
    state.connectionMessage = 'Waiting for Astra to approve this phone.'
    elements.authToken.value = ''
    elements.pairLinkInput.value = ''
    clearArtwork(null)
    renderPage()
  }

  // ── Notices ──

  function setNotice(message, tone, timeoutMs) {
    if (state.noticeTimer !== null) { clearTimeout(state.noticeTimer); state.noticeTimer = null }
    state.noticeMessage = message
    state.noticeTone = tone || 'info'
    renderNotice()
    if (timeoutMs > 0) {
      state.noticeTimer = setTimeout(() => { state.noticeTimer = null; state.noticeMessage = ''; renderNotice() }, timeoutMs)
    }
  }

  function clearNotice() {
    if (state.noticeTimer !== null) { clearTimeout(state.noticeTimer); state.noticeTimer = null }
    state.noticeMessage = ''
    renderNotice()
  }

  // ── Render ──

  function renderNotice() {
    if (!state.noticeMessage) { elements.noticeBanner.hidden = true; return }
    elements.noticeBanner.hidden = false
    elements.noticeBanner.className = `glass-panel notice-banner notice-${state.noticeTone}`
    elements.noticeText.textContent = state.noticeMessage
  }

  function renderStatus() {
    const labels = { idle: 'Idle', connecting: 'Syncing', connected: 'Live', reconnecting: 'Retrying', error: 'Offline' }
    const classes = { idle: 'status-idle', connecting: 'status-connecting', connected: 'status-live', reconnecting: 'status-connecting', error: 'status-error' }
    document.body.dataset.connectionState = state.connectionState
    elements.statusPill.textContent = labels[state.connectionState] || 'Idle'
    elements.statusPill.className = `status-pill ${classes[state.connectionState] || 'status-idle'}`
    elements.connectionLabel.textContent = state.connectionMessage
    elements.connectButton.disabled = state.connectionState === 'connecting'
  }

  function renderPage() {
    const view = getViewModel()
    const hasToken = Boolean(state.token)
    const page = hasToken ? 'player' : 'setup'
    const phase = getPairPhase()
    const showRemoteController = view === 'paired-connecting' || view === 'player-ready'
    const showTransport = view === 'player-ready'
    const showConnectionLabel = view !== 'setup-pending' && (view !== 'player-ready' || state.connectionState !== 'connected')

    document.body.dataset.page = page
    document.body.dataset.pairPhase = phase
    document.body.dataset.manualAuth = state.manualAuthVisible ? 'true' : 'false'
    document.body.dataset.view = view

    elements.pairIdle.hidden = view !== 'setup-idle'
    elements.pairPending.hidden = view !== 'setup-pending'
    elements.pairError.hidden = view !== 'setup-error'
    elements.authPanel.hidden = view !== 'manual-auth'
    elements.remoteController.hidden = !showRemoteController
    elements.transportPanel.hidden = !showTransport

    // Header buttons
    elements.reconnectButton.hidden = !hasToken
    elements.forgetButton.hidden = !hasToken
    elements.reconnectButton.disabled = !hasToken || state.connectionState === 'connecting'
    elements.forgetButton.disabled = !hasToken

    // Connection label — hide while approval is pending and once the live player is connected.
    elements.connectionLabel.hidden = !showConnectionLabel

    // Pair idle form state
    elements.pairLinkInput.disabled = phase === 'pending'
    elements.pairLinkButton.disabled = phase === 'pending'
    elements.showManualAuthButton.disabled = phase === 'pending'

    // Pair pending content
    if (view === 'setup-pending') {
      const isClaiming = state.pairingState === 'claiming'
      const countdown = state.pairingExpiresAt > 0 ? Math.max(0, state.pairingExpiresAt - Date.now()) : 0
      elements.pairPendingTitle.textContent = isClaiming ? 'Starting pairing' : 'Waiting for approval'
      elements.pairPendingCopy.textContent = state.pairingMessage || (isClaiming
        ? 'Connecting to Astra...'
        : 'Open Astra on your desktop and tap Approve to connect this phone.')
      elements.pairPendingTimer.textContent = !isClaiming && countdown > 0 ? formatTime(countdown / 1000) : ''
    }

    // Pair error content
    if (view === 'setup-error') {
      const errorLabels = {
        rejected: 'Request rejected',
        expired: 'Link expired',
        consumed: 'Link already used',
        error: 'Pairing failed'
      }
      elements.pairErrorCopy.textContent = state.pairingMessage || 'Something went wrong. Try again from the desktop.'
      elements.pairErrorTitle.textContent = errorLabels[state.pairingState] || 'Pairing failed'
    }

    // Auth panel
    elements.authToken.disabled = state.connectionState === 'connecting'
    elements.hideManualAuthButton.disabled = state.connectionState === 'connecting'

    setThemeAccent(state.snapshot && state.snapshot.visualizerLineColor)
    renderStatus()
    renderNotice()
    renderPlayer()
  }

  function renderPlayer() {
    const snapshot = state.snapshot
    const track = snapshot && snapshot.currentTrack ? snapshot.currentTrack : null
    const inlineArt = track && typeof track.artworkDataUrl === 'string' ? track.artworkDataUrl : null
    const duration = snapshot ? Math.max(0, snapshot.duration || 0) : 0
    const current = snapshot ? Math.max(0, snapshot.currentTime || 0) : 0
    const display = state.isScrubbing
      ? state.scrubValue
      : (state.optimisticSeekTime !== null ? state.optimisticSeekTime : current)
    const clamped = clampTime(display, duration)
    const progressRatio = duration > 0 ? clamp(clamped / duration, 0, 1) : 0
    const fillWidth = `calc((100% - 30px) * ${progressRatio})`
    const thumbLeft = `calc(15px + ((100% - 30px) * ${progressRatio}))`
    const hasTrack = Boolean(track)
    const seekDisabled = !track || duration <= 0
    const showSeekPreview = !seekDisabled && (state.isScrubbing || state.isSeekFocused)

    // Metadata
    document.body.dataset.hasTrack = hasTrack ? 'true' : 'false'
    elements.trackTitle.textContent = track ? track.title : 'Nothing playing'
    elements.trackArtist.textContent = track ? track.artist : ''
    elements.trackAlbum.textContent = track ? track.album : ''

    // Play/pause icons
    const playing = snapshot && snapshot.playbackState === 'playing'
    const loading = snapshot && snapshot.playbackState === 'loading'
    elements.iconPlay.style.display = (playing || loading) ? 'none' : 'block'
    elements.iconPause.style.display = playing ? 'block' : 'none'
    elements.iconLoading.style.display = loading ? 'block' : 'none'
    elements.playButton.setAttribute('aria-label', loading ? 'Loading track' : (playing ? 'Pause' : 'Play'))
    elements.playButton.setAttribute('title', loading ? 'Loading track' : (playing ? 'Pause' : 'Play'))
    elements.playButton.setAttribute('aria-pressed', playing ? 'true' : 'false')

    // Favorite
    elements.favoriteButton.classList.toggle('is-active', Boolean(track && track.isFavorite))
    elements.favoriteButton.setAttribute('aria-label', track && track.isFavorite ? 'Remove favorite' : 'Favorite')
    elements.favoriteButton.setAttribute('title', track && track.isFavorite ? 'Remove favorite' : 'Favorite')
    elements.favoriteButton.setAttribute('aria-pressed', track && track.isFavorite ? 'true' : 'false')

    // Time
    elements.elapsedTime.textContent = formatTime(clamped)
    elements.remainingTime.textContent = `-${formatTime(Math.max(0, duration - clamped))}`

    // Seek
    elements.seekFill.style.width = fillWidth
    elements.seekThumb.style.left = thumbLeft
    elements.seekPreview.textContent = formatTime(clamped)
    elements.seekPreview.style.left = thumbLeft
    elements.seekPreview.hidden = !showSeekPreview
    elements.seekPreview.classList.toggle('is-visible', showSeekPreview)
    elements.seekTrack.classList.toggle('disabled', seekDisabled)
    elements.seekTrack.classList.toggle('is-scrubbing', state.isScrubbing)
    elements.seekTrack.classList.toggle('is-focused', state.isSeekFocused)
    elements.seekTrack.tabIndex = seekDisabled ? -1 : 0
    elements.seekTrack.setAttribute('aria-disabled', seekDisabled ? 'true' : 'false')
    elements.seekTrack.setAttribute('aria-valuemin', '0')
    elements.seekTrack.setAttribute('aria-valuemax', String(Math.round(duration)))
    elements.seekTrack.setAttribute('aria-valuenow', String(Math.round(clamped)))
    elements.seekTrack.setAttribute('aria-valuetext', seekDisabled
      ? 'Nothing playing'
      : `${formatTime(clamped)} of ${formatTime(duration)}`)

    // Button states
    const hasQueue = snapshot ? snapshot.queueLength > 0 : false
    elements.previousButton.disabled = !hasQueue
    elements.nextButton.disabled = !hasQueue
    elements.playButton.disabled = !track || loading
    elements.favoriteButton.disabled = !track

    // Artwork
    const src = inlineArt || state.artworkObjectUrl
    if (src) {
      elements.artworkImage.src = src
      elements.artworkImage.hidden = false
      elements.artworkPlaceholder.hidden = true
    } else {
      elements.artworkImage.hidden = true
      elements.artworkPlaceholder.hidden = false
    }
  }

  // ── Token ──

  function persistToken(token) {
    if (token) localStorage.setItem(STORAGE_KEY, token)
    else localStorage.removeItem(STORAGE_KEY)
    state.token = token
    elements.authToken.value = token
  }

  function handleAuthorizationFailure() {
    stopRealtime()
    clearPairingAttempt()
    persistToken('')
    state.snapshot = null
    state.optimisticSeekTime = null
    state.hasInitialSnapshot = false
    state.manualAuthVisible = false
    state.connectionState = 'error'
    state.connectionMessage = 'API key rejected.'
    clearArtwork(null)
    setNotice('Authentication failed. Copy the latest key from Astra.', 'error', 0)
    setPairingState('idle', '', 0)
    renderPage()
    elements.authToken.focus()
  }

  // ── Fetch ──

  async function authorizedFetch(path, options) {
    if (!state.token) throw new Error('Missing token.')
    const init = options || {}
    const headers = new Headers(init.headers || {})
    headers.set('Authorization', `Bearer ${state.token}`)
    return fetch(path, { ...init, headers, cache: 'no-store' })
  }

  // ── Artwork sync ──

  async function syncArtwork(snapshot) {
    const track = snapshot && snapshot.currentTrack ? snapshot.currentTrack : null
    const trackId = track ? track.id : null
    if (!trackId) { clearArtwork(null); return }
    if (track.artworkDataUrl) { clearArtwork(trackId); return }
    if (trackId === state.artworkTrackId && state.artworkObjectUrl) return
    clearArtwork(trackId)
    if (!track.artworkUrl) return

    const requestId = ++state.artworkRequestId
    state.artworkRetryCount = 0

    try {
      const resp = await authorizedFetch(`/v1/artwork/current?trackId=${encodeURIComponent(trackId)}`, { headers: { Accept: 'image/*' } })
      if (resp.status === 401) { handleAuthorizationFailure(); return }
      if (resp.status === 404) {
        if (requestId === state.artworkRequestId && state.artworkRetryCount < ARTWORK_MAX_RETRIES) scheduleArtworkRetry(requestId, trackId)
        else if (requestId === state.artworkRequestId) clearArtwork(trackId)
        return
      }
      if (!resp.ok) throw new Error(`Artwork ${resp.status}`)
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      if (requestId !== state.artworkRequestId || !state.snapshot || !state.snapshot.currentTrack || state.snapshot.currentTrack.id !== trackId) { URL.revokeObjectURL(url); return }
      setArtwork(trackId, url)
    } catch { if (requestId === state.artworkRequestId) clearArtwork(trackId) }
  }

  function scheduleArtworkRetry(requestId, trackId) {
    state.artworkRetryCount += 1
    setTimeout(() => {
      if (requestId !== state.artworkRequestId) return
      if (!state.snapshot || !state.snapshot.currentTrack || state.snapshot.currentTrack.id !== trackId) return
      void retryArtworkFetch(requestId, trackId)
    }, ARTWORK_RETRY_DELAY_MS * state.artworkRetryCount)
  }

  async function retryArtworkFetch(requestId, trackId) {
    try {
      const resp = await authorizedFetch(`/v1/artwork/current?trackId=${encodeURIComponent(trackId)}`, { headers: { Accept: 'image/*' } })
      if (requestId !== state.artworkRequestId) return
      if (resp.status === 401) { handleAuthorizationFailure(); return }
      if (resp.status === 404) {
        if (state.artworkRetryCount < ARTWORK_MAX_RETRIES) scheduleArtworkRetry(requestId, trackId)
        else clearArtwork(trackId)
        return
      }
      if (!resp.ok) throw new Error(`Artwork retry ${resp.status}`)
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      if (requestId !== state.artworkRequestId || !state.snapshot || !state.snapshot.currentTrack || state.snapshot.currentTrack.id !== trackId) { URL.revokeObjectURL(url); return }
      setArtwork(trackId, url)
    } catch { if (requestId === state.artworkRequestId) clearArtwork(trackId) }
  }

  // ── Snapshot ──

  function applySnapshot(snapshot) {
    state.snapshot = snapshot
    state.optimisticSeekTime = null
    state.hasInitialSnapshot = true
    state.connectionState = 'connected'
    state.connectionMessage = 'Connected.'
    clearNotice()
    void syncArtwork(snapshot)
    renderPage()
  }

  async function fetchSnapshot(background) {
    try {
      const resp = await authorizedFetch(background ? '/v1/now-playing' : '/v1/now-playing?inlineArtwork=1')
      if (resp.status === 401) { handleAuthorizationFailure(); return false }
      if (!resp.ok) throw new Error(`${resp.status}`)
      applySnapshot(await resp.json())
      return true
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false
      if (!background) {
        state.connectionState = 'error'
        state.connectionMessage = 'Unable to reach Astra.'
        setNotice('Make sure this phone is on the same network as Astra.', 'error', 0)
        renderPage()
      } else if (state.connectionState === 'connected') {
        state.connectionState = 'reconnecting'
        state.connectionMessage = 'Reconnecting...'
        renderPage()
      }
      return false
    }
  }

  function startPolling() {
    if (state.pollTimer !== null) return
    state.pollTimer = setInterval(() => {
      if (!state.token || state.connectionState === 'connecting') return
      void fetchSnapshot(true)
    }, POLL_INTERVAL_MS)
  }

  function scheduleReconnect() {
    if (state.reconnectTimer !== null || !state.token) return
    state.connectionState = 'reconnecting'
    state.connectionMessage = 'Reconnecting...'
    renderPage()
    startPolling()
    state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; if (state.token) void connect() }, RECONNECT_DELAY_MS)
  }

  // ── Pairing ──

  async function fetchPairingStatus(attemptId) {
    if (!isActivePairingAttempt(attemptId) || !state.pairingPollToken) return
    const pollToken = state.pairingPollToken
    try {
      const resp = await fetch(`/v1/pairing/status?pollToken=${encodeURIComponent(pollToken)}`, { cache: 'no-store' })
      const p = await resp.json().catch(() => ({}))
      if (!isActivePairingAttempt(attemptId) || state.pairingPollToken !== pollToken) return
      if (resp.status === 404) { completePairingAttempt(attemptId); setPairingState('error', 'Astra no longer recognizes this request. Start a new pairing flow.', 0); return }
      if (resp.status === 410 || p.state === 'consumed') { completePairingAttempt(attemptId); setPairingState('consumed', 'This link was already used. Start a new pairing flow.', 0); return }
      if (!resp.ok) throw new Error(`${resp.status}`)
      if (p.state === 'approved' && typeof p.token === 'string' && p.token.trim()) {
        if (!completePairingAttempt(attemptId)) return
        persistToken(p.token.trim())
        state.manualAuthVisible = false
        state.connectionState = 'connecting'
        state.connectionMessage = 'Connecting...'
        state.hasInitialSnapshot = false
        clearPairingHash()
        setPairingState('idle', '', 0)
        setNotice('Paired successfully.', 'info', NOTICE_TIMEOUT_MS)
        void connect()
        return
      }
      if (p.state === 'rejected') { completePairingAttempt(attemptId); setPairingState('rejected', 'Astra rejected this phone. Try again from the desktop.', p.expiresAt || 0); return }
      if (p.state === 'expired') { completePairingAttempt(attemptId); setPairingState('expired', 'This request expired. Start Pair Remote again.', p.expiresAt || 0); return }
      setPairingState('pending', 'Approve this phone in Astra.', p.expiresAt || state.pairingExpiresAt)
      schedulePairingPoll(attemptId, PAIR_POLL_INTERVAL_MS)
    } catch {
      if (!isActivePairingAttempt(attemptId)) return
      completePairingAttempt(attemptId)
      setPairingState('error', 'Lost connection to Astra. Check the desktop app.', 0)
    }
  }

  async function claimPairingTicket(ticket, attemptId) {
    if (!isActivePairingAttempt(attemptId)) return false
    state.manualAuthVisible = false
    setPairingState('claiming', 'Connecting...', 0)
    try {
      const resp = await fetch('/v1/pairing/claim', {
        method: 'POST', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ ticket, deviceName: deriveDeviceName(), clientLabel: detectClientLabel() })
      })
      const p = await resp.json().catch(() => ({}))
      if (!isActivePairingAttempt(attemptId)) return false
      if (resp.status === 404 || resp.status === 410) { completePairingAttempt(attemptId); setPairingState('expired', 'This link is no longer valid. Start Pair Remote again.', 0); return false }
      if (!resp.ok || typeof p.pollToken !== 'string' || !p.pollToken.trim()) { completePairingAttempt(attemptId); setPairingState('error', 'Astra could not start pairing. Try again.', 0); return false }
      state.pairingPollToken = p.pollToken.trim()
      clearPairingHash()
      setPairingState('pending', 'Approve this phone in Astra to finish.', p.expiresAt || 0)
      void fetchPairingStatus(attemptId)
      return true
    } catch {
      if (!isActivePairingAttempt(attemptId)) return false
      completePairingAttempt(attemptId)
      setPairingState('error', 'Could not reach Astra. Check your network.', 0)
      return false
    }
  }

  function beginPairingClaim(rawInput, notifyOnInvalid) {
    const v = typeof rawInput === 'string' ? rawInput.trim() : ''
    if (!v) return false
    const ticket = extractPairingTicket(v)
    if (!ticket) {
      if (notifyOnInvalid !== false) { setNotice('Paste a pairing link or ticket from Astra.', 'error', NOTICE_TIMEOUT_MS); elements.pairLinkInput.focus() }
      return false
    }
    prepareForPairingClaim()
    const attemptId = beginPairingAttempt()
    void claimPairingTicket(ticket, attemptId)
    return true
  }

  // ── SSE ──

  function handleStreamPayload(payload) {
    try { applySnapshot(JSON.parse(payload)) }
    catch { setNotice('Received unreadable data from Astra.', 'error', NOTICE_TIMEOUT_MS) }
  }

  function processSseChunk(buf, chunk) {
    buf.value += chunk.replace(/\r/g, '')
    let i = buf.value.indexOf('\n\n')
    while (i !== -1) {
      const raw = buf.value.slice(0, i)
      buf.value = buf.value.slice(i + 2)
      let name = 'message'
      const data = []
      for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) { name = line.slice(6).trim(); continue }
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (name === 'now-playing' && data.length > 0) handleStreamPayload(data.join('\n'))
      i = buf.value.indexOf('\n\n')
    }
  }

  async function startEventStream() {
    stopEventStream()
    const ctrl = new AbortController()
    state.eventAbortController = ctrl
    try {
      const resp = await authorizedFetch('/v1/events', { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal })
      if (resp.status === 401) { handleAuthorizationFailure(); return }
      if (!resp.ok || !resp.body) throw new Error(`${resp.status}`)
      stopPolling()
      state.connectionState = 'connected'
      state.connectionMessage = 'Connected.'
      renderPage()
      const reader = resp.body.getReader()
      const dec = new TextDecoder()
      const buf = { value: '' }
      while (true) { const r = await reader.read(); if (r.done) break; processSseChunk(buf, dec.decode(r.value, { stream: true })) }
      processSseChunk(buf, dec.decode())
      if (!ctrl.signal.aborted) scheduleReconnect()
    } catch { if (!ctrl.signal.aborted) scheduleReconnect() }
  }

  async function connect() {
    if (!state.token) { renderPage(); return false }
    stopRealtime()
    state.connectionState = 'connecting'
    state.connectionMessage = 'Connecting...'
    renderPage()
    const ok = await fetchSnapshot(false)
    if (!ok || !state.token) return false
    void startEventStream()
    return true
  }

  async function sendControl(body) {
    if (!state.token) return
    try {
      const resp = await authorizedFetch('/v1/control', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body)
      })
      if (resp.status === 401) { handleAuthorizationFailure(); return }
      if (resp.status === 403) { setNotice('Read-only mode. Enable playback controls in Astra.', 'error', 0); return }
      if (!resp.ok) throw new Error(`${resp.status}`)
      clearNotice()
    } catch { setNotice('Could not send command.', 'error', NOTICE_TIMEOUT_MS) }
  }

  function getSeekDuration() {
    return Math.max(0, (state.snapshot && state.snapshot.duration) || 0)
  }

  function hasSeekableTrack() {
    return Boolean(state.snapshot && state.snapshot.currentTrack && getSeekDuration() > 0)
  }

  function getSeekRatioFromClientX(clientX) {
    const rect = elements.seekTrack.getBoundingClientRect()
    return rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0
  }

  function setScrubFromRatio(ratio) {
    const duration = getSeekDuration()
    state.scrubValue = clampTime(ratio * duration, duration)
    renderPlayer()
  }

  function commitSeekTime(time) {
    const duration = getSeekDuration()
    if (duration <= 0) return
    state.scrubValue = clampTime(time, duration)
    state.optimisticSeekTime = state.scrubValue
    renderPlayer()
    void sendControl({ command: 'seek', time: state.scrubValue })
  }

  // ── Event listeners ──

  elements.pairLinkForm.addEventListener('submit', (e) => { e.preventDefault(); beginPairingClaim(elements.pairLinkInput.value) })

  elements.authForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const t = elements.authToken.value.trim()
    if (!t) { setNotice('Paste the API key first.', 'error', NOTICE_TIMEOUT_MS); return }
    clearPairingAttempt()
    state.snapshot = null
    state.optimisticSeekTime = null
    state.hasInitialSnapshot = false
    clearArtwork(null)
    setPairingState('idle', '', 0)
    persistToken(t)
    state.manualAuthVisible = false
    state.connectionState = 'connecting'
    state.connectionMessage = 'Connecting...'
    renderPage()
    void connect()
  })

  elements.showManualAuthButton.addEventListener('click', () => { state.manualAuthVisible = true; renderPage(); elements.authToken.focus() })
  elements.hideManualAuthButton.addEventListener('click', () => { state.manualAuthVisible = false; renderPage() })

  elements.pairRetryButton.addEventListener('click', () => {
    clearPairingAttempt()
    setPairingState('idle', '', 0)
  })

  elements.reconnectButton.addEventListener('click', () => void connect())

  elements.forgetButton.addEventListener('click', () => {
    stopRealtime()
    clearPairingAttempt()
    persistToken('')
    state.snapshot = null
    state.optimisticSeekTime = null
    state.hasInitialSnapshot = false
    state.manualAuthVisible = false
    state.connectionState = 'idle'
    state.connectionMessage = 'Disconnected.'
    clearArtwork(null)
    setPairingState('idle', '', 0)
    setNotice('Credential removed.', 'info', NOTICE_TIMEOUT_MS)
    renderPage()
  })

  elements.previousButton.addEventListener('click', () => { haptic(8); void sendControl({ command: 'previous' }) })
  elements.playButton.addEventListener('click', () => {
    haptic(10)
    if (!state.snapshot) return
    void sendControl({ command: state.snapshot.playbackState === 'playing' ? 'pause' : 'play' })
  })
  elements.nextButton.addEventListener('click', () => { haptic(8); void sendControl({ command: 'next' }) })
  elements.favoriteButton.addEventListener('click', () => { haptic(6); void sendControl({ command: 'toggle-favorite' }) })

  // Seek bar
  elements.seekTrack.addEventListener('pointerdown', (e) => {
    if (!hasSeekableTrack()) return
    e.preventDefault()
    elements.seekTrack.focus()
    elements.seekTrack.setPointerCapture(e.pointerId)
    state.isScrubbing = true
    setScrubFromRatio(getSeekRatioFromClientX(e.clientX))
    haptic(4)
  })

  elements.seekTrack.addEventListener('pointermove', (e) => {
    if (!state.isScrubbing) return
    setScrubFromRatio(getSeekRatioFromClientX(e.clientX))
  })

  elements.seekTrack.addEventListener('pointerup', (e) => {
    if (!state.isScrubbing) return
    if (elements.seekTrack.hasPointerCapture(e.pointerId)) {
      elements.seekTrack.releasePointerCapture(e.pointerId)
    }
    state.isScrubbing = false
    commitSeekTime(state.scrubValue)
  })

  elements.seekTrack.addEventListener('pointercancel', (e) => {
    if (elements.seekTrack.hasPointerCapture(e.pointerId)) {
      elements.seekTrack.releasePointerCapture(e.pointerId)
    }
    if (!state.isScrubbing) return
    state.isScrubbing = false
    renderPlayer()
  })

  elements.seekTrack.addEventListener('focus', () => {
    state.isSeekFocused = true
    renderPlayer()
  })

  elements.seekTrack.addEventListener('blur', () => {
    state.isSeekFocused = false
    state.isScrubbing = false
    renderPlayer()
  })

  elements.seekTrack.addEventListener('keydown', (e) => {
    if (!hasSeekableTrack()) return
    const duration = getSeekDuration()
    const currentValue = state.isScrubbing ? state.scrubValue : Math.max(0, (state.snapshot && state.snapshot.currentTime) || 0)
    let nextValue = null

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        nextValue = currentValue - KEYBOARD_SEEK_SMALL_STEP_SECONDS
        break
      case 'ArrowRight':
      case 'ArrowUp':
        nextValue = currentValue + KEYBOARD_SEEK_SMALL_STEP_SECONDS
        break
      case 'PageDown':
        nextValue = currentValue - KEYBOARD_SEEK_LARGE_STEP_SECONDS
        break
      case 'PageUp':
        nextValue = currentValue + KEYBOARD_SEEK_LARGE_STEP_SECONDS
        break
      case 'Home':
        nextValue = 0
        break
      case 'End':
        nextValue = duration
        break
      default:
        return
    }

    e.preventDefault()
    state.isScrubbing = false
    state.scrubValue = clampTime(nextValue, duration)
    commitSeekTime(state.scrubValue)
  })

  // Lifecycle
  window.addEventListener('beforeunload', () => { stopRealtime(); clearPairingAttempt(); revokeArtwork() })
  window.addEventListener('hashchange', () => beginPairingClaim(window.location.hash, false))

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .then((registration) => registration.update())
        .catch(() => {})
    })
  }

  // ── Init ──

  renderPage()
  const started = beginPairingClaim(window.location.hash, false)
  if (started) { /* pairing in progress */ }
  else if (state.token) void connect()
  else { state.manualAuthVisible = false; setPairingState('idle', '', 0); renderPage() }
})()
