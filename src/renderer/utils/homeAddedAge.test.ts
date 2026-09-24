import assert from 'node:assert/strict'
import test from 'node:test'
import { formatHomeAddedAge } from './homeAddedAge.ts'

test('addition labels distinguish today, yesterday, older additions, and missing dates', () => {
  const now = new Date(2026, 8, 24, 12).getTime()
  assert.equal(formatHomeAddedAge(new Date(2026, 8, 24, 1).getTime(), now), 'Added today')
  assert.equal(formatHomeAddedAge(new Date(2026, 8, 23, 23).getTime(), now), 'Added yesterday')
  assert.equal(formatHomeAddedAge(new Date(2026, 8, 22, 12).getTime(), now), 'Added 2 days ago')
  assert.equal(formatHomeAddedAge(new Date(2026, 6, 24, 12).getTime(), now), 'Added 2 months ago')
  assert.equal(formatHomeAddedAge(new Date(2024, 8, 24, 12).getTime(), now), 'Added 2 years ago')
  assert.equal(formatHomeAddedAge(now + 86_400_000, now), 'Added today')
  for (const invalid of [0, -1, NaN, Infinity, Number.MAX_VALUE]) {
    assert.equal(formatHomeAddedAge(invalid, now), 'New to your library')
  }
})

test('addition age follows local calendar days across midnight and daylight saving changes', () => {
  const previousTimezone = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    assert.equal(formatHomeAddedAge(new Date(2026, 8, 23, 23, 55).getTime(), new Date(2026, 8, 24, 0, 5).getTime()), 'Added yesterday')
    assert.equal(formatHomeAddedAge(new Date(2026, 2, 8, 0, 5).getTime(), new Date(2026, 2, 9, 0, 5).getTime()), 'Added yesterday')
    assert.equal(formatHomeAddedAge(new Date(2026, 10, 1, 0, 5).getTime(), new Date(2026, 10, 2, 23, 55).getTime()), 'Added yesterday')
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
  }
})
