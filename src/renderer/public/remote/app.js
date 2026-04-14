(function () {
  const STORAGE_KEY = 'astra-remote-api-token-v1'
  const POLL_INTERVAL_MS = 5000
  const RECONNECT_DELAY_MS = 2000
  const NOTICE_TIMEOUT_MS = 3600

  const elements = {
    pairPanel: document.getElementById('pair-panel'),
    pairCopy: document.getElementById('pair-copy'),
    pairStatusChip: document.getElementById('pair-status-chip'),
    setupStepStart: document.getElementById('setup-step-start'),
    setupStepOpen: document.getElementById('setup-step-open'),
    setupStepApprove: document.getElementById('setup-step-approve'),
    pairLinkForm: document.getElementById('pair-link-form'),
    pairLinkInput: document.getElementById('pair-link-input'),
    pairLinkButton: document.getElementById('pair-link-button'),
    showManualAuthButton: document.getElementById('show-manual-auth-button'),
    hideManualAuthButton: document.getElementById('hide-manual-auth-button'),
    authPanel: document.getElementById('auth-panel'),
    authForm: document.getElementById('auth-form'),
    authToken: document.getElementById('auth-token'),
    connectButton: document.getElementById('connect-button'),
    originChip: document.getElementById('origin-chip'),
    statusPill: document.getElementById('status-pill'),
    connectionLabel: document.getElementById('connection-label'),
    noticeBanner: document.getElementById('notice-banner'),
    noticeText: document.getElementById('notice-text'),
    installNote: document.getElementById('install-note'),
    remoteController: document.getElementById('remote-controller'),
    playbackState: document.getElementById('playback-state'),
    artworkImage: document.getElementById('artwork-image'),
    artworkPlaceholder: document.getElementById('artwork-placeholder'),
    trackTitle: document.getElementById('track-title'),
    trackArtist: document.getElementById('track-artist'),
    trackAlbum: document.getElementById('track-album'),
    elapsedTime: document.getElementById('elapsed-time'),
    remainingTime: document.getElementById('remaining-time'),
    seekInput: document.getElementById('seek-input'),
    previousButton: document.getElementById('previous-button'),
    playButton: document.getElementById('play-button'),
    nextButton: document.getElementById('next-button'),
    favoriteButton: document.getElementById('favorite-button'),
    reconnectButton: document.getElementById('reconnect-button'),
    forgetButton: document.getElementById('forget-button')
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
    isScrubbing: false,
    scrubValue: 0,
    manualAuthVisible: false,
    pairingState: 'idle',
    pairingMessage: 'Open Pair Remote in Astra on your desktop, then scan the QR code or paste the pairing link on this page.',
    pairingPollToken: '',
    pairingExpiresAt: 0
  }

  elements.originChip.textContent = window.location.origin
  elements.authToken.value = state.token
  elements.installNote.hidden = window.isSecureContext

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  function formatTime(totalSeconds) {
    const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0
    const hours = Math.floor(safeSeconds / 3600)
    const minutes = Math.floor((safeSeconds % 3600) / 60)
    const seconds = safeSeconds % 60

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }

    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }

  function setThemeAccent(color) {
    const nextColor = typeof color === 'string' && color.trim() ? color.trim() : '#38bdf8'
    document.documentElement.style.setProperty('--accent', nextColor)
  }

  function revokeArtwork() {
    if (state.artworkObjectUrl) {
      URL.revokeObjectURL(state.artworkObjectUrl)
      state.artworkObjectUrl = null
    }
  }

  function setArtwork(trackId, objectUrl) {
    revokeArtwork()
    state.artworkTrackId = trackId
    state.artworkObjectUrl = objectUrl
    render()
  }

  function clearArtwork(trackId) {
    revokeArtwork()
    state.artworkTrackId = trackId || null
    render()
  }

  function stopPolling() {
    if (state.pollTimer !== null) {
      window.clearInterval(state.pollTimer)
      state.pollTimer = null
    }
  }

  function stopPairingPolling() {
    if (state.pairPollTimer !== null) {
      window.clearInterval(state.pairPollTimer)
      state.pairPollTimer = null
    }
  }

  function stopEventStream() {
    if (state.eventAbortController) {
      state.eventAbortController.abort()
      state.eventAbortController = null
    }
  }

  function stopReconnectTimer() {
    if (state.reconnectTimer !== null) {
      window.clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
  }

  function stopRealtime() {
    stopEventStream()
    stopPolling()
    stopReconnectTimer()
  }

  function setPairingState(nextState, message, expiresAt) {
    state.pairingState = nextState
    state.pairingMessage = message
    state.pairingExpiresAt = typeof expiresAt === 'number' ? expiresAt : 0
    render()
  }

  function detectClientLabel() {
    const userAgent = navigator.userAgent || ''
    if (/iPhone/i.test(userAgent)) return 'iPhone'
    if (/iPad/i.test(userAgent)) return 'iPad'
    if (/Android/i.test(userAgent)) return 'Android Phone'
    if (/Macintosh|Mac OS X/i.test(userAgent)) return 'Mac Browser'
    if (/Windows/i.test(userAgent)) return 'Windows Browser'
    return 'Remote Controller'
  }

  function deriveDeviceName() {
    const clientLabel = detectClientLabel()
    return clientLabel === 'Remote Controller' ? 'Astra Remote' : `${clientLabel} Remote`
  }

  function clearPairingHash() {
    if (!window.location.hash) return
    window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`)
  }

  function extractPairingTicket(value) {
    const trimmedValue = typeof value === 'string' ? value.trim() : ''
    if (!trimmedValue) return ''

    const directHashParams = new URLSearchParams(trimmedValue.replace(/^#/, ''))
    const directHashTicket = (directHashParams.get('pair') || '').trim()
    if (directHashTicket) return directHashTicket

    try {
      const parsedUrl = new URL(trimmedValue, window.location.origin)
      const hashParams = new URLSearchParams(parsedUrl.hash.replace(/^#/, ''))
      const hashTicket = (hashParams.get('pair') || '').trim()
      if (hashTicket) return hashTicket

      const searchTicket = (parsedUrl.searchParams.get('pair') || '').trim()
      if (searchTicket) return searchTicket
    } catch {
      // Ignore invalid URLs and fall back to raw ticket parsing.
    }

    return /^[A-Za-z0-9_-]{16,}$/.test(trimmedValue) ? trimmedValue : ''
  }

  function prepareForPairingClaim() {
    stopRealtime()
    stopPairingPolling()
    state.snapshot = null
    state.token = ''
    state.manualAuthVisible = false
    state.connectionState = 'idle'
    state.connectionMessage = 'Waiting for Astra to approve this phone.'
    elements.authToken.value = ''
    elements.pairLinkInput.value = ''
    clearArtwork(null)
    render()
  }

  function setNotice(message, tone, timeoutMs) {
    if (state.noticeTimer !== null) {
      window.clearTimeout(state.noticeTimer)
      state.noticeTimer = null
    }

    state.noticeMessage = message
    state.noticeTone = tone || 'info'
    renderNotice()

    if (timeoutMs > 0) {
      state.noticeTimer = window.setTimeout(() => {
        state.noticeTimer = null
        state.noticeMessage = ''
        renderNotice()
      }, timeoutMs)
    }
  }

  function clearNotice() {
    if (state.noticeTimer !== null) {
      window.clearTimeout(state.noticeTimer)
      state.noticeTimer = null
    }
    state.noticeMessage = ''
    renderNotice()
  }

  function renderNotice() {
    if (!state.noticeMessage) {
      elements.noticeBanner.hidden = true
      return
    }

    elements.noticeBanner.hidden = false
    elements.noticeBanner.className = `panel notice-banner notice-${state.noticeTone}`
    elements.noticeText.textContent = state.noticeMessage
  }

  function renderStatus() {
    const statusLabels = {
      idle: 'Idle',
      connecting: 'Connecting',
      connected: 'Live',
      reconnecting: 'Retrying',
      error: 'Offline'
    }

    const statusClasses = {
      idle: 'status-idle',
      connecting: 'status-connecting',
      connected: 'status-live',
      reconnecting: 'status-connecting',
      error: 'status-error'
    }

    elements.statusPill.textContent = statusLabels[state.connectionState] || 'Idle'
    elements.statusPill.className = `status-pill ${statusClasses[state.connectionState] || 'status-idle'}`
    elements.connectionLabel.textContent = state.connectionMessage
    elements.connectButton.disabled = state.connectionState === 'connecting'
  }

  function render() {
    const snapshot = state.snapshot
    const track = snapshot && snapshot.currentTrack ? snapshot.currentTrack : null
    const inlineArtworkDataUrl = track && typeof track.artworkDataUrl === 'string' ? track.artworkDataUrl : null
    const hasTrack = Boolean(track)
    const safeDuration = snapshot ? Math.max(0, snapshot.duration || 0) : 0
    const safeCurrentTime = snapshot ? Math.max(0, snapshot.currentTime || 0) : 0
    const displayTime = state.isScrubbing ? state.scrubValue : safeCurrentTime
    const clampedDisplayTime = clamp(displayTime, 0, safeDuration)
    const playLabel = snapshot && snapshot.playbackState === 'playing'
      ? 'Pause'
      : snapshot && snapshot.playbackState === 'loading'
        ? 'Wait'
        : 'Play'
    const showSetup = !state.token
    const pairingCountdownMs = state.pairingExpiresAt > 0 ? Math.max(0, state.pairingExpiresAt - Date.now()) : 0
    const pairingStateLabels = {
      idle: 'Waiting for a pairing link',
      claiming: 'Claiming pairing link',
      pending: pairingCountdownMs > 0
        ? `Awaiting approval • ${formatTime(pairingCountdownMs / 1000)}`
        : 'Awaiting approval',
      rejected: 'Pairing rejected',
      expired: 'Pairing expired',
      error: 'Pairing failed'
    }

    document.body.dataset.auth = showSetup ? 'true' : 'false'
    elements.pairPanel.hidden = !showSetup || state.manualAuthVisible
    elements.authPanel.hidden = !showSetup || !state.manualAuthVisible
    elements.remoteController.hidden = showSetup
    elements.authToken.disabled = state.connectionState === 'connecting'
    elements.pairLinkInput.disabled = state.pairingState === 'claiming' || state.pairingState === 'pending'
    elements.pairLinkButton.disabled = state.pairingState === 'claiming' || state.pairingState === 'pending'
    elements.reconnectButton.disabled = !state.token || state.connectionState === 'connecting'
    elements.forgetButton.disabled = !state.token
    elements.reconnectButton.hidden = showSetup
    elements.forgetButton.hidden = showSetup
    elements.installNote.hidden = window.isSecureContext || !showSetup

    const hasPairingInProgress = state.pairingState === 'claiming' || state.pairingState === 'pending'
    const stepStates = {
      start: hasPairingInProgress ? 'complete' : 'active',
      open: state.pairingState === 'pending'
        ? 'complete'
        : state.pairingState === 'claiming'
          ? 'active'
          : 'idle',
      approve: state.pairingState === 'pending' ? 'active' : 'idle'
    }
    elements.setupStepStart.dataset.state = stepStates.start
    elements.setupStepOpen.dataset.state = stepStates.open
    elements.setupStepApprove.dataset.state = stepStates.approve

    setThemeAccent(snapshot && snapshot.visualizerLineColor)
    renderStatus()
    renderNotice()

    elements.pairCopy.textContent = state.pairingMessage
    elements.pairStatusChip.textContent = pairingStateLabels[state.pairingState] || 'Waiting for a pairing link'
    elements.showManualAuthButton.disabled = state.pairingState === 'claiming' || state.pairingState === 'pending'
    elements.hideManualAuthButton.disabled = state.connectionState === 'connecting'

    elements.playbackState.textContent = snapshot
      ? snapshot.playbackState.charAt(0).toUpperCase() + snapshot.playbackState.slice(1)
      : 'Stopped'
    elements.trackTitle.textContent = track ? track.title : 'Nothing playing'
    elements.trackArtist.textContent = track ? track.artist : 'Connect to Astra to load the live transport.'
    elements.trackAlbum.textContent = track ? track.album : 'Ready for phone control'
    elements.playButton.textContent = playLabel
    elements.favoriteButton.textContent = track && track.isFavorite ? 'Saved' : 'Fav'

    elements.elapsedTime.textContent = formatTime(clampedDisplayTime)
    elements.remainingTime.textContent = `-${formatTime(Math.max(0, safeDuration - clampedDisplayTime))}`
    elements.seekInput.disabled = !track || safeDuration <= 0
    elements.seekInput.max = safeDuration > 0 ? String(safeDuration) : '1'
    elements.seekInput.value = safeDuration > 0 ? String(clampedDisplayTime) : '0'

    const queueHasTracks = snapshot ? snapshot.queueLength > 0 : false
    elements.previousButton.disabled = !queueHasTracks
    elements.nextButton.disabled = !queueHasTracks
    elements.playButton.disabled = !track || (snapshot && snapshot.playbackState === 'loading')
    elements.favoriteButton.disabled = !track

    const artworkSource = inlineArtworkDataUrl || state.artworkObjectUrl
    if (artworkSource) {
      elements.artworkImage.src = artworkSource
      elements.artworkImage.hidden = false
      elements.artworkPlaceholder.hidden = true
    } else {
      elements.artworkImage.hidden = true
      elements.artworkPlaceholder.hidden = false
    }
  }

  function persistToken(token) {
    if (token) {
      localStorage.setItem(STORAGE_KEY, token)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
    state.token = token
    elements.authToken.value = token
  }

  function handleAuthorizationFailure() {
    stopRealtime()
    stopPairingPolling()
    persistToken('')
    state.manualAuthVisible = false
    state.connectionState = 'error'
    state.connectionMessage = 'API key rejected. Enter the current Local API key from Astra.'
    setNotice('Authentication failed. Copy the latest key from Astra.', 'error', 0)
    setPairingState('idle', 'Open Pair Remote in Astra on your desktop, then scan the QR code or paste the pairing link on this page.', 0)
    render()
    elements.authToken.focus()
  }

  async function authorizedFetch(path, options) {
    if (!state.token) {
      throw new Error('Missing token.')
    }

    const init = options || {}
    const headers = new Headers(init.headers || {})
    headers.set('Authorization', `Bearer ${state.token}`)
    return fetch(path, {
      ...init,
      headers,
      cache: 'no-store'
    })
  }

  async function syncArtwork(snapshot) {
    const track = snapshot && snapshot.currentTrack ? snapshot.currentTrack : null
    const trackId = track ? track.id : null

    if (!trackId) {
      clearArtwork(null)
      return
    }

    if (track.artworkDataUrl) {
      clearArtwork(trackId)
      return
    }

    if (trackId === state.artworkTrackId && state.artworkObjectUrl) {
      return
    }

    clearArtwork(trackId)

    if (!track.artworkUrl) {
      return
    }

    const requestId = ++state.artworkRequestId

    try {
      const response = await authorizedFetch(`/v1/artwork/current?trackId=${encodeURIComponent(trackId)}`, {
        headers: { Accept: 'image/*' }
      })

      if (response.status === 401) {
        handleAuthorizationFailure()
        return
      }

      if (response.status === 404) {
        if (requestId === state.artworkRequestId) {
          clearArtwork(trackId)
        }
        return
      }

      if (!response.ok) {
        throw new Error(`Artwork request failed with ${response.status}.`)
      }

      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)

      if (requestId !== state.artworkRequestId || !state.snapshot || !state.snapshot.currentTrack || state.snapshot.currentTrack.id !== trackId) {
        URL.revokeObjectURL(objectUrl)
        return
      }

      setArtwork(trackId, objectUrl)
    } catch (error) {
      if (requestId === state.artworkRequestId) {
        clearArtwork(trackId)
      }
    }
  }

  function applySnapshot(snapshot) {
    state.snapshot = snapshot
    state.connectionState = 'connected'
    state.connectionMessage = 'Live connection active.'
    clearNotice()
    void syncArtwork(snapshot)
    render()
  }

  async function fetchSnapshot(background) {
    try {
      const response = await authorizedFetch(background ? '/v1/now-playing' : '/v1/now-playing?inlineArtwork=1')

      if (response.status === 401) {
        handleAuthorizationFailure()
        return false
      }

      if (!response.ok) {
        throw new Error(`Astra returned ${response.status}.`)
      }

      const snapshot = await response.json()
      applySnapshot(snapshot)
      return true
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return false
      }

      if (!background) {
        state.connectionState = 'error'
        state.connectionMessage = 'Unable to reach Astra from this device.'
        setNotice('Make sure your phone opened the LAN controller URL from Astra.', 'error', 0)
        render()
      } else if (state.connectionState === 'connected') {
        state.connectionState = 'reconnecting'
        state.connectionMessage = 'Trying to reconnect to Astra.'
        renderStatus()
      }

      return false
    }
  }

  function startPolling() {
    if (state.pollTimer !== null) return

    state.pollTimer = window.setInterval(() => {
      if (!state.token || state.connectionState === 'connecting') return
      void fetchSnapshot(true)
    }, POLL_INTERVAL_MS)
  }

  function scheduleReconnect() {
    if (state.reconnectTimer !== null || !state.token) return

    state.connectionState = 'reconnecting'
    state.connectionMessage = 'Trying to restore live updates.'
    renderStatus()
    startPolling()

    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null
      if (!state.token) return
      void connect()
    }, RECONNECT_DELAY_MS)
  }

  async function fetchPairingStatus() {
    if (!state.pairingPollToken) return

    try {
      const response = await fetch(`/v1/pairing/status?pollToken=${encodeURIComponent(state.pairingPollToken)}`, {
        cache: 'no-store'
      })
      const payload = await response.json().catch(() => ({}))

      if (response.status === 404) {
        stopPairingPolling()
        setPairingState('error', 'Astra no longer recognizes this pairing request. Start a fresh Pair Remote flow on the desktop.', 0)
        return
      }

      if (response.status === 410 || payload.state === 'consumed') {
        stopPairingPolling()
        if (!state.token) {
          setPairingState('error', 'This pairing link was already used. Start a fresh Pair Remote flow on the desktop.', 0)
        }
        return
      }

      if (!response.ok) {
        throw new Error(`Pairing status failed with ${response.status}.`)
      }

      if (payload.state === 'approved' && typeof payload.token === 'string' && payload.token.trim()) {
        stopPairingPolling()
        persistToken(payload.token.trim())
        state.manualAuthVisible = false
        state.pairingPollToken = ''
        clearPairingHash()
        setPairingState('idle', 'This phone is paired. Astra will reconnect with its dedicated device token.', 0)
        setNotice('Phone paired. Astra Remote is now connected with its own device token.', 'info', NOTICE_TIMEOUT_MS)
        void connect()
        return
      }

      if (payload.state === 'rejected') {
        stopPairingPolling()
        state.pairingPollToken = ''
        setPairingState('rejected', 'Astra rejected this phone. Start a fresh Pair Remote flow on the desktop if you want to try again.', payload.expiresAt || 0)
        return
      }

      if (payload.state === 'expired') {
        stopPairingPolling()
        state.pairingPollToken = ''
        setPairingState('expired', 'This pairing request expired. Start Pair Remote again on the desktop.', payload.expiresAt || 0)
        return
      }

      setPairingState('pending', 'Pairing request sent. Approve this phone in Astra to finish setup.', payload.expiresAt || state.pairingExpiresAt)
    } catch (error) {
      stopPairingPolling()
      state.pairingPollToken = ''
      setPairingState('error', 'Could not finish pairing with Astra. Check the desktop app and try again.', 0)
    }
  }

  function startPairingPolling() {
    stopPairingPolling()
    state.pairPollTimer = window.setInterval(() => {
      void fetchPairingStatus()
    }, 1500)
  }

  async function claimPairingTicket(ticket) {
    stopPairingPolling()
    state.manualAuthVisible = false
    state.pairingPollToken = ''
    setPairingState('claiming', 'Link received. Asking Astra to start pairing for this phone.', 0)

    try {
      const response = await fetch('/v1/pairing/claim', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({
          ticket,
          deviceName: deriveDeviceName(),
          clientLabel: detectClientLabel()
        })
      })
      const payload = await response.json().catch(() => ({}))

      if (response.status === 404 || response.status === 410) {
        setPairingState('expired', 'This pairing link is no longer valid. Start Pair Remote again on the desktop.', 0)
        return false
      }

      if (!response.ok || typeof payload.pollToken !== 'string' || !payload.pollToken.trim()) {
        setPairingState('error', 'Astra could not start pairing for this phone. Start Pair Remote again on the desktop.', 0)
        return false
      }

      state.pairingPollToken = payload.pollToken.trim()
      clearPairingHash()
      setPairingState('pending', 'Pairing request sent. Approve this phone in Astra to finish setup.', payload.expiresAt || 0)
      startPairingPolling()
      void fetchPairingStatus()
      return true
    } catch (error) {
      setPairingState('error', 'Could not reach Astra for pairing. Reopen the LAN pairing link from Astra and try again.', 0)
      return false
    }
  }

  function beginPairingClaim(rawInput, notifyOnInvalid) {
    const trimmedInput = typeof rawInput === 'string' ? rawInput.trim() : ''
    if (!trimmedInput) return false

    const pairingTicket = extractPairingTicket(trimmedInput)
    if (!pairingTicket) {
      if (notifyOnInvalid !== false) {
        setNotice('Paste a full pairing link or raw pairing ticket from Astra.', 'error', NOTICE_TIMEOUT_MS)
        elements.pairLinkInput.focus()
      }
      return false
    }

    prepareForPairingClaim()
    void claimPairingTicket(pairingTicket)
    return true
  }

  function handleStreamPayload(payload) {
    try {
      const snapshot = JSON.parse(payload)
      applySnapshot(snapshot)
    } catch {
      setNotice('Astra sent an unreadable live update.', 'error', NOTICE_TIMEOUT_MS)
    }
  }

  function processSseChunk(bufferState, chunk) {
    bufferState.value += chunk.replace(/\r/g, '')

    let boundaryIndex = bufferState.value.indexOf('\n\n')
    while (boundaryIndex !== -1) {
      const rawEvent = bufferState.value.slice(0, boundaryIndex)
      bufferState.value = bufferState.value.slice(boundaryIndex + 2)

      let eventName = 'message'
      const dataLines = []

      for (const line of rawEvent.split('\n')) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
      }

      if (eventName === 'now-playing' && dataLines.length > 0) {
        handleStreamPayload(dataLines.join('\n'))
      }

      boundaryIndex = bufferState.value.indexOf('\n\n')
    }
  }

  async function startEventStream() {
    stopEventStream()

    const controller = new AbortController()
    state.eventAbortController = controller

    try {
      const response = await authorizedFetch('/v1/events', {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal
      })

      if (response.status === 401) {
        handleAuthorizationFailure()
        return
      }

      if (!response.ok || !response.body) {
        throw new Error(`Event stream failed with ${response.status}.`)
      }

      stopPolling()
      state.connectionState = 'connected'
      state.connectionMessage = 'Live connection active.'
      renderStatus()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const bufferState = { value: '' }

      while (true) {
        const result = await reader.read()
        if (result.done) break
        processSseChunk(bufferState, decoder.decode(result.value, { stream: true }))
      }

      processSseChunk(bufferState, decoder.decode())
      if (!controller.signal.aborted) {
        scheduleReconnect()
      }
    } catch (error) {
      if (controller.signal.aborted) return
      scheduleReconnect()
    }
  }

  async function connect() {
    if (!state.token) {
      render()
      return false
    }

    stopRealtime()
    state.connectionState = 'connecting'
    state.connectionMessage = 'Connecting to Astra.'
    render()

    const connected = await fetchSnapshot(false)
    if (!connected || !state.token) {
      return false
    }

    void startEventStream()
    return true
  }

  async function sendControl(body) {
    if (!state.token) return

    try {
      const response = await authorizedFetch('/v1/control', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(body)
      })

      if (response.status === 401) {
        handleAuthorizationFailure()
        return
      }

      if (response.status === 403) {
        setNotice('Remote is connected in read-only mode. Enable External Playback Controls in Astra.', 'error', 0)
        return
      }

      if (!response.ok) {
        throw new Error(`Control request failed with ${response.status}.`)
      }

      clearNotice()
    } catch (error) {
      setNotice('Could not send that command to Astra.', 'error', NOTICE_TIMEOUT_MS)
    }
  }

  elements.pairLinkForm.addEventListener('submit', (event) => {
    event.preventDefault()
    beginPairingClaim(elements.pairLinkInput.value)
  })

  elements.authForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const nextToken = elements.authToken.value.trim()
    if (!nextToken) {
      setNotice('Paste the Local API key from Astra before connecting.', 'error', NOTICE_TIMEOUT_MS)
      return
    }

    stopPairingPolling()
    state.pairingPollToken = ''
    persistToken(nextToken)
    state.connectionMessage = 'Connecting to Astra.'
    render()
    void connect()
  })

  elements.showManualAuthButton.addEventListener('click', () => {
    state.manualAuthVisible = true
    render()
    elements.authToken.focus()
  })

  elements.hideManualAuthButton.addEventListener('click', () => {
    state.manualAuthVisible = false
    render()
  })

  elements.reconnectButton.addEventListener('click', () => {
    void connect()
  })

  elements.forgetButton.addEventListener('click', () => {
    stopRealtime()
    stopPairingPolling()
    persistToken('')
    state.snapshot = null
    state.manualAuthVisible = false
    state.connectionState = 'idle'
    state.connectionMessage = 'Remote token cleared.'
    clearArtwork(null)
    setPairingState('idle', 'Open Pair Remote in Astra on your desktop, then scan the QR code or paste the pairing link on this page.', 0)
    setNotice('Saved remote credential removed from this phone.', 'info', NOTICE_TIMEOUT_MS)
    render()
  })

  elements.previousButton.addEventListener('click', () => {
    void sendControl({ command: 'previous' })
  })

  elements.playButton.addEventListener('click', () => {
    const snapshot = state.snapshot
    if (!snapshot) return
    const command = snapshot.playbackState === 'playing' ? 'pause' : 'play'
    void sendControl({ command })
  })

  elements.nextButton.addEventListener('click', () => {
    void sendControl({ command: 'next' })
  })

  elements.favoriteButton.addEventListener('click', () => {
    void sendControl({ command: 'toggle-favorite' })
  })

  elements.seekInput.addEventListener('pointerdown', () => {
    state.isScrubbing = true
  })

  elements.seekInput.addEventListener('input', () => {
    state.isScrubbing = true
    state.scrubValue = Number(elements.seekInput.value) || 0
    render()
  })

  elements.seekInput.addEventListener('change', () => {
    const nextTime = Number(elements.seekInput.value) || 0
    state.isScrubbing = false
    state.scrubValue = nextTime
    render()
    void sendControl({ command: 'seek', time: nextTime })
  })

  elements.seekInput.addEventListener('pointerup', () => {
    state.isScrubbing = false
  })

  elements.seekInput.addEventListener('pointercancel', () => {
    state.isScrubbing = false
  })

  window.addEventListener('beforeunload', () => {
    stopRealtime()
    stopPairingPolling()
    revokeArtwork()
  })

  window.addEventListener('hashchange', () => {
    beginPairingClaim(window.location.hash, false)
  })

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
        // Ignore service worker registration failures.
      })
    })
  }

  render()
  const pairingStarted = beginPairingClaim(window.location.hash, false)
  if (pairingStarted) {
    // Pairing flow is already running from the URL fragment.
  } else if (state.token) {
    void connect()
  } else {
    state.manualAuthVisible = false
    setPairingState('idle', 'Open Pair Remote in Astra on your desktop, then scan the QR code or paste the pairing link on this page.', 0)
    render()
  }
})()
