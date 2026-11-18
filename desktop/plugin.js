// Corkboard desktop half: one home — a full page + sidebar nav — plus a
// foldable right-edge `side` pane that sits beside the chat, bot chat, or
// sessions, and a status-bar open-count badge. Data comes from the plugin's
// own backend via ctx.rest('/pins'), and it refetches on the
// `plugin.corkboard.pins.changed` gateway event. No JSX (disk plugin), never
// auto-focuses or navigates on events.
//
// Pins also record their ORIGIN (which chat / board / surface created them). Each pin
// shows an origin chip, a colour-coded border, and — where the origin is reopenable —
// an "Open chat"/"Open board" button. Bot pins resolve their chat by profile NAME at
// click time (Bot Mode rule: a stored session id dangles after compression), never from
// a stored pointer.

import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  host,
  haptic,
  atom,
  useValue,
  profileColor,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  SETTINGS_PLUGINS_AREA,
} from '@hermes/plugin-sdk'

const PIN_CHANGED = 'plugin.corkboard.pins.changed'
const POLL_MS = 60_000

// -- pure helpers (exported so `tests/links.test.mjs` can exercise them) --------

// A title may carry markdown emphasis (`**bold**`); render it as plain text.
export function plainText(text) {
  return String(text ?? '').replace(/\*\*/g, '')
}

