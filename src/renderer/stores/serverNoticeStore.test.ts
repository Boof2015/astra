import assert from 'node:assert/strict'
import test from 'node:test'
import { planOutageNotices, useServerNoticeStore } from './serverNoticeStore.ts'

test('notices queue one at a time; the same news about a server updates the queued one', () => {
  const store = useServerNoticeStore
  store.setState({ queue: [] })
  store.getState().push({ kind: 'review', serverKey: 'subsonic:1', count: 2 })
  store.getState().push({ kind: 'problem', serverKey: 'plex:3' })
  store.getState().push({ kind: 'review', serverKey: 'subsonic:1', count: 5 })
  store.getState().push({ kind: 'error', message: 'Could not save the rating.' })
  store.getState().push({ kind: 'error', message: 'Could not save the rating.' })
  const queue = store.getState().queue
  assert.deepEqual(queue.map(item => [item.kind, item.serverKey ?? item.message]),
    [['review', 'subsonic:1'], ['problem', 'plex:3'], ['error', 'Could not save the rating.']])
  assert.equal(queue[0].count, 5, 'the waiting review shows the newest count')
  store.getState().clear('review', 'subsonic:1')
  assert.equal(store.getState().queue[0].kind, 'problem')
  store.getState().dismiss(store.getState().queue[0].id)
  assert.deepEqual(store.getState().queue.map(item => item.kind), ['error'])
})

test('one outage notice per outage, none for a failure seen during the user’s own sync', () => {
  const memory = { notified: new Set<string>(), known: new Set<string>() }
  const none = () => false
  const failed = [{ key: 'subsonic:1', state: 'failed', error: 'Unable to reach the server.' }]
  assert.deepEqual(planOutageNotices(failed, memory, none).push.map(item => [item.key, item.error]), [['subsonic:1', 'Unable to reach the server.']])
  assert.deepEqual(planOutageNotices(failed, memory, none).push, [], 'still the same outage')
  assert.deepEqual(planOutageNotices([{ key: 'subsonic:1', state: 'syncing', error: null }], memory, none).push, [], 'a retry in progress')
  assert.deepEqual(planOutageNotices(failed, memory, none).push, [], 'failing again after the retry: same outage')
  assert.deepEqual(planOutageNotices([{ key: 'subsonic:1', state: 'connected', error: null }], memory, none).clear, ['subsonic:1'])
  assert.equal(planOutageNotices(failed, memory, none).push.length, 1, 'a new outage after recovery')

  const quiet = { notified: new Set<string>(), known: new Set<string>() }
  assert.deepEqual(planOutageNotices([{ key: 'plex:3', state: 'failed', error: null }], quiet, key => key === 'plex:3').push, [],
    'the user saw it fail on the row')
  assert.deepEqual(planOutageNotices([{ key: 'plex:3', state: 'failed', error: null }], quiet, () => false).push, [],
    'and a background retry later in the same outage stays quiet')
  assert.deepEqual(planOutageNotices([{ key: 'plex:3', state: 'off', error: null }], quiet, () => false).clear, ['plex:3'], 'turning it off ends the outage')
})

test('a removed server loses its waiting cues, even one queued behind another; servers never seen are not "removed"', () => {
  const store = useServerNoticeStore
  store.setState({ queue: [] })
  const memory = { notified: new Set<string>(), known: new Set<string>() }
  const none = () => false
  // Before the server list loads, nothing has been seen, so nothing is removed.
  assert.deepEqual(planOutageNotices([], memory, none).removed, [])
  const both = [{ key: 'subsonic:1', state: 'connected', error: null }, { key: 'jellyfin:2', state: 'failed', error: 'Down.' }]
  store.getState().push({ kind: 'ready', serverKey: 'subsonic:1' })
  for (const item of planOutageNotices(both, memory, none).push) store.getState().push({ kind: 'problem', serverKey: item.key, message: item.error ?? undefined })
  assert.deepEqual(store.getState().queue.map(item => item.serverKey), ['subsonic:1', 'jellyfin:2'])
  const plan = planOutageNotices([both[0]], memory, none)
  assert.deepEqual(plan.removed, ['jellyfin:2'])
  for (const key of plan.removed) store.getState().clearServer(key)
  assert.deepEqual(store.getState().queue.map(item => item.serverKey), ['subsonic:1'], 'only the remaining server’s cue is left')
  // Added again later, a new outage notifies again.
  assert.equal(planOutageNotices(both, memory, none).push.length, 1)
})

test('a queued cue updates in place; a dismissed one is not recreated', () => {
  const store = useServerNoticeStore
  store.setState({ queue: [] })
  store.getState().push({ kind: 'review', serverKey: 'plex:3', count: 5 })
  store.getState().updateQueued('review', 'plex:3', { count: 2 })
  assert.equal(store.getState().queue[0].count, 2)
  store.getState().dismiss(store.getState().queue[0].id)
  store.getState().updateQueued('review', 'plex:3', { count: 1 })
  assert.deepEqual(store.getState().queue, [])
})

test('a waiting problem cue keeps up when the problem changes within an outage', () => {
  const memory = { notified: new Set<string>(), known: new Set<string>() }
  const offline = [{ key: 'plex:3', state: 'failed', error: 'Could not reach Plex.', problem: 'offline' as const }]
  const signedOut = [{ key: 'plex:3', state: 'failed', error: 'Sign in to Plex again.', problem: 'signed-out' as const }]
  assert.equal(planOutageNotices(offline, memory, () => false).push.length, 1)
  const plan = planOutageNotices(signedOut, memory, () => false)
  assert.deepEqual(plan.push, [], 'still one outage')
  assert.deepEqual(plan.update.map(item => item.problem), ['signed-out'])
})

test('removing one library of a server, or the whole server, removes that library’s own cues', () => {
  const memory = { notified: new Set<string>(), known: new Set<string>() }
  const plex = (memberKeys: string[]) => ({ key: memberKeys[0], state: 'connected', error: null, memberKeys })
  planOutageNotices([plex(['plex:3', 'plex:4'])], memory, () => false)
  assert.deepEqual(planOutageNotices([plex(['plex:3'])], memory, () => false).removed, ['plex:4'], 'its second library was removed')
  assert.deepEqual(planOutageNotices([], memory, () => false).removed, ['plex:3'], 'then the server')
})
