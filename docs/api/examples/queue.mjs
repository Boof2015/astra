const baseUrl = (process.env.ASTRA_API_URL ?? 'http://127.0.0.1:38401').replace(/\/$/, '')
const token = process.env.ASTRA_API_TOKEN
const query = process.argv.slice(2).join(' ').trim()

if (!token) throw new Error('Set ASTRA_API_TOKEN to the bearer token shown in Astra settings.')
if (!query) throw new Error('Usage: node queue.mjs <search query>')

const headers = { Authorization: `Bearer ${token}` }
const response = await fetch(
  `${baseUrl}/v2/search?q=${encodeURIComponent(query)}&types=track&limit=5`,
  { headers }
)
if (!response.ok) throw new Error(`Search failed: ${response.status} ${await response.text()}`)
const results = (await response.json()).results ?? []
if (results.length === 0) throw new Error(`No tracks matched ${JSON.stringify(query)}.`)

for (const [index, result] of results.entries()) {
  const enqueue = await fetch(`${baseUrl}/v2/intents`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'enqueue',
      targetRef: result.ref,
      position: index === 0 ? 'next' : 'end'
    })
  })
  if (!enqueue.ok) throw new Error(`Enqueue failed: ${enqueue.status} ${await enqueue.text()}`)
  console.log(`Queued ${result.title}`)
}