// Return a safe external URL for a pin link, or null when the text is not a URL.
export function linkTarget(text) {
  const t = (text || '').trim()
  if (!t) return null
  if (/^https?:\/\//i.test(t)) return t
  // Bare host-path like `github.com/owner/repo`: accept only when the first token
  // looks like a hostname with a dot and there are no spaces.
  const first = t.split(/\s+/)[0]
  if (!/\s/.test(t) && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?([/?#].*)?$/i.test(first)) {
    return 'https://' + t
  }
  return null
}

// "30 seconds ago" style age from an epoch-seconds timestamp.
export function timeAgo(seconds, now = Date.now() / 1000) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return ''
  const diff = Math.max(0, Math.floor(now - s))
  if (diff < 10) return 'just now'
  if (diff < 60) return `${diff} seconds ago`
  const minutes = Math.floor(diff / 60)
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`
  if (days < 30) {
    const weeks = Math.floor(days / 7)
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`
  }
  const months = Math.floor(days / 30)
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`
  const years = Math.floor(days / 365)
  return years === 1 ? '1 year ago' : `${years} years ago`
}

const ANSWER_TRUNCATE = 60

// Absolute local time for an epoch-seconds timestamp ('' when absent/invalid).
function isoTime(seconds) {
  const s = Number(seconds)
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000).toLocaleString() : ''
}

// Yes/no answers are capitalised; every other answer passes through verbatim.
function answerValue(pin) {
  const answer = String(pin?.answer ?? '').trim()
  if (!answer) return null
  if (pin?.kind === 'yes_no') {
    const lower = answer.toLowerCase()
    if (lower === 'yes') return 'Yes'
    if (lower === 'no') return 'No'
  }
  return answer
}

// The single card meta line as `{label, ago, iso}` segments: `Pinned` always;
// then `Done`/`Dismissed` when closed; then `Answered` when answered.
// `iso` is the hover tooltip — the absolute local time for time segments, or
// the full untruncated text for a truncated text answer (else null).
export function metaLine(pin, now = Date.now() / 1000) {
  if (!pin) return []
  const segments = [{ label: 'Pinned', ago: timeAgo(pin.created_at, now), iso: isoTime(pin.created_at) }]

  if (pin.status === 'done' || pin.status === 'dismissed') {
    const closed = pin.closed_at || pin.done_at || pin.answered_at
    segments.push({
      label: pin.status === 'done' ? 'Done' : 'Dismissed',
      ago: timeAgo(closed, now),
      iso: isoTime(closed),
    })
  }

  const value = answerValue(pin)
  if (value !== null) {
    const truncated = pin.kind === 'text' && value.length > ANSWER_TRUNCATE
    segments.push({
      label: 'Answered',
      ago: truncated ? `${value.slice(0, ANSWER_TRUNCATE)}…` : value,
      iso: truncated ? value : null,
    })
  }

  return segments
}

// The readable reason behind a failed `ctx.rest` call. The desktop transport throws
// `Error("<status>: <body>")`; a FastAPI body is `{"detail": "..."}`.
export function errorMessage(err) {
  const raw = String(err?.message ?? err ?? '').trim()
  const m = /^(\d{3}):\s*([\s\S]*)$/.exec(raw)
  const body = m ? m[2].trim() : raw
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed.detail === 'string' && parsed.detail) return parsed.detail
  } catch (_e) {
    // not JSON: fall through to the raw text
  }
  if (body) return body.length > 200 ? `${body.slice(0, 200)}…` : body
  return m ? `Request failed (${m[1]})` : 'Request failed'
}

// Open pins that wait on an answer (yes/no, choice, text) come before plain tasks —
// they are what keeps an agent blocked. Order inside each group is preserved.
export function questionsFirst(pins) {
  const list = Array.isArray(pins) ? pins : []
  const isQuestion = (p) => p?.status === 'open' && p?.kind && p.kind !== 'task'
  return [...list.filter(isQuestion), ...list.filter((p) => !isQuestion(p))]
}

// Why an auto-clearing check has not cleared yet, e.g. "Check: no NS records · 2 hours ago".
// Null for pins without a check, pins never checked, or closed pins.
export function checkStatus(pin, now = Date.now() / 1000) {
  if (!pin?.check_kind || pin.status !== 'open') return null
  const result = String(pin.last_check_result ?? '').trim()
  if (!result) return null
  const ago = timeAgo(pin.last_checked_at, now)
  return ago ? `Check: ${result} · ${ago}` : `Check: ${result}`
}

// Decide where closing the corkboard page should land: back into the active
// session, or a fresh chat when there is no active session.
export function closeTarget(activeSessionId) {
  return activeSessionId ? { kind: 'session', id: activeSessionId } : { kind: 'new' }
}

// Client-side defence in depth: a backend that ignores `?status=`/`?sort=` still
// yields the right list because we filter and sort here. `all` keeps everything.
export function filterPins(pins, status) {
  const list = Array.isArray(pins) ? pins : []
  if (status === 'all' || status == null) return list
  return list.filter((pin) => pin.status === status)
}

// Newest = newest created_at first; oldest = oldest first. Stable, id as tie-break.
export function sortPins(pins, sort) {
  const list = Array.isArray(pins) ? pins.slice() : []
  const dir = sort === 'oldest' ? 1 : -1
  return list.sort((a, b) => {
    const diff = (a.created_at ?? 0) - (b.created_at ?? 0)
    if (diff !== 0) return diff * dir
    const aId = String(a.id ?? '')
    const bId = String(b.id ?? '')
    if (aId < bId) return -1
    if (aId > bId) return 1
    return 0
  })
}

// -- inbox helpers (CORE-641) --------------------------------------------------

// Open pins older than this read as stale (amber age).
export const STALE_DAYS = 5

// Compact age for the row's right edge: `now`, `5m`, `6h`, `2d`, `1w`, `3mo`, `1y`.
export function shortAge(seconds, now = Date.now() / 1000) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return ''
  const diff = Math.max(0, Math.floor(now - s))
  if (diff < 60) return 'now'
  const minutes = Math.floor(diff / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

// An open pin that has sat for `days` or more. Closed pins are never stale.
export function isStale(pin, now = Date.now() / 1000, days = STALE_DAYS) {
  if (pin?.status !== 'open') return false
  const s = Number(pin?.created_at)
  if (!Number.isFinite(s) || s <= 0) return false
  return now - s >= days * 86400
}

// Which inbox group a pin sits in: waiting on someone else, a decision, or an action.
export function pinGroup(pin) {
  if (String(pin?.waiting_on ?? '').trim()) return 'waiting'
  if (pin?.kind && pin.kind !== 'task') return 'decide'
  return 'act'
}

export const GROUPS = [
  ['act', 'Needs you'],
  ['decide', 'Decide'],
  ['waiting', 'Waiting on others'],
]

// Pins split into the non-empty inbox groups, in GROUPS order; order inside a group is kept.
export function groupPins(pins) {
  const list = Array.isArray(pins) ? pins : []
  return GROUPS
    .map(([key, label]) => ({ key, label, pins: list.filter((p) => pinGroup(p) === key) }))
    .filter((g) => g.pins.length > 0)
}

// Pin counts per status tab.
export function statusCounts(pins) {
  const counts = { open: 0, done: 0, dismissed: 0, all: 0 }
  for (const p of Array.isArray(pins) ? pins : []) {
    counts.all += 1
    if (Object.prototype.hasOwnProperty.call(counts, p?.status)) counts[p.status] += 1
  }
  return counts
}

const TITLE_FITS = 72
const TITLE_MAX = 60
const CLAUSE_BREAKS = ['. ', ': ', '; ', '? ', '! ', ' (', ' — ', ' – ', ' - ']

// The leading clause of a long legacy title (a break at or after 20 chars), else a word cut.
function firstClause(text) {
  let best = -1
  for (const sep of CLAUSE_BREAKS) {
    let i = text.indexOf(sep)
    while (i !== -1 && i < 20) i = text.indexOf(sep, i + 1)
    if (i !== -1 && (best === -1 || i < best)) best = i
  }
  if (best !== -1 && best <= TITLE_MAX) return text.slice(0, best).replace(/[\s,]+$/, '')
  const words = text.slice(0, TITLE_MAX + 1).split(' ')
  if (words.length > 1) words.pop()
  return `${words.join(' ').replace(/[\s,.;:]+$/, '')}…`
}

// The row title and the expandable detail. Pins with a `detail` keep their title as is;
// older pins that put a paragraph in `title` show its first clause and keep the whole
// paragraph as the detail, so nothing is lost.
export function splitTitle(pin) {
  const full = plainText(pin?.title).trim()
  const detail = String(pin?.detail ?? '').trim()
  if (detail || full.length <= TITLE_FITS) return { title: full, detail }
  return { title: firstClause(full), detail: full }
}

// Hosts a bare `host/path` link may use; keeps `secrets.py` and `plugin.js` as text.
const BARE_TLDS = 'com|org|net|io|dev|app|ai|co|so|sh|me|gg|xyz|us|uk'
const RICH_RE = new RegExp(
  '`([^`\\n]+)`'
  + '|\\[\\[([^\\]\\n]+)\\]\\]'
  + '|(https?:\\/\\/[^\\s<>`]+)'
  + `|\\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${BARE_TLDS})\\/[^\\s<>\`]*)`
  + '|\\b([A-Z][A-Z0-9]{1,9}-\\d+)\\b',
  'g',
)
const TRAILING_PUNCT = /[.,;:!?'")\]]+$/

// Split free text into render tokens: `text`, `code` (backticks), `note` ([[wiki link]]),
// `url` (http(s) or bare host/path, with `href`), and `issue` (a tracker id like CORE-570).
export function parseRich(text) {
  const src = String(text ?? '')
  const out = []
  const pushText = (v) => {
    if (!v) return
    const last = out[out.length - 1]
    if (last && last.t === 'text') last.v += v
    else out.push({ t: 'text', v })
  }
  let at = 0
  for (const m of src.matchAll(RICH_RE)) {
    pushText(src.slice(at, m.index))
    at = m.index + m[0].length
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] })
    else if (m[2] !== undefined) out.push({ t: 'note', v: m[2] })
    else if (m[3] !== undefined || m[4] !== undefined) {
      const raw = m[3] ?? m[4]
      const tail = (TRAILING_PUNCT.exec(raw) || [''])[0]
      const v = tail ? raw.slice(0, -tail.length) : raw
      out.push({ t: 'url', v, href: m[3] !== undefined ? v : `https://${v}` })
      pushText(tail)
    } else out.push({ t: 'issue', v: m[5] })
  }
  pushText(src.slice(at))
  return out
}

// `[[Projects/Hermes Issue Sync/Status]]` -> `Hermes Issue Sync / Status`; `[[a|b]]` -> `b`.
export function noteLabel(target) {
  const raw = String(target ?? '')
  const alias = raw.split('|')
  if (alias.length > 1 && alias[1].trim()) return alias[1].trim()
  const parts = alias[0].split('/').map((p) => p.trim()).filter(Boolean)
  return parts.slice(-2).join(' / ') || raw
}

// Short label for a link chip: GitHub issues/PRs as `GitHub #123`, Linear as its id, else host.
export function linkLabel(href) {
  try {
    const u = new URL(href)
    const host = u.hostname.replace(/^www\./, '')
    const parts = u.pathname.split('/').filter(Boolean)
    if (host === 'github.com' && parts.length >= 4 && (parts[2] === 'issues' || parts[2] === 'pull')) {
      return `GitHub #${parts[3]}`
    }
    if (host === 'linear.app') {
      const i = parts.indexOf('issue')
      if (i !== -1 && parts[i + 1]) return parts[i + 1].toUpperCase()
    }
    return host
  } catch (_e) {
    return String(href ?? '')
  }
}

// The first URL in a pin's link text, as `{ href, label }`, or null.
export function primaryLink(pin) {
  const tok = parseRich(pin?.link).find((t) => t.t === 'url')
  return tok ? { href: tok.href, label: linkLabel(tok.href) } : null
}

// The row's second line as `{ label, text }`, or null. Answers win on closed pins, then who
// it waits on, then a decision's question, then what it unblocks, then non-URL link text.
export function subline(pin) {
  const value = pin?.status !== 'open' ? answerValue(pin) : null
  if (value !== null) return { label: 'Answered', text: value }
  const waiting = String(pin?.waiting_on ?? '').trim()
  if (waiting) return { label: 'Waiting on', text: waiting }
  const question = String(pin?.question ?? '').trim()
  if (pin?.kind && pin.kind !== 'task' && question) return { label: '', text: question }
  const unblocks = String(pin?.unblocks ?? '').trim()
  if (unblocks) return { label: 'Unblocks', text: unblocks }
  const link = String(pin?.link ?? '').trim()
  if (link && !primaryLink(pin)) return { label: '', text: link }
  return null
}

// -- origin helpers ------------------------------------------------------------

const ORIGIN_LABELS = {
  session: 'Chat',
  bot: 'Bot',
  kanban: 'Kanban',
  cli: 'CLI',
  import: 'Imported',
  api: 'API',
}

// Default border colours (tailwind mid-tones; readable on light and dark).
const DEFAULT_ORIGIN_COLORS = {
  session: '#3b82f6', // chat = blue
  bot: '#8b5cf6', // violet
  kanban: '#f59e0b', // amber
  cli: '#94a3b8', // slate
  import: '#14b8a6', // teal
  api: '#22c55e', // green
}

// The human label for a pin's origin chip.
export function originLabel(pin) {
  return ORIGIN_LABELS[pin?.origin_kind] || 'Chat'
}
// The raw profile name behind a pin's origin, if any. Older rows predate
// `origin_profile`; their `source` carries `agent:<profile>`. Kanban pins keep
// their board/task text unless a profile was recorded.
function originProfileName(pin) {
  if (pin?.origin_profile) return pin.origin_profile
  if (pin?.origin_kind === 'kanban') return null
  const m = /^agent:(.+)$/.exec(String(pin?.source ?? ''))
  return m ? m[1] : null
}

// The display name of the agent behind a pin, or null when there is none to show.
export function originName(pin, profiles) {
  const kind = pin?.origin_kind
  if (kind === 'cli' || kind === 'import' || kind === 'api') return null
  const profileName = originProfileName(pin)
  if (!profileName) return null
  const row = profilesByName(profiles).get(profileName)
  if (profileName === 'default') {
    if (row && String(row.display_name || '').trim()) return String(row.display_name).trim()
    return 'Hermes'
  }
  if (row) {
    return botTitleOf(row) || String(row.display_name || '').trim() || profileName
  }
  return profileName
}

// `kanban:<board>/<task>` -> `{ board, task }`, or null when it does not parse.
export function parseKanbanRef(source) {
  const m = /^kanban:([^/]*)\/(.+)$/.exec(String(source ?? ''))
  if (!m) return null
  return { board: m[1] || 'default', task: m[2] }
}

// The reopenable target behind a pin's origin. A `bot` origin carries NO session id:
// the bot's chat is identified by profile name (Bot Mode rule).
export function originAction(pin) {
  const kind = pin?.origin_kind
  if (kind === 'bot') {
    return { kind: 'bot', profile: pin.origin_profile || null }
  }
  if (kind === 'session') {
    return { kind: 'session', session_id: pin.origin_session_id || null, profile: pin.origin_profile || null }
  }
  if (kind === 'kanban') {
    const ref = parseKanbanRef(pin?.source ?? pin?.reply_to)
    return { kind: 'kanban', board: ref?.board ?? null, task: ref?.task ?? null }
  }
  return { kind: kind || 'cli' }
}

// Card border colour by origin kind. `prefs` is the appearance settings object
// ({ botColors, colors }); `profileColorFn(name)` supplies a bot's own colour.
export function borderColor(pin, prefs = {}, profileColorFn = null) {
  const kind = pin?.origin_kind
  const colors = (prefs && prefs.colors) || {}
  if (kind === 'bot' && (prefs?.botColors ?? true)) {
    const botColor = typeof profileColorFn === 'function' ? profileColorFn(pin?.origin_profile) : null
    if (botColor) return botColor
    return colors.bot || DEFAULT_ORIGIN_COLORS.bot
  }
  const key = Object.prototype.hasOwnProperty.call(DEFAULT_ORIGIN_COLORS, kind) ? kind : 'cli'
  return colors[key] || DEFAULT_ORIGIN_COLORS[key]
}

function botTitleOf(profile) {
  if (typeof profile?.bot_title === 'string' && profile.bot_title.trim()) return profile.bot_title.trim()
  const bots = profile?.ui_meta?.['hermes-bots']
  if (bots && typeof bots === 'object' && typeof bots.title === 'string' && bots.title.trim()) {
    return bots.title.trim()
  }
  return ''
}

function isBotProfile(profile) {
  if (!profile) return false
  const name = String(profile.name || '').trim()
  if (!name || name === 'default') return false
  if (botTitleOf(profile)) return true
  return !!(profile.ui_meta && profile.ui_meta['hermes-bots'])
}

function profilesByName(profiles) {
  const map = new Map()
  for (const p of Array.isArray(profiles) ? profiles : []) {
    if (p && typeof p.name === 'string') map.set(p.name, p)
  }
  return map
}

// Upgrade a `session`-kind pin to `bot` when its origin profile is a Bot Mode bot.
function resolvePinOrigin(pin, profiles) {
  if (pin?.origin_kind === 'session' && pin?.origin_profile) {
    const row = profilesByName(profiles).get(pin.origin_profile)
    if (row && isBotProfile(row)) return { ...pin, origin_kind: 'bot' }
  }
  return pin
}

// -- appearance preferences ----------------------------------------------------

const DEFAULT_PREFS = { botColors: true, colors: { ...DEFAULT_ORIGIN_COLORS } }
const $prefs = atom(DEFAULT_PREFS)

function mergePrefs(saved) {
  const base = { botColors: true, colors: { ...DEFAULT_ORIGIN_COLORS } }
  if (!saved || typeof saved !== 'object') return base
  return {
    botColors: saved.botColors !== false,
    colors: { ...base.colors, ...(saved.colors && typeof saved.colors === 'object' ? saved.colors : {}) },
  }
}

function readStorage(ctx, key, fallback) {
  try {
    return ctx?.storage && typeof ctx.storage.get === 'function' ? ctx.storage.get(key, fallback) : fallback
  } catch (_e) {
    return fallback
  }
}

function writeStorage(ctx, key, value) {
  try {
    ctx?.storage?.set?.(key, value)
  } catch (_e) {
    // storage absent on older hosts; the in-memory atom still applies.
  }
}

// -- runtime helpers -----------------------------------------------------------

function btn(primary) {
  return primary
    ? 'rounded px-2 py-1 text-xs font-medium bg-(--ui-accent) text-(--ui-accent-fg) disabled:opacity-50'
    : 'rounded px-2 py-1 text-xs border border-(--ui-border) text-(--ui-text-secondary) hover:bg-(--ui-surface) disabled:opacity-50'
}

function inputCls() {
  return 'min-w-0 flex-1 rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1 text-xs'
}

const STATUSES = [
  ['open', 'Open'],
  ['done', 'Done'],
  ['dismissed', 'Dismissed'],
  ['all', 'All'],
]

const avatarCache = new Map() // profileName -> { data: string|null, settled: boolean }

function usePins(ctx, status = 'open', sort = 'newest') {
  const [pins, setPins] = useState([])
  const [counts, setCounts] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    try {
      const data = await ctx.rest('/pins?status=all&sort=newest')
      const list = Array.isArray(data) ? data : (data && data.pins) || []
      setPins(questionsFirst(sortPins(filterPins(list, status), sort)))
      setCounts(statusCounts(list))
      setError(null)
    } catch (err) {
      // Keep the last good list on screen and say the board is stale, not "empty".
      setError(errorMessage(err))
    } finally {
      setLoaded(true)
    }
  }, [ctx, status, sort])

  useEffect(() => { reload() }, [reload])

  useEffect(() => ctx.onEvent(PIN_CHANGED, () => reload()), [ctx, reload])

  // The event only reaches us for writes made inside the gateway. Pins from the CLI,
  // the kanban dispatcher or another profile's process land silently, so also refetch
  // on a slow timer and whenever the window regains focus.
  useEffect(() => {
    const timer = setInterval(() => reload(), POLL_MS)
    const offFocus = typeof ctx.addEventListener === 'function'
      ? ctx.addEventListener(window, 'focus', () => reload())
      : null
    return () => {
      clearInterval(timer)
      if (typeof offFocus === 'function') offFocus()
    }
  }, [ctx, reload])

  return { pins, counts, loaded, error, reload }
}

