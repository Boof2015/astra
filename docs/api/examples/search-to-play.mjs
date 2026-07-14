const baseUrl = (process.env.ASTRA_API_URL ?? 'http://127.0.0.1:38401').replace(/\/$/, '')
const token = process.env.ASTRA_API_TOKEN
const query = process.argv.slice(2).join(' ').trim()

if (!token) throw new Error('Set ASTRA_API_TOKEN to the bearer token shown in Astra settings.')
if (!query) throw new Error('Usage: node search-to-play.mjs <search query>')

const headers = { Authorization: `Bearer ${token}` }
const search = await fetch(
  `${baseUrl}/v2/search?q=${encodeURIComponent(query)}&types=track&limit=1`,
  { headers }
)
if (!search.ok) throw new Error(`Search failed: ${search.status} ${await search.text()}`)

const result = (await search.json()).results?.[0]
if (!result) throw new Error(`No track matched ${JSON.stringify(query)}.`)

const play = await fetch(`${baseUrl}/v2/intents`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'play', targetRef: result.ref })
})
if (!play.ok) throw new Error(`Play failed: ${play.status} ${await play.text()}`)

console.log(`Accepted: ${result.title}${result.subtitle ? ` — ${result.subtitle}` : ''}`)
