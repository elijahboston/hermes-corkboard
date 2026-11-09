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
