// Minimal @hermes/plugin-sdk stand-in for rendering the real plugin outside the app.
import { useSyncExternalStore } from 'react'
export const host = {
  openSession: async () => {}, navigate: () => {}, revealPane: () => {},
  paneVisibility: () => ({ get: () => true }),
  request: async (m) => (m === 'profiles.list' ? { profiles: [{ name: 'default', display_name: 'Hermes' }] } : {}),
}
export const haptic = () => {}
export const atom = (init) => {
  let v = init; const ls = new Set()
  return { get: () => v, set: (n) => { v = n; ls.forEach((l) => l(v)) }, listen: (l) => { ls.add(l); return () => ls.delete(l) } }
}
export const useValue = (a) => useSyncExternalStore((cb) => a.listen(cb), () => a.get())
export const profileColor = () => null
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'nav'
export const STATUSBAR_AREAS = { right: 'sb-right' }
export const SETTINGS_PLUGINS_AREA = 'settings'
