// Corkboard desktop half: a docked pane, a full page + sidebar nav, and a status-bar
// open-count badge. Data comes from the plugin's own backend via ctx.rest('/pins'),
// and it refetches on the `plugin.corkboard.pins.changed` gateway event. No JSX (disk
// plugin), never auto-focuses or navigates on events.

import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useState } from 'react'
import { host, haptic, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS } from '@hermes/plugin-sdk'

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

function usePins(ctx, status = 'open', sort = 'newest') {
  const [pins, setPins] = useState([])
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    try {
      const path = `/pins?status=${encodeURIComponent(status)}&sort=${encodeURIComponent(sort)}`
      const data = await ctx.rest(path)
      const list = Array.isArray(data) ? data : (data && data.pins) || []
      setPins(list)
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

function PinRow({ ctx, pin, onChanged }) {
  const isOpen = pin.status === 'open'
  const now = Date.now() / 1000

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

  return jsxs('div', { className: 'rounded border border-(--ui-border) p-2 flex flex-col gap-1.5', children: [
    title,
    where,
    meta,
    closed,
    age,
    actions,
  ].filter(Boolean) })
}

function FilterBar({ status, onStatus, sort, onSort }) {
  const tabs = STATUSES.map(([value, label]) =>
    jsx('button', {
      type: 'button', key: value, onClick: () => onStatus(value),
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
      : jsxs('div', { className: 'flex flex-col gap-2 px-3 pb-3', children: pins.map((pin) => jsx(PinRow, { ctx, pin, onChanged: reload, key: pin.id })) }),
  ] })
}

function CorkboardView({ ctx }) {
  return jsxs('div', { className: 'flex h-full flex-col overflow-y-auto', children: [
    jsx('div', { className: 'px-3 pt-3 text-sm font-medium', children: 'Corkboard' }),
    jsx(PinList, { ctx }),
  ] })
}

function StatusBadge({ ctx }) {
  const { pins, loaded } = usePins(ctx, 'open', 'newest')
  if (!loaded) return null
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

export default {
  id: 'corkboard',
  name: 'Corkboard',
  register(ctx) {
    ctx.registerMany([
      {
        id: 'pane',
        area: 'panes',
        title: 'Corkboard',
        data: { placement: 'right', width: '300px' },
        render: () => jsx(CorkboardView, { ctx }),
      },
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/corkboard' },
        render: () => jsx(CorkboardView, { ctx }),
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
