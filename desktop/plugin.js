// Corkboard desktop half: one home — a full page + sidebar nav — plus an "open beside
// chat" workspace tab and a status-bar open-count badge. Data comes from the plugin's
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

function botName(profile) {
  return botTitleOf(profile) || String(profile?.display_name || profile?.name || '').trim()
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
    ? 'rounded px-2 py-1 text-xs font-medium bg-(--ui-accent) text-(--ui-accent-fg)'
    : 'rounded px-2 py-1 text-xs border border-(--ui-border) text-(--ui-text-secondary) hover:bg-(--ui-surface)'
}

function inputCls() {
  return 'min-w-0 flex-1 rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1 text-xs'
}

const STATUSES = [
  ['open', 'Open'],
  ['done', 'Acknowledged'],
  ['dismissed', 'Dismissed'],
  ['all', 'All'],
]

const avatarCache = new Map() // profileName -> { data: string|null, settled: boolean }

function usePins(ctx, status = 'open', sort = 'newest') {
  const [pins, setPins] = useState([])
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    try {
      const data = await ctx.rest('/pins?status=&sort=')
      const list = Array.isArray(data) ? data : (data && data.pins) || []
      setPins(sortPins(filterPins(list, status), sort))
    } catch (_err) {
      setPins([])
    } finally {
      setLoaded(true)
    }
  }, [ctx, status, sort])

  useEffect(() => { reload() }, [reload])

  useEffect(() => ctx.onEvent(PIN_CHANGED, () => reload()), [ctx, reload])

  return { pins, loaded, reload }
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

function TaskControls({ ctx, pin, onChanged }) {
  const done = async () => {
    await ctx.rest(`/pins/${pin.id}/done`, { method: 'POST' })
    haptic('tap')
    onChanged()
  }
  return jsx('button', { type: 'button', onClick: done, className: btn(true), children: 'Done' })
}

function YesNoAnswer({ ctx, pin, onChanged }) {
  const [note, setNote] = useState('')
  const send = (value) => async () => {
    await ctx.rest(`/pins/${pin.id}/answer`, { method: 'POST', body: { answer: value, note: note || null } })
    haptic('tap')
    setNote('')
    onChanged()
  }
  return jsxs('div', { className: 'flex flex-wrap items-center gap-1.5', children: [
    jsx('button', { type: 'button', onClick: send('yes'), className: btn(true), children: 'Yes' }),
    jsx('button', { type: 'button', onClick: send('no'), className: btn(false), children: 'No' }),
    jsx('input', {
      type: 'text', value: note, placeholder: 'note (optional)', className: inputCls(),
      onChange: (e) => setNote(e.target.value),
    }),
  ] })
}

function ChoiceAnswer({ ctx, pin, onChanged }) {
  const [other, setOther] = useState('')
  const send = (value) => async () => {
    await ctx.rest(`/pins/${pin.id}/answer`, { method: 'POST', body: { answer: value } })
    haptic('tap')
    onChanged()
  }
  const submitOther = async () => {
    if (!other.trim()) return
    await ctx.rest(`/pins/${pin.id}/answer`, { method: 'POST', body: { answer: other.trim() } })
    haptic('tap')
    setOther('')
    onChanged()
  }
  const choices = Array.isArray(pin.choices) ? pin.choices : []
  const buttons = choices.map((choice, i) =>
    jsx('button', {
      type: 'button', key: choice, onClick: send(choice), className: btn(i === 0),
      children: i === 0 ? `Recommended: ${choice}` : choice,
    })
  )
  return jsxs('div', { className: 'flex flex-col gap-1.5', children: [
    jsxs('div', { className: 'flex flex-wrap gap-1.5', children: buttons }),
    jsxs('div', { className: 'flex gap-1.5', children: [
      jsx('input', {
        type: 'text', value: other, placeholder: 'Other', className: inputCls(),
        onChange: (e) => setOther(e.target.value),
      }),
      jsx('button', { type: 'button', onClick: submitOther, className: btn(false), children: 'Send' }),
    ] }),
  ] })
}

function TextAnswer({ ctx, pin, onChanged }) {
  const [value, setValue] = useState('')
  const submit = async () => {
    if (!value.trim()) return
    await ctx.rest(`/pins/${pin.id}/answer`, { method: 'POST', body: { answer: value.trim() } })
    haptic('tap')
    setValue('')
    onChanged()
  }
  return jsxs('div', { className: 'flex gap-1.5', children: [
    jsx('input', {
      type: 'text', value, placeholder: pin.placeholder || 'Answer…', className: inputCls(),
      onChange: (e) => setValue(e.target.value),
    }),
    jsx('button', { type: 'button', onClick: submit, className: btn(true), children: 'Send' }),
  ] })
}

function DismissButton({ ctx, pin, onChanged }) {
  const dismiss = async () => {
    await ctx.rest(`/pins/${pin.id}/dismiss`, { method: 'POST' })
    haptic('tap')
    onChanged()
  }
  return jsx('button', {
    type: 'button', onClick: dismiss,
    className: 'text-[0.6875rem] text-(--ui-text-tertiary) hover:underline',
    children: 'dismiss',
  })
}

// -- origin UI -----------------------------------------------------------------

function BotAvatar({ name, profile }) {
  const image = useBotAvatar(name)
  if (image) {
    return jsx('img', { src: image, className: 'h-4 w-4 rounded-full object-cover', alt: '' })
  }
  const initial = (botName(profile) || name || '?').charAt(0).toUpperCase()
  const color = typeof profileColor === 'function' ? profileColor(name) : null
  return jsx('span', {
    className: 'inline-flex h-4 w-4 items-center justify-center rounded-full text-[0.625rem] font-medium text-white',
    style: { backgroundColor: color || '#888888' },
    children: initial,
  })
}

