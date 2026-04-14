(function () {
  const STORAGE_KEY = 'astra-remote-api-token-v1'
  const POLL_INTERVAL_MS = 5000
  const RECONNECT_DELAY_MS = 2000
  const NOTICE_TIMEOUT_MS = 3600
  const ARTWORK_RETRY_DELAY_MS = 800
  const ARTWORK_MAX_RETRIES = 4

  const $ = (id) => document.getElementById(id)

  const elements = {
    pairIdle: $('pair-idle'),
    pairPending: $('pair-pending'),
    pairPendingCopy: $('pair-pending-copy'),
    pairPendingTimer: $('pair-pending-timer'),
    pairError: $('pair-error'),
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
    artworkImage: $('artwork-image'),
    artworkPlaceholder: $('artwork-placeholder'),
    trackTitle: $('track-title'),
    trackArtist: $('track-artist'),
    trackAlbum: $('track-album'),
    elapsedTime: $('elapsed-time'),
    remainingTime: $('remaining-time'),
    seekTrack: $('seek-track'),
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
    manualAuthVisible: false,
    pairingState: 'idle',
    pairingMessage: '',
    pairingPollToken: '',
    pairingExpiresAt: 0
  }

  elements.originChip.textContent = window.location.origin
  elements.authToken.value = state.token


  // ── Helpers ──

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

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

  function setThemeAccent(color) {
    const c = typeof color === 'string' && color.trim() ? color.trim() : '#38bdf8'
    document.documentElement.style.setProperty('--accent', c)
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
  function stopPairingPolling() { if (state.pairPollTimer !== null) { clearInterval(state.pairPollTimer); state.pairPollTimer = null } }
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
    if (s === 'rejected' || s === 'expired' || s === 'error') return 'error'
    return 'idle'
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
    stopPairingPolling()
    state.snapshot = null
    state.token = ''
    state.manualAuthVisible = false
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
    const labels = { idle: 'Idle', connecting: '...', connected: 'Live', reconnecting: '...', error: 'Offline' }
    const classes = { idle: 'status-idle', connecting: 'status-connecting', connected: 'status-live', reconnecting: 'status-connecting', error: 'status-error' }
    elements.statusPill.textContent = labels[state.connectionState] || 'Idle'
    elements.statusPill.className = `status-pill ${classes[state.connectionState] || 'status-idle'}`
    elements.connectionLabel.textContent = state.connectionMessage
    elements.connectButton.disabled = state.connectionState === 'connecting'
  }

  function renderPage() {
    const hasToken = Boolean(state.token)
    const page = hasToken ? 'player' : 'setup'
    const phase = getPairPhase()

    document.body.dataset.page = page
    document.body.dataset.pairPhase = phase
    document.body.dataset.manualAuth = state.manualAuthVisible ? 'true' : 'false'

    // Header buttons
    elements.reconnectButton.hidden = !hasToken
    elements.forgetButton.hidden = !hasToken
    elements.reconnectButton.disabled = !hasToken || state.connectionState === 'connecting'
    elements.forgetButton.disabled = !hasToken

    // Connection label — hide during pending (the spinner screen says it all) and when connected
    elements.connectionLabel.hidden = (phase === 'pending') || hasToken

    // Pair idle form state
    elements.pairLinkInput.disabled = phase === 'pending'
    elements.pairLinkButton.disabled = phase === 'pending'
    elements.showManualAuthButton.disabled = phase === 'pending'

    // Pair pending content
    if (phase === 'pending') {
      const countdown = state.pairingExpiresAt > 0 ? Math.max(0, state.pairingExpiresAt - Date.now()) : 0
      elements.pairPendingTimer.textContent = countdown > 0 ? formatTime(countdown / 1000) : ''
    }

    // Pair error content
    if (phase === 'error') {
      const errorLabels = { rejected: 'Request rejected', expired: 'Link expired', error: 'Pairing failed' }
      elements.pairErrorCopy.textContent = state.pairingMessage || 'Something went wrong. Try again from the desktop.'
      const errSection = elements.pairError.querySelector('.section-label')
      if (errSection) errSection.textContent = errorLabels[state.pairingState] || 'Pairing failed'
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
    const display = state.isScrubbing ? state.scrubValue : current
    const clamped = clamp(display, 0, duration)

    // Metadata
    elements.trackTitle.textContent = track ? track.title : 'Nothing playing'
    elements.trackArtist.textContent = track ? track.artist : ''
    elements.trackAlbum.textContent = track ? track.album : ''

    // Play/pause icons
    const playing = snapshot && snapshot.playbackState === 'playing'
    const loading = snapshot && snapshot.playbackState === 'loading'
    elements.iconPlay.style.display = (playing || loading) ? 'none' : 'block'
    elements.iconPause.style.display = playing ? 'block' : 'none'
    elements.iconLoading.style.display = loading ? 'block' : 'none'

    // Favorite
    elements.favoriteButton.classList.toggle('is-active', Boolean(track && track.isFavorite))

    // Time
    elements.elapsedTime.textContent = formatTime(clamped)
    elements.remainingTime.textContent = `-${formatTime(Math.max(0, duration - clamped))}`

    // Seek
    const pct = duration > 0 ? ((clamped / duration) * 100) + '%' : '0%'
    elements.seekFill.style.width = pct
    elements.seekThumb.style.left = pct
    elements.seekTrack.classList.toggle('disabled', !track || duration <= 0)
    elements.seekTrack.classList.toggle('is-scrubbing', state.isScrubbing)

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
    stopPairingPolling()
    persistToken('')
    state.manualAuthVisible = false
    state.connectionState = 'error'
    state.connectionMessage = 'API key rejected.'
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
        renderStatus()
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
    renderStatus()
    startPolling()
    state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; if (state.token) void connect() }, RECONNECT_DELAY_MS)
  }

  // ── Pairing ──

  async function fetchPairingStatus() {
    if (!state.pairingPollToken) return
    try {
      const resp = await fetch(`/v1/pairing/status?pollToken=${encodeURIComponent(state.pairingPollToken)}`, { cache: 'no-store' })
      const p = await resp.json().catch(() => ({}))
      if (resp.status === 404) { stopPairingPolling(); setPairingState('error', 'Astra no longer recognizes this request. Start a new pairing flow.', 0); return }
      if (resp.status === 410 || p.state === 'consumed') { stopPairingPolling(); if (!state.token) setPairingState('error', 'This link was already used. Start a new pairing flow.', 0); return }
      if (!resp.ok) throw new Error(`${resp.status}`)
      if (p.state === 'approved' && typeof p.token === 'string' && p.token.trim()) {
        stopPairingPolling()
        persistToken(p.token.trim())
        state.manualAuthVisible = false
        state.pairingPollToken = ''
        clearPairingHash()
        setPairingState('idle', '', 0)
        setNotice('Paired successfully.', 'info', NOTICE_TIMEOUT_MS)
        void connect()
        return
      }
      if (p.state === 'rejected') { stopPairingPolling(); state.pairingPollToken = ''; setPairingState('rejected', 'Astra rejected this phone. Try again from the desktop.', p.expiresAt || 0); return }
      if (p.state === 'expired') { stopPairingPolling(); state.pairingPollToken = ''; setPairingState('expired', 'This request expired. Start Pair Remote again.', p.expiresAt || 0); return }
      setPairingState('pending', 'Approve this phone in Astra.', p.expiresAt || state.pairingExpiresAt)
    } catch { stopPairingPolling(); state.pairingPollToken = ''; setPairingState('error', 'Lost connection to Astra. Check the desktop app.', 0) }
  }

  function startPairingPolling() {
    stopPairingPolling()
    state.pairPollTimer = setInterval(() => void fetchPairingStatus(), 1500)
  }

  async function claimPairingTicket(ticket) {
    stopPairingPolling()
    state.manualAuthVisible = false
    state.pairingPollToken = ''
    setPairingState('claiming', 'Connecting...', 0)
    try {
      const resp = await fetch('/v1/pairing/claim', {
        method: 'POST', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ ticket, deviceName: deriveDeviceName(), clientLabel: detectClientLabel() })
      })
      const p = await resp.json().catch(() => ({}))
      if (resp.status === 404 || resp.status === 410) { setPairingState('expired', 'This link is no longer valid. Start Pair Remote again.', 0); return false }
      if (!resp.ok || typeof p.pollToken !== 'string' || !p.pollToken.trim()) { setPairingState('error', 'Astra could not start pairing. Try again.', 0); return false }
      state.pairingPollToken = p.pollToken.trim()
      clearPairingHash()
      setPairingState('pending', 'Approve this phone in Astra to finish.', p.expiresAt || 0)
      startPairingPolling()
      void fetchPairingStatus()
      return true
    } catch { setPairingState('error', 'Could not reach Astra. Check your network.', 0); return false }
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
    void claimPairingTicket(ticket)
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
      renderStatus()
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

  // ── Event listeners ──

  elements.pairLinkForm.addEventListener('submit', (e) => { e.preventDefault(); beginPairingClaim(elements.pairLinkInput.value) })

  elements.authForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const t = elements.authToken.value.trim()
    if (!t) { setNotice('Paste the API key first.', 'error', NOTICE_TIMEOUT_MS); return }
    stopPairingPolling()
    state.pairingPollToken = ''
    persistToken(t)
    state.connectionMessage = 'Connecting...'
    renderPage()
    void connect()
  })

  elements.showManualAuthButton.addEventListener('click', () => { state.manualAuthVisible = true; renderPage(); elements.authToken.focus() })
  elements.hideManualAuthButton.addEventListener('click', () => { state.manualAuthVisible = false; renderPage() })

  elements.pairRetryButton.addEventListener('click', () => {
    state.pairingPollToken = ''
    setPairingState('idle', '', 0)
  })

  elements.reconnectButton.addEventListener('click', () => void connect())

  elements.forgetButton.addEventListener('click', () => {
    stopRealtime()
    stopPairingPolling()
    persistToken('')
    state.snapshot = null
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
  function getSeekRatio(e) {
    const r = elements.seekTrack.getBoundingClientRect()
    return r.width > 0 ? clamp((e.clientX - r.left) / r.width, 0, 1) : 0
  }

  elements.seekTrack.addEventListener('pointerdown', (e) => {
    if (!state.snapshot || !state.snapshot.currentTrack) return
    const d = Math.max(0, state.snapshot.duration || 0)
    if (d <= 0) return
    e.preventDefault()
    elements.seekTrack.setPointerCapture(e.pointerId)
    state.isScrubbing = true
    state.scrubValue = getSeekRatio(e) * d
    haptic(4)
    renderPlayer()
  })

  elements.seekTrack.addEventListener('pointermove', (e) => {
    if (!state.isScrubbing) return
    const d = Math.max(0, (state.snapshot && state.snapshot.duration) || 0)
    state.scrubValue = getSeekRatio(e) * d
    renderPlayer()
  })

  elements.seekTrack.addEventListener('pointerup', () => {
    if (!state.isScrubbing) return
    state.isScrubbing = false
    renderPlayer()
    void sendControl({ command: 'seek', time: state.scrubValue })
  })

  elements.seekTrack.addEventListener('pointercancel', () => { if (state.isScrubbing) { state.isScrubbing = false; renderPlayer() } })

  // Lifecycle
  window.addEventListener('beforeunload', () => { stopRealtime(); stopPairingPolling(); revokeArtwork() })
  window.addEventListener('hashchange', () => beginPairingClaim(window.location.hash, false))

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {})
    })
  }

  // ── Init ──

  renderPage()
  const started = beginPairingClaim(window.location.hash, false)
  if (started) { /* pairing in progress */ }
  else if (state.token) void connect()
  else { state.manualAuthVisible = false; setPairingState('idle', '', 0); renderPage() }
})()
