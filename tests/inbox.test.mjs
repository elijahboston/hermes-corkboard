import { register } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Inbox helpers behind the grouped pane (CORE-641).
await register(new URL('./_plugin_stubs.mjs', import.meta.url).href)
const plugin = await import('../desktop/plugin.js')
const NOW = 1_000_000_000

test('shortAge gives compact buckets', () => {
  const age = (s) => plugin.shortAge(NOW - s, NOW)
  assert.equal(age(5), 'now')
  assert.equal(age(5 * 60), '5m')
  assert.equal(age(6 * 3600), '6h')
  assert.equal(age(2 * 86400), '2d')
  assert.equal(age(8 * 86400), '1w')
  assert.equal(age(65 * 86400), '2mo')
  assert.equal(age(800 * 86400), '2y')
  assert.equal(plugin.shortAge(null, NOW), '')
})

test('isStale flags open pins at the threshold, never closed ones', () => {
  const at = (days, status = 'open') => plugin.isStale({ status, created_at: NOW - days * 86400 }, NOW)
  assert.equal(at(plugin.STALE_DAYS), true)
  assert.equal(at(plugin.STALE_DAYS - 0.5), false)
  assert.equal(at(30, 'done'), false)
  assert.equal(plugin.isStale({ status: 'open' }, NOW), false)
})

test('pinGroup: waiting_on wins, answer kinds decide, tasks need you', () => {
  assert.equal(plugin.pinGroup({ kind: 'task' }), 'act')
  assert.equal(plugin.pinGroup({}), 'act')
  for (const kind of ['yes_no', 'choice', 'text']) assert.equal(plugin.pinGroup({ kind }), 'decide')
  assert.equal(plugin.pinGroup({ kind: 'yes_no', waiting_on: 'Apple review' }), 'waiting')
  assert.equal(plugin.pinGroup({ kind: 'task', waiting_on: '   ' }), 'act')
})

test('groupPins keeps group order, drops empty groups, preserves order inside', () => {
  const pins = [
    { id: 'w', waiting_on: 'x' }, { id: 'a1' }, { id: 'd', kind: 'choice' }, { id: 'a2', kind: 'task' },
  ]
  const groups = plugin.groupPins(pins)
  assert.deepEqual(groups.map((g) => g.key), ['act', 'decide', 'waiting'])
  assert.deepEqual(groups[0].pins.map((p) => p.id), ['a1', 'a2'])
  assert.deepEqual(plugin.groupPins([{ id: 'a' }]).map((g) => g.key), ['act'])
  assert.deepEqual(plugin.groupPins(null), [])
})

test('statusCounts counts each tab', () => {
  const counts = plugin.statusCounts([{ status: 'open' }, { status: 'open' }, { status: 'done' }, { status: 'dismissed' }])
  assert.deepEqual(counts, { open: 2, done: 1, dismissed: 1, all: 4 })
})

test('splitTitle keeps a short title and an explicit detail as is', () => {
  assert.deepEqual(plugin.splitTitle({ title: 'Sign the **DPA**' }), { title: 'Sign the DPA', detail: '' })
  const long = 'x '.repeat(60).trim()
  assert.deepEqual(plugin.splitTitle({ title: long, detail: 'why' }), { title: long, detail: 'why' })
})

test('splitTitle shortens a legacy paragraph title at its first clause', () => {
  const t1 = 'Run (or approve) the end-to-end MCP demo: agent renders, reads report, fixes layout, passes intent check'
  assert.deepEqual(plugin.splitTitle({ title: t1 }), { title: 'Run (or approve) the end-to-end MCP demo', detail: t1 })
  const t2 = 'Follow Hermes bug #151126 (kanban dispatch hook runs without a profile secret scope; plugins get `UnscopedSecretError`).'
  assert.equal(plugin.splitTitle({ title: t2 }).title, 'Follow Hermes bug #151126')
})

test('splitTitle falls back to a word cut with an ellipsis', () => {
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november'
  const { title, detail } = plugin.splitTitle({ title: words })
  assert.ok(title.endsWith('…'))
  assert.ok(title.length <= 61)
  assert.ok(!title.slice(0, -1).endsWith(' '))
  assert.equal(detail, words)
})

