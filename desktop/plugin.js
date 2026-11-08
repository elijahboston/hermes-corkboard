// Corkboard desktop half: a docked pane, a full page + sidebar nav, and a status-bar
// open-count badge. Data comes from the plugin's own backend via ctx.rest('/pins'),
// and it refetches on the `plugin.corkboard.pins.changed` gateway event. No JSX (disk
// plugin), never auto-focuses or navigates on events.

import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useState } from 'react'
import { host, haptic, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS } from '@hermes/plugin-sdk'

const PIN_CHANGED = 'plugin.corkboard.pins.changed'

function btn(primary) {
  return primary
    ? 'rounded px-2 py-1 text-xs font-medium bg-(--ui-accent) text-(--ui-accent-fg)'
    : 'rounded px-2 py-1 text-xs border border-(--ui-border) text-(--ui-text-secondary) hover:bg-(--ui-surface)'
}

function inputCls() {
  return 'min-w-0 flex-1 rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1 text-xs'
}

function usePins(ctx) {
  const [pins, setPins] = useState([])
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    try {
      const data = await ctx.rest('/pins')
      const list = Array.isArray(data) ? data : (data && data.pins) || []
      setPins(list)
    } catch (_err) {
      setPins([])
    } finally {
      setLoaded(true)
    }
  }, [ctx])

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
  const controls = pin.kind === 'yes_no' ? jsx(YesNoAnswer, { ctx, pin, onChanged })
    : pin.kind === 'choice' ? jsx(ChoiceAnswer, { ctx, pin, onChanged })
    : pin.kind === 'text' ? jsx(TextAnswer, { ctx, pin, onChanged })
    : jsx(TaskControls, { ctx, pin, onChanged })

  const title = pin.link
    ? jsx('a', { href: pin.link, className: 'font-medium text-(--ui-text) hover:underline', children: pin.title })
    : jsx('span', { className: 'font-medium text-(--ui-text)', children: pin.title })

  const question = pin.question
    ? jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: pin.question })
    : null

  const unblocks = pin.unblocks
    ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `unblocks: ${pin.unblocks}` })
    : null

  const meta = (question || unblocks)
    ? jsxs('div', { className: 'flex flex-col gap-0.5', children: [question, unblocks].filter(Boolean) })
    : null

  return jsxs('div', { className: 'rounded border border-(--ui-border) p-2 flex flex-col gap-1.5', children: [
    title,
    meta,
    jsxs('div', { className: 'flex items-center gap-2', children: [controls, jsx(DismissButton, { ctx, pin, onChanged })] }),
  ] })
}

function PinList({ ctx }) {
  const { pins, loaded, reload } = usePins(ctx)
  if (!loaded) {
    return jsx('div', { className: 'p-3 text-xs text-(--ui-text-tertiary)', children: 'Loading…' })
  }
  if (pins.length === 0) {
    return jsx('div', { className: 'p-3 text-xs text-(--ui-text-tertiary)', children: 'Corkboard is empty.' })
  }
  return jsxs('div', { className: 'flex flex-col gap-2 p-3', children: [
    jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `${pins.length} open` }),
    ...pins.map((pin) => jsx(PinRow, { ctx, pin, onChanged: reload, key: pin.id })),
  ] })
}

function CorkboardView({ ctx }) {
  return jsxs('div', { className: 'flex h-full flex-col overflow-y-auto', children: [
    jsx('div', { className: 'px-3 pt-3 text-sm font-medium', children: 'Corkboard' }),
    jsx(PinList, { ctx }),
  ] })
}

function StatusBadge({ ctx }) {
  const { pins, loaded } = usePins(ctx)
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