function OriginChip({ pin, profiles }) {
  const kind = pin.origin_kind
  const label = originLabel(pin)
  if (kind !== 'bot') {
    return jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: label })
  }
  const profile = profilesByName(profiles).get(pin.origin_profile) || null
  const name = botName(profile)
  return jsxs('span', { className: 'inline-flex items-center gap-1', children: [
    jsx(BotAvatar, { name: pin.origin_profile, profile }),
    jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: label }),
    name ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: name }) : null,
  ].filter(Boolean) })
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

  const controls = !isOpen ? null
    : pin.kind === 'yes_no' ? jsx(YesNoAnswer, { ctx, pin, onChanged })
    : pin.kind === 'choice' ? jsx(ChoiceAnswer, { ctx, pin, onChanged })
    : pin.kind === 'text' ? jsx(TextAnswer, { ctx, pin, onChanged })
    : jsx(TaskControls, { ctx, pin, onChanged })

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

  const where = pin.link && !url
    ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `where: ${plainText(pin.link)}` })
    : null

  const question = pin.question
    ? jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: pin.question })
    : null

  const unblocks = pin.unblocks
    ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `unblocks: ${pin.unblocks}` })
    : null

  const meta = (question || unblocks)
    ? jsxs('div', { className: 'flex flex-col gap-0.5', children: [question, unblocks].filter(Boolean) })
    : null

  let closed = null
  if (!isOpen) {
    const closedAt = pin.answered_at || pin.closed_at || pin.done_at
    if (pin.answer) {
      closed = jsxs('div', { className: 'flex flex-col gap-0.5', children: [
        jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: `answer: ${pin.answer}` }),
        closedAt ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: timeAgo(closedAt, now) }) : null,
      ] })
    } else if (closedAt) {
      const label = pin.status === 'done' ? 'done' : 'dismissed'
      closed = jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${label} ${timeAgo(closedAt, now)}` })
    }
  }

  const age = jsx('div', {
    className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
    title: pin.created_at ? new Date(pin.created_at * 1000).toLocaleString() : undefined,
    children: timeAgo(pin.created_at, now),
  })

  const actions = isOpen
    ? jsxs('div', { className: 'flex items-center gap-2', children: [
        controls,
        jsx(DismissButton, { ctx, pin, onChanged }),
      ].filter(Boolean) })
    : null

  const border = borderColor(resolvedPin, prefs, profileColor)

  return jsxs('div', {
    className: 'rounded border p-2 flex flex-col gap-1.5',
    style: { borderColor: border },
    children: [
      title,
      origin,
      where,
      meta,
      closed,
      age,
      actions,
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

function PinList({ ctx }) {
  const [status, setStatus] = useState('open')
  const [sort, setSort] = useState('newest')
  const { pins, loaded, reload } = usePins(ctx, status, sort)
  const profiles = useProfiles()
  const prefs = useValue($prefs)

  if (!loaded) {
    return jsx('div', { className: 'p-3 text-xs text-(--ui-text-tertiary)', children: 'Loading…' })
  }

  const label = status === 'open' ? 'open'
    : status === 'done' ? 'acknowledged'
    : status === 'dismissed' ? 'dismissed'
    : 'pins'

  return jsxs('div', { className: 'flex flex-col gap-2', children: [
    jsx(FilterBar, { status, onStatus: setStatus, sort, onSort: setSort }),
    jsx('div', { className: 'px-3 text-[0.6875rem] text-(--ui-text-tertiary)', children: `${pins.length} ${label}` }),
    pins.length === 0
      ? jsx('div', { className: 'px-3 text-xs text-(--ui-text-tertiary)', children: 'Corkboard is empty.' })
      : jsxs('div', { className: 'flex flex-col gap-2 px-3 pb-3', children: pins.map((pin) => jsx(PinRow, { ctx, pin, onChanged: reload, key: pin.id, profiles, prefs })) }),
  ] })
}

function OpenBesideButton({ ctx }) {
  if (typeof host.openWorkspace !== 'function') return null
  return jsx('button', {
    type: 'button',
    className: btn(false),
    onClick: () => {
      haptic('tap')
      host.openWorkspace('corkboard', {
        title: 'Corkboard',
        minWidth: 320,
        render: () => jsx(Board, { ctx }),
        onClose: () => {},
      })
    },
    children: 'Open beside chat',
  })
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

function Board({ ctx, headerControls = null, onClose = null }) {
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

  return jsxs('div', { className: 'flex h-full flex-col overflow-y-auto', children: [
    jsxs('div', { className: 'flex items-center gap-2 px-3 pt-3', children: [
      jsx('div', { className: 'text-sm font-medium', children: 'Corkboard' }),
      headerControls,
    ] }),
    jsx(PinList, { ctx }),
  ] })
}

function StatusBadge({ ctx }) {
  const { pins, loaded } = usePins(ctx, 'open', 'newest')
  if (!loaded || pins.length === 0) return null
  return jsx('button', {
    type: 'button',
    className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-(--ui-text)',
    onClick: () => {
      haptic('tap')
      host.navigate('/corkboard')
    },
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
          headerControls: jsxs('div', { className: 'ml-auto flex items-center gap-2', children: [
            jsx(OpenBesideButton, { ctx }),
            jsx(ClosePageButton, { onClose: closeCorkboardPage }),
          ] }),
        }),
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
