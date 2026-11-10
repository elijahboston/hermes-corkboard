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
import { useCallback, useEffect, useState } from 'react'
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
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    try {
      const data = await ctx.rest('/pins?status=all&sort=newest')
      const list = Array.isArray(data) ? data : (data && data.pins) || []
      setPins(questionsFirst(sortPins(filterPins(list, status), sort)))
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

  return { pins, loaded, error, reload }
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

function TaskControls({ act, busy }) {
  return jsx('button', {
    type: 'button', disabled: busy, onClick: () => act('done'), className: btn(true), children: 'Done',
  })
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

function LinkButton({ label, onClick, busy }) {
  return jsx('button', {
    type: 'button', disabled: busy, onClick,
    className: 'text-[0.6875rem] text-(--ui-text-tertiary) hover:underline disabled:opacity-50',
    children: label,
  })
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

// -- pin row -------------------------------------------------------------------

function PinRow({ ctx, pin, onChanged, profiles, prefs }) {
  const isOpen = pin.status === 'open'
  const now = Date.now() / 1000
  const resolvedPin = resolvePinOrigin(pin, profiles)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // One request at a time per card; failures stay on the card until the next attempt.
  const act = async (verb, body) => {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      await ctx.rest(`/pins/${pin.id}/${verb}`, body ? { method: 'POST', body } : { method: 'POST' })
      haptic('tap')
      onChanged()
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const controls = !isOpen ? null
    : pin.kind === 'yes_no' ? jsx(YesNoAnswer, { pin, act, busy })
    : pin.kind === 'choice' ? jsx(ChoiceAnswer, { pin, act, busy })
    : pin.kind === 'text' ? jsx(TextAnswer, { pin, act, busy })
    : jsx(TaskControls, { pin, act, busy })

  const titleText = plainText(pin.title)
  const url = linkTarget(pin.link)
  const title = url
    ? jsx('button', {
        type: 'button',
        onClick: (e) => { e.preventDefault(); ctx.os.openExternal(url) },
        className: 'text-left font-medium text-(--ui-text) hover:underline',
        children: titleText,
      })
    : jsx('span', { className: 'font-medium text-(--ui-text)', children: titleText })

  const origin = jsxs('div', { className: 'flex flex-wrap items-center gap-2', children: [
    jsx(OriginChip, { pin: resolvedPin, profiles }),
    jsx(OriginOpenButton, { pin: resolvedPin }),
  ].filter(Boolean) })

  const small = 'text-[0.6875rem] text-(--ui-text-tertiary)'

  const where = pin.link && !url
    ? jsx('div', { className: small, children: `Where: ${plainText(pin.link)}` })
    : null

  const question = pin.question
    ? jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: pin.question })
    : null

  const unblocks = pin.unblocks
    ? jsx('div', { className: small, children: `Unblocks: ${pin.unblocks}` })
    : null

  const check = checkStatus(pin, now)
  const checkLine = check
    ? jsx('div', { className: small, title: isoTime(pin.last_checked_at) || undefined, children: check })
    : null

  const note = !isOpen && pin.answer_note
    ? jsx('div', { className: small, children: `Note: ${pin.answer_note}` })
    : null

  const meta = (question || unblocks || checkLine || note)
    ? jsxs('div', { className: 'flex flex-col gap-0.5', children: [question, unblocks, checkLine, note].filter(Boolean) })
    : null

  const stamps = metaLine(pin, now)
  const ageLine = jsx('div', {
    className: `flex flex-wrap items-center gap-x-1 ${small}`,
    children: stamps.map((seg, i) => jsxs('span', {
      key: i,
      children: [
        i > 0 ? jsx('span', { children: ' · ' }) : null,
        jsx('span', {
          title: seg.iso || undefined,
          children: seg.label === 'Answered' ? `Answered: ${seg.ago}` : (seg.ago ? `${seg.label} ${seg.ago}` : seg.label),
        }),
      ],
    })),
  })

  const actions = isOpen
    ? jsxs('div', { className: 'flex flex-wrap items-center gap-2', children: [
        controls,
        jsx(LinkButton, { label: 'Dismiss', busy, onClick: () => act('dismiss') }),
      ].filter(Boolean) })
    : pin.status === 'dismissed'
      ? jsx('div', { children: jsx(LinkButton, { label: 'Reopen', busy, onClick: () => act('reopen') }) })
      : null

  const errorLine = error
    ? jsx('div', { role: 'alert', className: 'text-[0.6875rem] text-(--ui-red)', children: error })
    : null

  const border = borderColor(resolvedPin, prefs, profileColor)

  return jsxs('div', {
    className: 'rounded border p-2 flex flex-col gap-1.5',
    style: { borderColor: border },
    'aria-busy': busy || undefined,
    children: [
      title,
      origin,
      where,
      meta,
      ageLine,
      actions,
      errorLine,
    ].filter(Boolean),
  })
}

function FilterBar({ status, onStatus, sort, onSort }) {
  const tabs = STATUSES.map(([value, label]) =>
    jsx('button', {
      type: 'button', key: value, onClick: () => onStatus(value),
      'aria-pressed': status === value,
      className: status === value
        ? 'rounded px-2 py-0.5 text-[0.6875rem] font-medium bg-(--ui-accent) text-(--ui-accent-fg)'
        : 'rounded px-2 py-0.5 text-[0.6875rem] text-(--ui-text-secondary) hover:bg-(--ui-surface)',
      children: label,
    })
  )
  return jsxs('div', { className: 'flex flex-wrap items-center gap-1 px-3 pt-2', children: [
    ...tabs,
    jsx('button', {
      type: 'button',
      onClick: () => onSort(sort === 'newest' ? 'oldest' : 'newest'),
      className: 'ml-auto rounded px-2 py-0.5 text-[0.6875rem] text-(--ui-text-secondary) hover:bg-(--ui-surface)',
      children: sort === 'newest' ? 'Newest' : 'Oldest',
    }),
  ] })
}

// What an empty tab says: direction, not mood.
export function emptyText(status) {
  if (status === 'open') return 'Nothing waiting on you. Agents pin things here when only you can do them.'
  if (status === 'done') return 'Nothing done yet.'
  if (status === 'dismissed') return 'Nothing dismissed.'
  return 'No pins yet.'
}

function PinList({ ctx }) {
  const [status, setStatus] = useState('open')
  const [sort, setSort] = useState('newest')
  const { pins, loaded, error, reload } = usePins(ctx, status, sort)
  const profiles = useProfiles()
  const prefs = useValue($prefs)

  if (!loaded) {
    return jsx('div', { className: 'p-3 text-xs text-(--ui-text-tertiary)', children: 'Loading…' })
  }

  const label = status === 'open' ? 'open'
    : status === 'done' ? 'done'
    : status === 'dismissed' ? 'dismissed'
    : 'pins'

  const banner = error
    ? jsxs('div', { role: 'alert', className: 'mx-3 flex items-center gap-2 rounded border border-(--ui-border) px-2 py-1 text-[0.6875rem] text-(--ui-red)', children: [
        jsx('span', { className: 'min-w-0 flex-1', children: `Couldn't load the board: ${error}` }),
        jsx('button', { type: 'button', onClick: reload, className: btn(false), children: 'Retry' }),
      ] })
    : null

  // A failed first load has nothing true to show; say so instead of "empty".
  const body = pins.length === 0
    ? (error ? null : jsx('div', { className: 'px-3 text-xs text-(--ui-text-tertiary)', children: emptyText(status) }))
    : jsxs('div', { className: 'flex flex-col gap-2 px-3 pb-3', children: pins.map((pin) => jsx(PinRow, { ctx, pin, onChanged: reload, key: pin.id, profiles, prefs })) })

  return jsxs('div', { className: 'flex flex-col gap-2', children: [
    jsx(FilterBar, { status, onStatus: setStatus, sort, onSort: setSort }),
    banner,
    jsx('div', { className: 'px-3 text-[0.6875rem] text-(--ui-text-tertiary)', children: `${pins.length} ${label}` }),
    body,
  ].filter(Boolean) })
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
    ? jsx('div', { className: 'flex items-center justify-end px-2 pt-1.5', children: jsx(FoldPaneButton, { ctx }) })
    : jsxs('div', { className: 'flex items-center gap-2 px-3 pt-3', children: [
        jsx('div', { className: 'text-sm font-medium', children: 'Corkboard' }),
        headerControls,
      ] })

  return jsxs('div', { className: 'flex h-full flex-col overflow-y-auto', children: [
    header,
    jsx(PinList, { ctx }),
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
