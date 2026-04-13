const CACHE_NAME = 'astra-remote-shell-v1'
const SHELL_ASSETS = [
  '/remote/',
  '/remote/app.js',
  '/remote/icon-192.png',
  '/remote/icon-512.png',
  '/remote/icon.svg',
  '/remote/manifest.webmanifest',
  '/remote/styles.css'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith('/remote/')) return
  if (url.pathname.startsWith('/v1/')) return

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put('/remote/', copy))
          return response
        })
        .catch(() => caches.match('/remote/'))
    )
    return
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse

      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))
        }
        return response
      })
    })
  )
})