function useProfiles() {
  const [profiles, setProfiles] = useState([])
  useEffect(() => {
    let disposed = false
    const load = async () => {
      let rows = []
      try {
        if (typeof host?.profiles?.list === 'function') {
          const res = await host.profiles.list()
          rows = Array.isArray(res) ? res : (res?.profiles || [])
        } else if (typeof host?.request === 'function') {
          const res = await host.request('profiles.list', { include_sessions: true })
          rows = Array.isArray(res) ? res : (res?.profiles || [])
        }
      } catch (_e) {
        rows = []
      }
      if (!disposed) setProfiles(rows)
    }
    load()
    return () => { disposed = true }
  }, [])
  return profiles
}

function useBotAvatar(name) {
  const cached = avatarCache.get(name)
  const [data, setData] = useState(cached && cached.settled ? cached.data : null)
  useEffect(() => {
    if (!name) return undefined
    const hit = avatarCache.get(name)
    if (hit && hit.settled) {
      setData(hit.data)
      return undefined
    }
    let disposed = false
    const load = async () => {
      let url = null
      try {
        if (typeof host?.request === 'function') {
          const res = await host.request('profiles.get_asset', { name, asset: 'avatar' })
          url = res?.found && res?.data ? res.data : null
        }
      } catch (_e) {
        url = null
      }
      avatarCache.set(name, { data: url, settled: true })
      if (!disposed) setData(url)
    }
    load()
    return () => { disposed = true }
  }, [name])
  return data
}

