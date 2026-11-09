import { register } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Stub the SDK/react imports, then load the real desktop plugin as ESM.
await register(new URL('./_plugin_stubs.mjs', import.meta.url).href)
const plugin = await import('../desktop/plugin.js')
const NOW = 1_000_000_000

test('linkTarget returns http(s) URLs unchanged', () => {
  assert.equal(plugin.linkTarget('https://example.com'), 'https://example.com')
  assert.equal(plugin.linkTarget('http://example.com/x'), 'http://example.com/x')
})

test('linkTarget accepts a bare host path', () => {
  assert.equal(plugin.linkTarget('github.com/owner/repo'), 'https://github.com/owner/repo')
  assert.equal(plugin.linkTarget('example.com'), 'https://example.com')
})

test('linkTarget rejects non-URL link text', () => {
  assert.equal(plugin.linkTarget('Cloudflare → Porkbun'), null)
  assert.equal(plugin.linkTarget('local bank'), null)
  assert.equal(plugin.linkTarget(''), null)
  assert.equal(plugin.linkTarget('ftp://example.com'), null)
  assert.equal(plugin.linkTarget('not a url with spaces.com'), null)
})

test('plainText strips markdown bold markers', () => {
  assert.equal(plugin.plainText('**bold**'), 'bold')
  assert.equal(plugin.plainText('Add **one.example** to Cloudflare'), 'Add one.example to Cloudflare')
})

test('timeAgo formats each bucket with correct singular/plural', () => {
  const ago = (s) => plugin.timeAgo(NOW - s, NOW)
  assert.equal(ago(5), 'just now')
  assert.equal(ago(30), '30 seconds ago')
  assert.equal(ago(60), '1 minute ago')
  assert.equal(ago(5 * 60), '5 minutes ago')
  assert.equal(ago(3600), '1 hour ago')
  assert.equal(ago(3 * 3600), '3 hours ago')
  assert.equal(ago(86400), '1 day ago')
  assert.equal(ago(6 * 86400), '6 days ago')
  assert.equal(ago(7 * 86400), '1 week ago')
  assert.equal(ago(28 * 86400), '4 weeks ago')
  assert.equal(ago(30 * 86400), '1 month ago')
  assert.equal(ago(330 * 86400), '11 months ago')
  assert.equal(ago(365 * 86400), '1 year ago')
  assert.equal(ago(730 * 86400), '2 years ago')
})

test('closeTarget returns session when an active id is present', () => {
  assert.deepEqual(plugin.closeTarget('sess-1'), { kind: 'session', id: 'sess-1' })
})

test('closeTarget returns new when there is no active id', () => {
  assert.deepEqual(plugin.closeTarget(null), { kind: 'new' })
  assert.deepEqual(plugin.closeTarget(''), { kind: 'new' })
  assert.deepEqual(plugin.closeTarget(undefined), { kind: 'new' })
})

const MIXED = [
  { id: 'a', status: 'open', created_at: 100 },
  { id: 'b', status: 'done', created_at: 200 },
  { id: 'c', status: 'dismissed', created_at: 300 },
]

test('filterPins filters each status and keeps everything for all', () => {
  assert.deepEqual(plugin.filterPins(MIXED, 'open').map((p) => p.id), ['a'])
  assert.deepEqual(plugin.filterPins(MIXED, 'done').map((p) => p.id), ['b'])
  assert.deepEqual(plugin.filterPins(MIXED, 'dismissed').map((p) => p.id), ['c'])
  assert.deepEqual(plugin.filterPins(MIXED, 'all').map((p) => p.id), ['a', 'b', 'c'])
})

test('filterPins filters a mixed backend response down to dismissed', () => {
  assert.deepEqual(plugin.filterPins(MIXED, 'dismissed'), [{ id: 'c', status: 'dismissed', created_at: 300 }])
})

test('sortPins sorts newest and oldest by created_at', () => {
  assert.deepEqual(plugin.sortPins(MIXED, 'newest').map((p) => p.id), ['c', 'b', 'a'])
  assert.deepEqual(plugin.sortPins(MIXED, 'oldest').map((p) => p.id), ['a', 'b', 'c'])
})

test('sortPins breaks created_at ties by id and does not mutate input', () => {
  const input = [
    { id: 'z', status: 'open', created_at: 100 },
    { id: 'm', status: 'open', created_at: 100 },
  ]
  const sorted = plugin.sortPins(input, 'newest')
  assert.deepEqual(sorted.map((p) => p.id), ['m', 'z'])
  assert.deepEqual(input.map((p) => p.id), ['z', 'm'])
})
