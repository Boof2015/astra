const baseUrl = (process.env.ASTRA_API_URL ?? 'http://127.0.0.1:38401').replace(/\/$/, '')
const token = process.env.ASTRA_API_TOKEN

if (!token) {
  throw new Error('Set ASTRA_API_TOKEN to the bearer token shown in Astra settings.')
}

const response = await fetch(
  `${baseUrl}/v2/events?topics=playback,queue&positionIntervalMs=1000`,
  { headers: { Authorization: `Bearer ${token}` } }
)

if (!response.ok || !response.body) {
  throw new Error(`Event stream failed: ${response.status} ${await response.text()}`)
}

const decoder = new TextDecoder()
let buffered = ''
for await (const chunk of response.body) {
  buffered += decoder.decode(chunk, { stream: true })
  const frames = buffered.split('\n\n')
  buffered = frames.pop() ?? ''
  for (const frame of frames) {
    if (!frame || frame.startsWith(':')) continue
    const event = frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7)
    const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    if (event && data) console.log(event, JSON.parse(data))
  }
}