async function listProfilesWithSessions() {
  if (typeof host?.request !== 'function') return []
  try {
    const res = await host.request('profiles.list', { include_sessions: true })
    return Array.isArray(res?.profiles) ? res.profiles : []
  } catch (_e) {
    return []
  }
}

async function openOrigin(pin) {
  const action = originAction(pin)
  if (action.kind === 'session' && action.session_id) {
    if (typeof host?.openSession !== 'function') return false
    await host.openSession(action.session_id, { profile: action.profile || undefined })
    return true
  }
  if (action.kind === 'bot' && action.profile) {
    if (typeof host?.openSession !== 'function') return false
    // Bot Mode rule: resolve the canonical chat by NAME every time; a stored
    // session id would dangle after compression. No bot-open app action exists
    // in the plugin allowlist, so we use profiles.list (canonical_session).
    const rows = await listProfilesWithSessions()
    const row = rows.find((r) => r && r.name === action.profile)
    const canonical = row?.canonical_session
    const id = canonical?.resolved_id || canonical?.id
    if (!id) return false
    await host.openSession(id, { profile: action.profile })
    return true
  }
  if (action.kind === 'kanban') {
    if (typeof host?.navigate !== 'function') return false
    host.navigate('/kanban')
    return true
  }
  return false
}

// -- answer / controls ---------------------------------------------------------
//
// Every control receives `act(path, body?)` and `busy` from its card. `act` posts to the
// plugin backend, disables the card's buttons while the request is in flight (no double
// sends), and shows the failure on the card instead of swallowing it. It resolves true on
// success so a control can clear its input only when the answer actually landed.

const onEnter = (fn) => (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    fn()
  }
}

function YesNoAnswer({ act, busy }) {
  const [note, setNote] = useState('')
  const send = (value) => async () => {
    if (await act('answer', { answer: value, note: note.trim() || null })) setNote('')
  }
  return jsxs('div', { className: 'flex flex-wrap items-center gap-1.5', children: [
    jsx('button', { type: 'button', disabled: busy, onClick: send('yes'), className: btn(true), children: 'Yes' }),
    jsx('button', { type: 'button', disabled: busy, onClick: send('no'), className: btn(false), children: 'No' }),
    jsx('input', {
      type: 'text', value: note, placeholder: 'Note (optional)', className: inputCls(), disabled: busy,
      'aria-label': 'Note with your answer',
      onChange: (e) => setNote(e.target.value),
    }),
  ] })
}

function ChoiceAnswer({ pin, act, busy }) {
  const [other, setOther] = useState('')
  const send = (value) => () => act('answer', { answer: value })
  const submitOther = async () => {
    const value = other.trim()
    if (!value || busy) return
    if (await act('answer', { answer: value })) setOther('')
  }
  const choices = Array.isArray(pin.choices) ? pin.choices : []
  const buttons = choices.map((choice, i) =>
    jsxs('button', {
      type: 'button', key: choice, disabled: busy, onClick: send(choice), className: btn(i === 0),
      title: i === 0 ? 'Recommended' : undefined,
      children: [
        choice,
        i === 0 ? jsx('span', { className: 'ml-1 opacity-70', 'aria-label': '(recommended)', children: '★' }) : null,
      ],
    })
  )
  return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
    jsxs('div', { className: 'flex flex-wrap gap-1.5', children: buttons }),
    jsxs('div', { className: 'flex gap-1.5', children: [
      jsx('input', {
        type: 'text', value: other, placeholder: 'Something else…', className: inputCls(), disabled: busy,
        'aria-label': 'Answer with something else',
        onChange: (e) => setOther(e.target.value),
        onKeyDown: onEnter(submitOther),
      }),
      jsx('button', { type: 'button', disabled: busy || !other.trim(), onClick: submitOther, className: btn(false), children: 'Send' }),
    ] }),
  ] })
}

function TextAnswer({ pin, act, busy }) {
  const [value, setValue] = useState('')
  const submit = async () => {
    const text = value.trim()
    if (!text || busy) return
    if (await act('answer', { answer: text })) setValue('')
  }
  return jsxs('div', { className: 'flex gap-1.5', children: [
    jsx('input', {
      type: 'text', value, placeholder: pin.placeholder || 'Answer…', className: inputCls(), disabled: busy,
      'aria-label': 'Your answer',
      onChange: (e) => setValue(e.target.value),
      onKeyDown: onEnter(submit),
    }),
    jsx('button', { type: 'button', disabled: busy || !value.trim(), onClick: submit, className: btn(true), children: 'Send' }),
  ] })
}

// -- origin UI -----------------------------------------------------------------

function BotAvatar({ profileName, display, bot }) {
  const image = useBotAvatar(bot ? profileName : null)
  if (image) {
    return jsx('img', { src: image, className: 'h-4 w-4 rounded-full object-cover', alt: '' })
  }
  const initial = (display || profileName || '?').charAt(0).toUpperCase()
  const color = typeof profileColor === 'function' ? profileColor(profileName) : null
  return jsx('span', {
    className: 'inline-flex h-4 w-4 items-center justify-center rounded-full text-[0.625rem] font-medium text-white',
    style: { backgroundColor: color || '#888888' },
    children: initial,
  })
}

function OriginChip({ pin, profiles }) {
  const label = originLabel(pin)
  const name = originName(pin, profiles)
  if (!name) {
    return jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: label })
  }
  const profileName = originProfileName(pin)
  const profile = profilesByName(profiles).get(profileName) || null
  const bot = isBotProfile(profile)
  return jsxs('span', {
    className: 'inline-flex items-center gap-1',
    title: `From ${name} (${profileName}) · ${label}`,
    children: [
      jsx(BotAvatar, { profileName, display: name, bot }),
      jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: label }),
      jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: name }),
    ],
  })
}

function OriginOpenButton({ pin }) {
  const [failed, setFailed] = useState(false)
  const action = originAction(pin)
  const canOpen = (action.kind === 'session' && action.session_id)
    || (action.kind === 'bot' && action.profile)
    || action.kind === 'kanban'
  if (!canOpen) return null
  if (failed) {
    return jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'Chat no longer available' })
  }
  const label = action.kind === 'kanban' ? 'Open board' : 'Open chat'
  return jsx('button', {
    type: 'button',
    className: 'text-[0.6875rem] text-(--ui-text-tertiary) hover:underline',
    onClick: async () => {
      const ok = await openOrigin(pin).catch(() => false)
      if (!ok) setFailed(true)
    },
    children: label,
  })
}

