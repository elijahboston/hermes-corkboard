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

test('metaLine gives an open pin only a Pinned segment', () => {
  const segments = plugin.metaLine({ status: 'open', created_at: NOW - 3 * 3600 }, NOW)
  assert.equal(segments.length, 1)
  assert.deepEqual({ label: segments[0].label, ago: segments[0].ago }, { label: 'Pinned', ago: '3 hours ago' })
  assert.ok(segments[0].iso.length > 0)
})

test('metaLine labels a done pin Pinned · Done', () => {
  const segments = plugin.metaLine({ status: 'done', created_at: NOW - 7 * 3600, closed_at: NOW - 120 }, NOW)
  assert.deepEqual(segments.map(s => s.label), ['Pinned', 'Done'])
  assert.equal(segments[0].ago, '7 hours ago')
  assert.equal(segments[1].ago, '2 minutes ago')
  assert.ok(segments.every(s => s.iso.length > 0))
})

test('metaLine labels a dismissed pin Pinned · Dismissed', () => {
  const segments = plugin.metaLine({ status: 'dismissed', created_at: NOW - 86400, closed_at: NOW - 60 }, NOW)
  assert.deepEqual(segments.map(s => s.label), ['Pinned', 'Dismissed'])
  assert.equal(segments[1].ago, '1 minute ago')
})

test('metaLine falls back to done_at and answered_at for the closed time', () => {
  const done = plugin.metaLine({ status: 'done', created_at: NOW - 3600, done_at: NOW - 60 }, NOW)
  assert.equal(done[1].ago, '1 minute ago')
  const answered = plugin.metaLine({ status: 'done', created_at: NOW - 3600, answered_at: NOW - 30 }, NOW)
  assert.equal(answered[1].ago, '30 seconds ago')
})

test('metaLine capitalises a yes/no answer', () => {
  const yes = plugin.metaLine({ status: 'done', kind: 'yes_no', created_at: NOW - 3600, closed_at: NOW - 60, answer: 'yes' }, NOW)
  const yesSeg = yes.find(s => s.label === 'Answered')
  assert.equal(yesSeg.ago, 'Yes')
  assert.equal(yesSeg.iso, null)

  const no = plugin.metaLine({ status: 'done', kind: 'yes_no', created_at: NOW - 3600, closed_at: NOW - 60, answer: 'no' }, NOW)
  assert.equal(no.find(s => s.label === 'Answered').ago, 'No')
})

test('metaLine keeps a choice answer verbatim', () => {
  const segments = plugin.metaLine({ status: 'done', kind: 'choice', created_at: NOW - 3600, closed_at: NOW - 60, answer: 'Ship it' }, NOW)
  assert.equal(segments.find(s => s.label === 'Answered').ago, 'Ship it')
})

test('metaLine truncates a long text answer and keeps the full value as a tooltip', () => {
  const full = 'x'.repeat(100)
  const segments = plugin.metaLine({ status: 'done', kind: 'text', created_at: NOW - 3600, closed_at: NOW - 60, answer: full }, NOW)
  const answered = segments.find(s => s.label === 'Answered')
  assert.equal(answered.ago, 'x'.repeat(60) + '…')
  assert.equal(answered.iso, full)
})

test('metaLine leaves a short text answer untruncated with no tooltip', () => {
  const segments = plugin.metaLine({ status: 'done', kind: 'text', created_at: NOW - 3600, closed_at: NOW - 60, answer: 'call the bank' }, NOW)
  const answered = segments.find(s => s.label === 'Answered')
  assert.equal(answered.ago, 'call the bank')
  assert.equal(answered.iso, null)
})

