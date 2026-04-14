const CACHE_NAME = 'astra-remote-shell-v4'
const SHELL_ASSETS = [
  '/remote/',
  '/remote/app.js',
  '/remote/icon-192.png',
  '/remote/icon-512.png',
  '/remote/icon.svg',
  '/remote/manifest.webmanifest',
  '/remote/styles.css'
]

const NETWORK_FIRST_PATHS = new Set(SHELL_ASSETS)

function normalizeCacheKey(pathname) {
  return pathname === '/remote' ? '/remote/' : pathname
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (response.ok) {
      await cache.put(cacheKey, response.clone())
    }
    return response
  } catch (error) {
    const cachedResponse = await cache.match(cacheKey)
    if (cachedResponse) return cachedResponse
    throw error
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  const cachedResponse = await cache.match(request)
  if (cachedResponse) return cachedResponse

  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())
  }
  return response
}

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
  if (url.pathname.startsWith('/v1/')) return
  if (url.pathname !== '/remote' && !url.pathname.startsWith('/remote/')) return

  const cacheKey = normalizeCacheKey(url.pathname)
  if (event.request.mode === 'navigate' || NETWORK_FIRST_PATHS.has(cacheKey)) {
    event.respondWith(networkFirst(event.request, cacheKey))
    return
  }

  event.respondWith(cacheFirst(event.request))
})