// -- inbox styles (CORE-641) ---------------------------------------------------
//
// A scoped stylesheet, not Tailwind classes: a disk plugin's class names are not in the app's
// Tailwind build. Colours come from the app's own `--ui-*` tokens, so light/dark follow the theme;
// group hues are mixed toward `--ui-base` so they stay readable on both backgrounds.

const STYLE_ID = 'corkboard-inbox-styles'
const UNDO_MS = 5000

const INBOX_CSS = `
.cb-inbox{--cb-act:color-mix(in srgb,var(--ui-blue,#0053fd) 70%,var(--ui-base,#808080));
  --cb-dec:color-mix(in srgb,var(--ui-purple,#9e94d5) 78%,var(--ui-base,#808080));
  --cb-wait:var(--ui-text-tertiary,#8a8f98);--cb-stale:var(--ui-yellow,#c08532);--cb-ok:var(--ui-green,#1f8a65);
  --cb-t1:var(--ui-text-primary,currentColor);--cb-t2:var(--ui-text-secondary,currentColor);--cb-t3:var(--ui-text-tertiary,#8a8f98);
  --cb-hover:var(--ui-row-hover-background,rgba(127,127,127,.1));--cb-stroke:var(--ui-stroke-secondary,rgba(127,127,127,.4));
  display:flex;flex-direction:column;font-size:12.5px;line-height:1.4;color:var(--cb-t1);padding-bottom:10px}
.cb-inbox :focus-visible{outline:2px solid var(--ui-accent,#4c8dff);outline-offset:1px;border-radius:4px}
.cb-bar{display:flex;align-items:center;gap:2px;padding:6px 8px 2px}
.cb-tab{border:0;background:none;padding:3px 7px;border-radius:5px;font:inherit;font-size:11.5px;color:var(--cb-t3);cursor:pointer}
.cb-tab:hover{background:var(--cb-hover);color:var(--cb-t1)}
.cb-tab[aria-pressed=true]{background:var(--ui-control-active-background,var(--cb-hover));color:var(--cb-t1);font-weight:500}
.cb-n{margin-left:4px;color:var(--cb-t3);font-weight:400;font-variant-numeric:tabular-nums}
.cb-sort{margin-left:auto;position:relative;display:inline-flex;align-items:center}
.cb-sort select{appearance:none;-webkit-appearance:none;border:0;background:none;font:inherit;font-size:11.5px;color:var(--cb-t3);padding:3px 18px 3px 6px;border-radius:5px;cursor:pointer}
.cb-sort select:hover{background:var(--cb-hover);color:var(--cb-t1)}
.cb-sort::after{content:"";position:absolute;right:7px;top:50%;width:4.5px;height:4.5px;border-right:1.5px solid var(--cb-t3);border-bottom:1.5px solid var(--cb-t3);transform:translateY(-70%) rotate(45deg);pointer-events:none}
.cb-grp{display:flex;align-items:center;gap:6px;padding:10px 12px 3px;font-size:11px;font-weight:600}
.cb-grp .cb-n{margin-left:0}
.cb-g-act{color:var(--cb-act)}.cb-g-decide{color:var(--cb-dec)}.cb-g-waiting{color:var(--cb-wait)}
.cb-row{position:relative;display:flex;align-items:flex-start;gap:9px;padding:5px 8px 5px 12px}
.cb-row:hover,.cb-row.cb-expanded{background:var(--cb-hover)}
.cb-row::before{content:"";position:absolute;left:3px;top:7px;bottom:7px;width:2px;border-radius:2px;background:var(--cb-origin,transparent);opacity:.55}
.cb-mark{flex:none;width:15px;height:15px;margin-top:1.5px;border-radius:50%;border:1.5px solid var(--cb-stroke);background:none;padding:0;display:inline-flex;align-items:center;justify-content:center}
button.cb-mark{cursor:pointer}
button.cb-mark:hover{border-color:var(--cb-ok)}
button.cb-mark:hover::after,.cb-mark.cb-done::after{content:"";width:3.5px;height:7px;border-right:1.5px solid var(--cb-ok);border-bottom:1.5px solid var(--cb-ok);transform:translateY(-1px) rotate(45deg)}
.cb-mark.cb-done{border-color:var(--cb-ok);background:color-mix(in srgb,var(--cb-ok) 18%,transparent)}
.cb-mark.cb-wait{border-style:dashed}
.cb-mark.cb-dis::after{content:"";width:7px;border-top:1.5px solid var(--cb-t3)}
.cb-diamond{flex:none;width:10px;height:10px;margin:4px 2.5px 0;border:1.5px solid var(--cb-dec);border-radius:2px;transform:rotate(45deg)}
.cb-body{flex:1;min-width:0;cursor:pointer}
.cb-title{display:block;width:100%;border:0;background:none;padding:0;text-align:left;font:inherit;color:var(--cb-t1);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cb-expanded .cb-title{white-space:normal}
.cb-waiting .cb-title{color:var(--cb-t2)}
.cb-justdone .cb-title{text-decoration:line-through;color:var(--cb-t3)}
.cb-sub{font-size:11.5px;color:var(--cb-t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cb-sub-v{color:var(--cb-t2)}
.cb-right{flex:none;position:relative;display:flex;align-items:center;gap:2px;margin-top:1px}
.cb-age{font-size:11px;color:var(--cb-t3);font-variant-numeric:tabular-nums;padding:0 2px}
.cb-age.cb-stale{color:var(--cb-stale);font-weight:500}
.cb-more{border:0;background:none;color:var(--cb-t3);width:20px;height:18px;border-radius:4px;cursor:pointer;font:inherit;font-size:13px;line-height:1;letter-spacing:1px;opacity:0}
.cb-row:hover .cb-more,.cb-expanded .cb-more,.cb-more:focus-visible,.cb-more[aria-expanded=true]{opacity:1}
.cb-more:hover{background:var(--ui-control-hover-background,var(--cb-hover));color:var(--cb-t1)}
.cb-menu{position:absolute;right:0;top:22px;z-index:20;min-width:132px;background:var(--ui-bg-elevated,var(--ui-bg-card,Canvas));border:1px solid var(--cb-stroke);border-radius:6px;padding:3px;box-shadow:0 6px 18px rgba(0,0,0,.22)}
.cb-menu button{display:block;width:100%;text-align:left;border:0;background:none;font:inherit;font-size:12px;color:var(--cb-t1);padding:4px 8px;border-radius:4px;cursor:pointer;white-space:nowrap}
.cb-menu button:hover{background:var(--cb-hover)}
.cb-undo{font-size:11px;color:var(--cb-t3);white-space:nowrap}
.cb-undo button{border:0;background:none;padding:0;font:inherit;color:var(--cb-act);cursor:pointer}
.cb-detail{margin:2px 10px 6px 36px;padding:2px 0 2px 10px;border-left:1.5px solid var(--cb-stroke);font-size:12px;color:var(--cb-t2);display:flex;flex-direction:column;gap:7px}
.cb-detail p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.cb-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin:0;font-size:11.5px}
.cb-kv dt{color:var(--cb-t3)}.cb-kv dd{margin:0;color:var(--cb-t2);overflow-wrap:anywhere;min-width:0}
.cb-code{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.9em;background:var(--ui-inline-code-background,rgba(127,127,127,.15));color:var(--ui-inline-code-foreground,inherit);padding:0 4px;border-radius:3px}
.cb-link{border:0;background:none;padding:0;font:inherit;color:var(--cb-t2);text-decoration:underline;text-decoration-color:var(--cb-stroke);text-underline-offset:2px;cursor:pointer}
.cb-link:hover{color:var(--cb-t1);text-decoration-color:currentColor}
.cb-note{color:var(--cb-t2);border-bottom:1px dotted var(--cb-stroke)}
.cb-issue{color:var(--cb-t2);font-weight:500}
.cb-gi{flex:none;width:8px;height:8px}
.cb-gi-act{border-radius:50%;background:currentColor}
.cb-gi-decide{width:7px;height:7px;border:1.5px solid currentColor;border-radius:1.5px;transform:rotate(45deg)}
.cb-gi-waiting{width:9px;height:9px;border-radius:50%;border:1.5px dashed currentColor}
.cb-err{font-size:11px;color:var(--ui-red,#cf2d56);padding:0 12px 4px 36px}
.cb-empty{padding:10px 12px;font-size:12px;color:var(--cb-t3)}
.cb-banner{margin:4px 10px;display:flex;align-items:center;gap:8px;border:1px solid var(--cb-stroke);border-radius:6px;padding:4px 8px;font-size:11px;color:var(--ui-red,#cf2d56)}
.cb-banner span{flex:1;min-width:0}
.cb-btn{border:1px solid var(--cb-stroke);background:none;border-radius:5px;padding:2px 9px;font:inherit;font-size:11.5px;color:var(--cb-t2);cursor:pointer}
.cb-btn:hover{background:var(--cb-hover);color:var(--cb-t1)}
`