test('parseRich splits code, notes, urls, bare hosts and tracker ids', () => {
  const text = 'Where: github.com/NousResearch/hermes-agent/issues/151126; workaround in `issue_sync/secrets.py`; [[Projects/Hermes Issue Sync/Status]] see CORE-570.'
  const toks = plugin.parseRich(text)
  assert.deepEqual(toks.map((t) => t.t), ['text', 'url', 'text', 'code', 'text', 'note', 'text', 'issue', 'text'])
  const url = toks.find((t) => t.t === 'url')
  assert.equal(url.href, 'https://github.com/NousResearch/hermes-agent/issues/151126')
  assert.equal(toks[2].v, '; workaround in ')
  assert.equal(toks.find((t) => t.t === 'code').v, 'issue_sync/secrets.py')
  assert.equal(toks.find((t) => t.t === 'note').v, 'Projects/Hermes Issue Sync/Status')
  assert.equal(toks.find((t) => t.t === 'issue').v, 'CORE-570')
  assert.equal(toks[toks.length - 1].v, '.')
})

test('parseRich leaves plain words, file names and lowercase ids alone', () => {
  for (const s of ['end-to-end demo', 'edit plugin.js and secrets.py', 'utf-8 text', 'Cloudflare → Porkbun']) {
    assert.deepEqual(plugin.parseRich(s), [{ t: 'text', v: s }])
  }
  assert.deepEqual(plugin.parseRich(''), [])
  assert.deepEqual(plugin.parseRich(null), [])
})

test('parseRich keeps http(s) URLs whole and strips trailing punctuation', () => {
  const toks = plugin.parseRich('(see https://example.com/a?b=1).')
  const url = toks.find((t) => t.t === 'url')
  assert.equal(url.href, 'https://example.com/a?b=1')
  assert.equal(toks.map((t) => t.v).join(''), '(see https://example.com/a?b=1).')
})

test('noteLabel shows the last two path parts or the alias', () => {
  assert.equal(plugin.noteLabel('Projects/Hermes Issue Sync/Status'), 'Hermes Issue Sync / Status')
  assert.equal(plugin.noteLabel('Inbox'), 'Inbox')
  assert.equal(plugin.noteLabel('Projects/X|the status page'), 'the status page')
})

test('linkLabel names GitHub issues, Linear ids and plain hosts', () => {
  assert.equal(plugin.linkLabel('https://github.com/NousResearch/hermes-agent/issues/151126'), 'GitHub #151126')
  assert.equal(plugin.linkLabel('https://github.com/o/r/pull/7'), 'GitHub #7')
  assert.equal(plugin.linkLabel('https://linear.app/acme/issue/core-570/some-title'), 'CORE-570')
  assert.equal(plugin.linkLabel('https://www.example.com/x'), 'example.com')
  assert.equal(plugin.linkLabel('not a url'), 'not a url')
})

test('primaryLink finds the first URL in mixed link text', () => {
  assert.deepEqual(plugin.primaryLink({ link: 'see `x.py` and github.com/o/r/issues/2; [[n]]' }), {
    href: 'https://github.com/o/r/issues/2', label: 'GitHub #2',
  })
  assert.equal(plugin.primaryLink({ link: 'Linear CORE-570' }), null)
  assert.equal(plugin.primaryLink({}), null)
})

test('subline picks answer, waiting, question, unblocks, then link text', () => {
  assert.deepEqual(plugin.subline({ status: 'done', kind: 'yes_no', answer: 'yes' }), { label: 'Answered', text: 'Yes' })
  assert.deepEqual(plugin.subline({ status: 'open', waiting_on: 'Apple', unblocks: 'beta' }), { label: 'Waiting on', text: 'Apple' })
  assert.deepEqual(plugin.subline({ status: 'open', kind: 'yes_no', question: 'Ship it?', unblocks: 'tag' }), { label: '', text: 'Ship it?' })
  assert.deepEqual(plugin.subline({ status: 'open', unblocks: 'the epic' }), { label: 'Unblocks', text: 'the epic' })
  assert.deepEqual(plugin.subline({ status: 'open', link: 'Linear CORE-570' }), { label: '', text: 'Linear CORE-570' })
  assert.equal(plugin.subline({ status: 'open', link: 'https://example.com' }), null)
  assert.equal(plugin.subline({ status: 'open' }), null)
})

test('withRecentlyClosed keeps a just-closed row in place until its Undo expires', () => {
  const open = [{ id: 'a', created_at: 3 }, { id: 'c', created_at: 1 }]
  const closed = { b: { pin: { id: 'b', created_at: 2 }, verb: 'done' } }
  assert.deepEqual(plugin.withRecentlyClosed(open, closed, 'newest').map((p) => p.id), ['a', 'b', 'c'])
  assert.equal(plugin.withRecentlyClosed(open, {}, 'newest'), open)
  // A reload that still lists the pin as open does not duplicate it.
  const dup = { a: { pin: { id: 'a', created_at: 3 }, verb: 'done' } }
  assert.deepEqual(plugin.withRecentlyClosed(open, dup, 'newest').map((p) => p.id), ['a', 'c'])
})