test('metaLine returns an empty list for a null pin', () => {
  assert.deepEqual(plugin.metaLine(null, NOW), [])
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

test('originLabel maps each kind to its chip label', () => {
  assert.equal(plugin.originLabel({ origin_kind: 'session' }), 'Chat')
  assert.equal(plugin.originLabel({ origin_kind: 'bot' }), 'Bot')
  assert.equal(plugin.originLabel({ origin_kind: 'kanban' }), 'Kanban')
  assert.equal(plugin.originLabel({ origin_kind: 'cli' }), 'CLI')
  assert.equal(plugin.originLabel({ origin_kind: 'import' }), 'Imported')
  assert.equal(plugin.originLabel({ origin_kind: 'api' }), 'API')
})

test('originLabel falls back to Chat for unknown kinds', () => {
  assert.equal(plugin.originLabel({ origin_kind: 'bogus' }), 'Chat')
  assert.equal(plugin.originLabel({}), 'Chat')
})

test('originAction carries a session id for a session origin', () => {
  assert.deepEqual(
    plugin.originAction({ origin_kind: 'session', origin_session_id: 's1', origin_profile: 'p' }),
    { kind: 'session', session_id: 's1', profile: 'p' }
  )
})

test('originAction never carries the stored session id for a bot origin', () => {
  assert.deepEqual(
    plugin.originAction({ origin_kind: 'bot', origin_profile: 'p', origin_session_id: 's1' }),
    { kind: 'bot', profile: 'p' }
  )
})

test('originAction parses a kanban ref from source', () => {
  assert.deepEqual(
    plugin.originAction({ origin_kind: 'kanban', source: 'kanban:core/t_1' }),
    { kind: 'kanban', board: 'core', task: 't_1' }
  )
})

test('originAction returns a bare kind for cli/import/api', () => {
  assert.deepEqual(plugin.originAction({ origin_kind: 'cli' }), { kind: 'cli' })
  assert.deepEqual(plugin.originAction({ origin_kind: 'import' }), { kind: 'import' })
  assert.deepEqual(plugin.originAction({ origin_kind: 'api' }), { kind: 'api' })
})

test('parseKanbanRef defaults a missing board and rejects non-kanban refs', () => {
  assert.deepEqual(plugin.parseKanbanRef('kanban:/t_1'), { board: 'default', task: 't_1' })
  assert.equal(plugin.parseKanbanRef('nope'), null)
})

test('borderColor returns per-kind defaults', () => {
  assert.equal(plugin.borderColor({ origin_kind: 'session' }), '#3b82f6')
  assert.equal(plugin.borderColor({ origin_kind: 'bot' }, { botColors: false }), '#8b5cf6')
  assert.equal(plugin.borderColor({ origin_kind: 'kanban' }), '#f59e0b')
  assert.equal(plugin.borderColor({ origin_kind: 'cli' }), '#94a3b8')
  assert.equal(plugin.borderColor({ origin_kind: 'import' }), '#14b8a6')
  assert.equal(plugin.borderColor({ origin_kind: 'api' }), '#22c55e')
})

test('borderColor honours a colour override', () => {
  assert.equal(plugin.borderColor({ origin_kind: 'session' }, { colors: { session: '#ff0000' } }), '#ff0000')
})

test('borderColor uses the bot colour when the toggle is on (default)', () => {
  const profileColorFn = (name) => (name === 'worker' ? 'hsl(200 68% 58%)' : null)
  assert.equal(
    plugin.borderColor({ origin_kind: 'bot', origin_profile: 'worker' }, {}, profileColorFn),
    'hsl(200 68% 58%)'
  )
})

test('borderColor ignores the bot colour when the toggle is off', () => {
  const profileColorFn = () => 'hsl(200 68% 58%)'
  assert.equal(
    plugin.borderColor({ origin_kind: 'bot', origin_profile: 'worker' }, { botColors: false }, profileColorFn),
    '#8b5cf6'
  )
})

test('borderColor falls back to cli colour for unknown kinds', () => {
  assert.equal(plugin.borderColor({ origin_kind: 'bogus' }), '#94a3b8')
  assert.equal(plugin.borderColor({}), '#94a3b8')
})

test('borderColor falls back to the default bot colour when profileColor returns nothing', () => {
  assert.equal(plugin.borderColor({ origin_kind: 'bot', origin_profile: 'default' }, {}, () => null), '#8b5cf6')
})

test('originName prefers bot_title for a bot profile', () => {
  const profiles = [{ name: 'cleaner', bot_title: 'Cleaning Crew', display_name: 'Cleaner' }]
  assert.equal(plugin.originName({ origin_kind: 'bot', origin_profile: 'cleaner' }, profiles), 'Cleaning Crew')
})

test('originName uses display_name for a non-bot profile', () => {
  const profiles = [{ name: 'worker', display_name: 'Worker Bee' }]
  assert.equal(plugin.originName({ origin_kind: 'session', origin_profile: 'worker' }, profiles), 'Worker Bee')
})

test('originName falls back to the profile name', () => {
  const profiles = [{ name: 'worker' }]
  assert.equal(plugin.originName({ origin_kind: 'session', origin_profile: 'worker' }, profiles), 'worker')
})

test('originName shows Hermes for the default profile without a display name', () => {
  assert.equal(plugin.originName({ origin_kind: 'session', origin_profile: 'default' }, [{ name: 'default' }]), 'Hermes')
})

test('originName uses the default profile display_name when set', () => {
  assert.equal(plugin.originName({ origin_kind: 'session', origin_profile: 'default' }, [{ name: 'default', display_name: 'Boss' }]), 'Boss')
})

test('originName returns the raw profile name when the profile is missing', () => {
  assert.equal(plugin.originName({ origin_kind: 'session', origin_profile: 'gone' }, []), 'gone')
})

test('originName parses a legacy agent: source when origin_profile is absent', () => {
  const profiles = [{ name: 'worker', display_name: 'Worker Bee' }]
  assert.equal(plugin.originName({ origin_kind: 'session', source: 'agent:worker' }, profiles), 'Worker Bee')
})

test('originName returns null for cli, import, and api origins', () => {
  assert.equal(plugin.originName({ origin_kind: 'cli', origin_profile: 'worker' }, []), null)
  assert.equal(plugin.originName({ origin_kind: 'import' }, []), null)
  assert.equal(plugin.originName({ origin_kind: 'api' }, []), null)
})

test('originName uses origin_profile for kanban and null otherwise', () => {
  const profiles = [{ name: 'worker' }]
  assert.equal(plugin.originName({ origin_kind: 'kanban', origin_profile: 'worker', source: 'kanban:core/t_1' }, profiles), 'worker')
  assert.equal(plugin.originName({ origin_kind: 'kanban', source: 'kanban:core/t_1' }, profiles), null)
})

test('foldOutcome: no runAction/visibility support means the button is unavailable', () => {
  assert.equal(plugin.foldOutcome(false, null), 'unavailable')
})

test('foldOutcome: pane hidden after the toggle means it folded', () => {
  assert.equal(plugin.foldOutcome(true, false), 'folded')
})

test('foldOutcome: pane still visible means the toggle hit another column, so undo it', () => {
  assert.equal(plugin.foldOutcome(true, true), 'undo')
})

test('errorMessage reads a FastAPI detail out of the transport error', () => {
  assert.equal(
    plugin.errorMessage(new Error('502: {"detail":"kanban card t_1 did not accept the answer"}')),
    'kanban card t_1 did not accept the answer',
  )
  assert.equal(plugin.errorMessage(new Error('500: boom')), 'boom')
  assert.equal(plugin.errorMessage(new Error('404: ')), 'Request failed (404)')
  assert.equal(plugin.errorMessage(new Error('Hermes desktop bridge unavailable')), 'Hermes desktop bridge unavailable')
  assert.equal(plugin.errorMessage(null), 'Request failed')
})

test('questionsFirst puts open questions above tasks and keeps order within each group', () => {
  const pins = [
    { id: 't1', status: 'open', kind: 'task' },
    { id: 'q1', status: 'open', kind: 'yes_no' },
    { id: 't2', status: 'open', kind: 'task' },
    { id: 'q2', status: 'open', kind: 'text' },
    { id: 'd1', status: 'done', kind: 'yes_no' },
  ]
  assert.deepEqual(plugin.questionsFirst(pins).map(p => p.id), ['q1', 'q2', 't1', 't2', 'd1'])
  assert.deepEqual(plugin.questionsFirst(null), [])
})

test('checkStatus explains why an open check has not cleared', () => {
  const pin = { status: 'open', check_kind: 'dns_ns', last_check_result: 'no NS records', last_checked_at: NOW - 7200 }
  assert.equal(plugin.checkStatus(pin, NOW), 'Check: no NS records · 2 hours ago')
  assert.equal(plugin.checkStatus({ ...pin, last_checked_at: null }, NOW), 'Check: no NS records')
  assert.equal(plugin.checkStatus({ ...pin, last_check_result: null }, NOW), null)
  assert.equal(plugin.checkStatus({ ...pin, status: 'done' }, NOW), null)
  assert.equal(plugin.checkStatus({ status: 'open' }, NOW), null)
})

test('emptyText gives each tab its own copy', () => {
  assert.match(plugin.emptyText('open'), /Nothing waiting on you/)
  assert.equal(plugin.emptyText('done'), 'Nothing done yet.')
  assert.equal(plugin.emptyText('dismissed'), 'Nothing dismissed.')
  assert.equal(plugin.emptyText('all'), 'No pins yet.')
})