// Add the inbox stylesheet once; returns the remover for `ctx.onDispose`.
function installStyles() {
  if (typeof document === 'undefined') return () => {}
  document.getElementById(STYLE_ID)?.remove()
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = INBOX_CSS
  document.head.append(el)
  return () => el.remove()
}

// -- inbox rows (CORE-641) -----------------------------------------------------

// Free text with `code`, [[note]] links, URLs and tracker ids rendered in place.
function RichText({ ctx, text }) {
  const open = (href) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    ctx?.os?.openExternal?.(href)
  }
  return parseRich(text).map((tok, i) => {
    if (tok.t === 'code') return jsx('code', { key: i, className: 'cb-code', children: tok.v })
    if (tok.t === 'note') return jsx('span', { key: i, className: 'cb-note', title: tok.v, children: noteLabel(tok.v) })
    if (tok.t === 'issue') return jsx('span', { key: i, className: 'cb-issue', children: tok.v })
    if (tok.t === 'url') {
      return jsx('button', {
        key: i, type: 'button', className: 'cb-link', title: tok.href, onClick: open(tok.href),
        children: `${linkLabel(tok.href)} \u2197`,
      })
    }
    return tok.v
  })
}

function RowMark({ pin, closedVerb, group, busy, onDone }) {
  const status = closedVerb || pin.status
  if (status === 'done') return jsx('span', { className: 'cb-mark cb-done', role: 'img', 'aria-label': 'Done' })
  if (status === 'dismissed') return jsx('span', { className: 'cb-mark cb-dis', role: 'img', 'aria-label': 'Dismissed' })
  if (pin.kind && pin.kind !== 'task') {
    return jsx('span', { className: 'cb-diamond', role: 'img', 'aria-label': 'Needs your answer', title: 'Needs your answer' })
  }
  return jsx('button', {
    type: 'button', disabled: busy, onClick: onDone,
    className: group === 'waiting' ? 'cb-mark cb-wait' : 'cb-mark',
    'aria-label': 'Mark done', title: 'Mark done',
  })
}

function RowMenu({ items }) {
  const [open, setOpen] = useState(false)
  return jsxs('div', {
    style: { position: 'relative' },
    onBlur: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) },
    onKeyDown: (e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } },
    children: [
      jsx('button', {
        type: 'button', className: 'cb-more', 'aria-label': 'More actions', 'aria-haspopup': 'menu',
        'aria-expanded': open, onClick: () => setOpen(!open), children: '\u22EF',
      }),
      open
        ? jsx('div', { className: 'cb-menu', role: 'menu', children: items.map(([label, run]) =>
            jsx('button', { type: 'button', role: 'menuitem', key: label, onClick: () => { setOpen(false); run() }, children: label })
          ) })
        : null,
    ],
  })
}

function PinRow({ ctx, pin, onChanged, onClosed, onForget, closedVerb, profiles, prefs, now }) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const resolvedPin = resolvePinOrigin(pin, profiles)
  const isOpen = pin.status === 'open' && !closedVerb
  const group = pinGroup(pin)

  // One request at a time per row; failures stay on the row until the next attempt.
  const act = async (verb, body) => {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      await ctx.rest(`/pins/${pin.id}/${verb}`, body ? { method: 'POST', body } : { method: 'POST' })
      haptic('tap')
      await onChanged()
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  // Close optimistically so the row stays put showing "Done · Undo"; roll back on failure.
  // `status` is the pin status the row shows; the backend route is `done` / `dismiss`.
  const close = async (status) => {
    onClosed(pin, status)
    if (!(await act(status === 'done' ? 'done' : 'dismiss'))) onForget(pin.id)
  }
  const undo = async () => {
    if (await act('reopen')) onForget(pin.id)
  }

  const { title, detail } = splitTitle(pin)
  const sub = subline(pin)
  const plink = primaryLink(pin)
  const openLink = (e) => {
    e.preventDefault()
    e.stopPropagation()
    ctx?.os?.openExternal?.(plink.href)
  }

  const subEl = (sub || plink)
    ? jsxs('div', { className: 'cb-sub', children: [
        sub && sub.label ? `${sub.label} ` : null,
        sub ? jsx('span', { className: 'cb-sub-v', children: jsx(RichText, { ctx, text: sub.text }) }) : null,
        sub && plink ? ' \u00B7 ' : null,
        plink ? jsx('button', { type: 'button', className: 'cb-link', title: plink.href, onClick: openLink, children: `${plink.label} \u2197` }) : null,
      ] })
    : null

  const age = shortAge(pin.created_at, now)
  const right = closedVerb
    ? jsxs('span', { className: 'cb-undo', role: 'status', children: [
        closedVerb === 'done' ? 'Done \u00B7 ' : 'Dismissed \u00B7 ',
        jsx('button', { type: 'button', disabled: busy, onClick: undo, children: 'Undo' }),
      ] })
    : jsxs('div', { className: 'cb-right', children: [
        age ? jsx('span', {
          className: isStale(pin, now) ? 'cb-age cb-stale' : 'cb-age',
          title: `Pinned ${timeAgo(pin.created_at, now)} \u00B7 ${isoTime(pin.created_at)}`,
          children: age,
        }) : null,
        jsx(RowMenu, { items: isOpen
          ? [['Dismiss', () => close('dismissed')]]
          : [['Reopen', () => act('reopen')]] }),
      ] })

  const row = jsxs('div', {
    className: ['cb-row', expanded && 'cb-expanded', isOpen && group === 'waiting' && 'cb-waiting', closedVerb && 'cb-justdone']
      .filter(Boolean).join(' '),
    style: { '--cb-origin': borderColor(resolvedPin, prefs, profileColor) },
    'aria-busy': busy || undefined,
    children: [
      jsx(RowMark, { pin, closedVerb, group, busy, onDone: () => close('done') }),
      jsxs('div', {
        className: 'cb-body', onClick: () => setExpanded(!expanded),
        children: [
          jsx('button', { type: 'button', className: 'cb-title', 'aria-expanded': expanded, title: expanded ? undefined : title, children: title }),
          subEl,
        ],
      }),
      right,
    ],
  })

  let detailEl = null
  if (expanded) {
    const question = pin.kind && pin.kind !== 'task' ? String(pin.question ?? '').trim() : ''
    const kv = []
    if (pin.unblocks && sub?.label !== 'Unblocks') kv.push(['Unblocks', jsx(RichText, { ctx, text: pin.unblocks })])
    if (pin.waiting_on && sub?.label !== 'Waiting on') kv.push(['Waiting on', pin.waiting_on])
    if (pin.link) kv.push(['Where', jsx(RichText, { ctx, text: pin.link })])
    const check = checkStatus(pin, now)
    if (check) kv.push(['Check', check])
    if (!isOpen && pin.answer_note) kv.push(['Note', pin.answer_note])
    kv.push(['From', jsxs('span', { className: 'inline-flex flex-wrap items-center gap-2', children: [
      jsx(OriginChip, { pin: resolvedPin, profiles }),
      jsx(OriginOpenButton, { pin: resolvedPin }),
    ] })])
    kv.push(['When', metaLine(pin, now).map((seg) =>
      seg.label === 'Answered' ? `Answered: ${seg.ago}` : (seg.ago ? `${seg.label} ${seg.ago}` : seg.label)
    ).join(' \u00B7 ')])

    const controls = !isOpen ? null
      : pin.kind === 'yes_no' ? jsx(YesNoAnswer, { pin, act, busy })
      : pin.kind === 'choice' ? jsx(ChoiceAnswer, { pin, act, busy })
      : pin.kind === 'text' ? jsx(TextAnswer, { pin, act, busy })
      : null

    detailEl = jsxs('div', { className: 'cb-detail', children: [
      question && question !== sub?.text ? jsx('p', { children: jsx(RichText, { ctx, text: question }) }) : null,
      detail ? jsx('p', { children: jsx(RichText, { ctx, text: detail }) }) : null,
      jsx('dl', { className: 'cb-kv', children: kv.flatMap(([k, v]) => [
        jsx('dt', { key: `${k}-k`, children: k }),
        jsx('dd', { key: `${k}-v`, children: v }),
      ]) }),
      controls,
    ].filter(Boolean) })
  }

  const errorLine = error ? jsx('div', { role: 'alert', className: 'cb-err', children: error }) : null
  return jsxs('div', { children: [row, detailEl, errorLine].filter(Boolean) })
}

