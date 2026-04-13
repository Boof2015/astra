(function () {
  const STORAGE_KEY = 'astra-remote-api-token-v1'
  const POLL_INTERVAL_MS = 5000
  const RECONNECT_DELAY_MS = 2000
  const NOTICE_TIMEOUT_MS = 3600

  const elements = {
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
    connectionMessage: 'Waiting for a Local API key.',
    noticeMessage: '',
    noticeTone: 'info',
    noticeTimer: null,
    eventAbortController: null,
    reconnectTimer: null,
    pollTimer: null,
    artworkObjectUrl: null,
    artworkTrackId: null,
    artworkRequestId: 0,
    isScrubbing: false,
    scrubValue: 0
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

    document.body.dataset.auth = state.token ? 'false' : 'true'
    elements.authPanel.hidden = Boolean(state.token)
    elements.authToken.disabled = state.connectionState === 'connecting'
    elements.reconnectButton.disabled = !state.token || state.connectionState === 'connecting'
    elements.forgetButton.disabled = !state.token

    setThemeAccent(snapshot && snapshot.visualizerLineColor)
    renderStatus()
    renderNotice()

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
    persistToken('')
    state.connectionState = 'error'
    state.connectionMessage = 'API key rejected. Enter the current Local API key from Astra.'
    setNotice('Authentication failed. Copy the latest key from Astra.', 'error', 0)
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

  elements.authForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const nextToken = elements.authToken.value.trim()
    if (!nextToken) {
      setNotice('Paste the Local API key from Astra before connecting.', 'error', NOTICE_TIMEOUT_MS)
      return
    }

    persistToken(nextToken)
    state.connectionMessage = 'Connecting to Astra.'
    render()
    void connect()
  })

  elements.reconnectButton.addEventListener('click', () => {
    void connect()
  })

  elements.forgetButton.addEventListener('click', () => {
    stopRealtime()
    persistToken('')
    state.snapshot = null
    state.connectionState = 'idle'
    state.connectionMessage = 'API key cleared.'
    clearArtwork(null)
    setNotice('Saved API key removed from this phone.', 'info', NOTICE_TIMEOUT_MS)
    render()
    elements.authToken.focus()
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
    revokeArtwork()
  })

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
        // Ignore service worker registration failures.
      })
    })
  }

  render()
  if (state.token) {
    void connect()
  } else {
    elements.authToken.focus()
  }
})()