function FilterBar({ status, onStatus, sort, onSort, counts, trailing }) {
  const tabs = STATUSES.map(([value, label]) =>
    jsxs('button', {
      type: 'button', key: value, className: 'cb-tab', 'aria-pressed': status === value,
      onClick: () => onStatus(value),
      children: [label, value !== 'all' && counts?.[value] ? jsx('span', { className: 'cb-n', children: counts[value] }) : null],
    })
  )
  const sorter = jsx('label', { className: 'cb-sort', children: jsxs('select', {
    'aria-label': 'Sort pins', value: sort, onChange: (e) => onSort(e.target.value),
    children: [
      jsx('option', { value: 'newest', children: 'Newest' }),
      jsx('option', { value: 'oldest', children: 'Oldest' }),
    ],
  }) })
  return jsxs('div', { className: 'cb-bar', children: [...tabs, sorter, trailing].filter(Boolean) })
}

// What an empty tab says: direction, not mood.
export function emptyText(status) {
  if (status === 'open') return 'Nothing waiting on you. Agents pin things here when only you can do them.'
  if (status === 'done') return 'Nothing done yet.'
  if (status === 'dismissed') return 'Nothing dismissed.'
  return 'No pins yet.'
}

// Open pins plus rows closed in the last few seconds (still showing Undo), re-sorted so
// a just-closed row stays where it was.
export function withRecentlyClosed(pins, closed, sort) {
  const list = Array.isArray(pins) ? pins : []
  const ids = new Set(list.map((p) => p.id))
  const extra = Object.values(closed || {}).map((c) => c.pin).filter((p) => p && !ids.has(p.id))
  return extra.length ? sortPins([...list, ...extra], sort) : list
}

function PinList({ ctx, trailing = null }) {
  const [status, setStatus] = useState('open')
  const [sort, setSort] = useState('newest')
  const { pins, counts, loaded, error, reload } = usePins(ctx, status, sort)
  const profiles = useProfiles()
  const prefs = useValue($prefs)
  const [closed, setClosed] = useState({}) // id -> { pin, verb } while its Undo shows
  const timers = useRef(new Map())

  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t)
    timers.current.clear()
  }, [])

  const forget = useCallback((id) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setClosed((c) => {
      if (!c[id]) return c
      const next = { ...c }
      delete next[id]
      return next
    })
  }, [])

  const onClosed = useCallback((pin, verb) => {
    clearTimeout(timers.current.get(pin.id))
    setClosed((c) => ({ ...c, [pin.id]: { pin, verb } }))
    timers.current.set(pin.id, setTimeout(() => forget(pin.id), UNDO_MS))
  }, [forget])

  const bar = jsx(FilterBar, { status, onStatus: setStatus, sort, onSort: setSort, counts, trailing })

  if (!loaded) {
    return jsxs('div', { className: 'cb-inbox', children: [bar, jsx('div', { className: 'cb-empty', children: 'Loading\u2026' })] })
  }

  const banner = error
    ? jsxs('div', { role: 'alert', className: 'cb-banner', children: [
        jsx('span', { children: `Couldn't load the board: ${error}` }),
        jsx('button', { type: 'button', onClick: reload, className: 'cb-btn', children: 'Retry' }),
      ] })
    : null

  const now = Date.now() / 1000
  const shown = status === 'open' ? withRecentlyClosed(pins, closed, sort) : pins
  const rowFor = (pin) => jsx(PinRow, {
    ctx, pin, key: pin.id, profiles, prefs, now,
    onChanged: reload, onClosed, onForget: forget,
    closedVerb: status === 'open' ? closed[pin.id]?.verb : undefined,
  })

  let body
  if (shown.length === 0) {
    // A failed first load has nothing true to show; say so instead of "empty".
    body = error ? null : jsx('div', { className: 'cb-empty', children: emptyText(status) })
  } else if (status === 'open') {
    body = groupPins(shown).map((g) => jsxs('section', {
      key: g.key, 'aria-label': g.label,
      children: [
        jsxs('div', { className: `cb-grp cb-g-${g.key}`, children: [
          jsx('span', { className: `cb-gi cb-gi-${g.key}`, 'aria-hidden': 'true' }),
          g.label,
          jsx('span', { className: 'cb-n', children: g.pins.length }),
        ] }),
        ...g.pins.map(rowFor),
      ],
    }))
  } else {
    body = shown.map(rowFor)
  }

  return jsxs('div', { className: 'cb-inbox', children: [bar, banner, body].filter(Boolean) })
}

function closeCorkboardPage() {
  haptic('tap')
  let activeId = null
  const atom = host.state && host.state.activeSessionId
  if (atom && typeof atom.get === 'function') activeId = atom.get()
  const target = closeTarget(activeId)
  if (target.kind === 'session' && typeof host.openSession === 'function') {
    host.openSession(target.id)
  } else {
    host.navigate('/')
  }
}

function ClosePageButton({ onClose }) {
  return jsx('button', {
    type: 'button',
    'aria-label': 'Close corkboard',
    title: 'Close',
    onClick: onClose,
    className: 'rounded px-1.5 text-base leading-none text-(--ui-text-tertiary) hover:text-(--ui-text)',
    children: '×',
  })
}

function Board({ ctx, headerControls = null, onClose = null, compact = false }) {
  useEffect(() => {
    if (typeof onClose !== 'function') return undefined
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      onClose()
    }
    return ctx.addEventListener(window, 'keydown', onKey)
  }, [ctx, onClose])

  const header = compact
    ? null
    : jsxs('div', { className: 'flex items-center gap-2 px-3 pt-3', children: [
        jsx('div', { className: 'text-sm font-medium', children: 'Corkboard' }),
        headerControls,
      ] })

  return jsxs('div', { className: 'flex h-full flex-col overflow-y-auto', children: [
    header,
    jsx(PinList, { ctx, trailing: compact ? jsx(FoldPaneButton, { ctx }) : null }),
  ].filter(Boolean) })
}

const SIDE_PANE_ID = 'corkboard:side'
const FOLD_ACTION = 'view.toggleRightSidebar'

// The SDK has no "minimize this pane" call. The app's right-side toggle (⌘J)
// folds the outermost column right of the chat, which is where the side pane
// docks. If the pane was dragged elsewhere the toggle hits another column, so
// a fold that leaves the pane visible is undone and reported as unavailable.
export function foldOutcome(canFold, visibleAfter) {
  if (!canFold) return 'unavailable'
  return visibleAfter ? 'undo' : 'folded'
}

function paneVisibleNow() {
  if (typeof host?.paneVisibility !== 'function') return null
  return host.paneVisibility(SIDE_PANE_ID).get()
}

function FoldPaneButton({ ctx }) {
  const [hint, setHint] = useState(false)
  const canFold = typeof ctx?.runAction === 'function' && typeof host?.paneVisibility === 'function'
  if (!canFold) return null
  const fold = () => {
    haptic('tap')
    const first = ctx.runAction(FOLD_ACTION)
    const outcome = foldOutcome(Boolean(first?.ok), paneVisibleNow())
    if (outcome === 'undo') {
      ctx.runAction(FOLD_ACTION)
      setHint(true)
    }
  }
  return jsx('button', {
    type: 'button',
    'aria-label': 'Collapse corkboard',
    title: hint ? 'Can\u2019t collapse here \u2014 use the chevron on the pane\u2019s tab' : 'Collapse (expand from the edge tab or the 📌 count)',
    className: 'grid size-6 place-items-center rounded-md text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
    onClick: fold,
    children: jsx('i', { 'aria-hidden': 'true', className: 'codicon codicon-layout-sidebar-right-off', style: { fontSize: '0.875rem' } }),
  })
}

function revealSidePane() {
  haptic('tap')
  if (typeof host?.revealPane === 'function') {
    host.revealPane(SIDE_PANE_ID)
  } else {
    host.navigate('/corkboard')
  }
}

function CorkboardTabTitle({ ctx }) {
  const { pins, loaded } = usePins(ctx, 'open', 'newest')
  if (!loaded || pins.length === 0) return 'Corkboard'
  return `Corkboard (${pins.length})`
}

function StatusBadge({ ctx }) {
  const { pins, loaded } = usePins(ctx, 'open', 'newest')
  if (!loaded || pins.length === 0) return null
  return jsx('button', {
    type: 'button',
    className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-(--ui-text)',
    onClick: revealSidePane,
    children: `📌 ${pins.length}`,
  })
}

// -- settings page -------------------------------------------------------------

const ORIGIN_KINDS = [
  ['session', 'Chat'],
  ['bot', 'Bot'],
  ['kanban', 'Kanban'],
  ['cli', 'CLI'],
  ['import', 'Imported'],
  ['api', 'API'],
]

function normalizeHex(value) {
  return /^#[0-9a-fA-F]{6}$/.test(value || '') ? value : '#888888'
}

function AppearanceSettings() {
  const prefs = useValue($prefs)
  const setColor = (kind) => (value) => {
    $prefs.set({ ...prefs, colors: { ...prefs.colors, [kind]: value } })
  }
  const toggleBotColors = () => {
    $prefs.set({ ...prefs, botColors: !prefs.botColors })
  }
  const reset = () => {
    $prefs.set({ botColors: true, colors: { ...DEFAULT_ORIGIN_COLORS } })
  }
  return jsxs('div', { className: 'flex flex-col gap-3 p-3', children: [
    jsx('div', { className: 'text-sm font-medium', children: 'Corkboard appearance' }),
    jsxs('div', { className: 'flex flex-col gap-2', children: ORIGIN_KINDS.map(([kind, label]) =>
      jsxs('label', {
        key: kind, className: 'flex items-center justify-between gap-2',
        children: [
          jsx('span', { className: 'text-xs text-(--ui-text-secondary)', children: `${label} border` }),
          jsx('input', { type: 'color', value: normalizeHex(prefs.colors[kind]), onChange: (e) => setColor(kind)(e.target.value) }),
        ],
      })
    ) }),
    jsxs('label', { className: 'flex items-center justify-between gap-2', children: [
      jsx('span', { className: 'text-xs text-(--ui-text-secondary)', children: "Use each bot's colour" }),
      jsx('input', { type: 'checkbox', checked: !!prefs.botColors, onChange: toggleBotColors }),
    ] }),
    jsx('button', { type: 'button', onClick: reset, className: btn(false), children: 'Reset to defaults' }),
  ] })
}

export default {
  id: 'corkboard',
  name: 'Corkboard',
  register(ctx) {
    const removeStyles = installStyles()
    ctx.onDispose?.(removeStyles)
    $prefs.set(mergePrefs(readStorage(ctx, 'appearance', null)))
    const unsub = $prefs.listen((next) => writeStorage(ctx, 'appearance', next))
    ctx.onDispose?.(() => unsub())

    const settingsPage = {
      id: 'appearance',
      title: 'Corkboard',
      icon: 'pin',
      render: () => jsx(AppearanceSettings, {}),
    }
    if (typeof ctx.registerSettingsPage === 'function') {
      ctx.registerSettingsPage(settingsPage)
    } else {
      ctx.register({
        area: SETTINGS_PLUGINS_AREA,
        id: 'appearance',
        title: 'Corkboard',
        data: { icon: 'pin' },
        render: () => jsx(AppearanceSettings, {}),
      })
    }

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/corkboard' },
        render: () => jsx(Board, {
          ctx,
          onClose: closeCorkboardPage,
          headerControls: jsx('div', { className: 'ml-auto flex items-center gap-2', children: [
            jsx(ClosePageButton, { onClose: closeCorkboardPage }),
          ] }),
        }),
      },
      {
        id: 'side',
        area: 'panes',
        title: 'Corkboard',
        data: {
          tabTitle: () => jsx(CorkboardTabTitle, { ctx }),
          tabTitleText: () => 'Corkboard',
          placement: 'main',
          // A one-shot adoption hint, NOT `enforce`: the owner can drag the
          // pane elsewhere and that placement persists with the layout. The
          // dock only steers the pane's first entry beside the chat.
          dock: { pane: 'workspace', pos: 'right' },
          // Start expanded (owner's order), then collapse/expand persists.
          defaultCollapsed: false,
          // The ✕ must never disable the plugin. `hideOnly` means the tab
          // never grows a ✕ — fold (the header chevron) replaces Close, so
          // the single-pane "Close disables the plugin" path is never reached.
          hideOnly: true,
          width: '320px',
        },
        render: () => jsx(Board, { ctx, compact: true }),
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: '/corkboard', label: 'Corkboard', codicon: 'pin' },
      },
      {
        id: 'count',
        area: STATUSBAR_AREAS.right,
        order: 130,
        render: () => jsx(StatusBadge, { ctx }),
      },
    ])
  },
}
