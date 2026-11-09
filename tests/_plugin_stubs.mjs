// Node ESM loader that stubs the only three specifiers a disk plugin may import,
// so `tests/links.test.mjs` can import `desktop/plugin.js` without the Hermes SDK.
const STUBS = new Map()
STUBS.set('react', 'export const useCallback = null; export const useEffect = null; export const useState = null;')
STUBS.set('react/jsx-runtime', 'export const jsx = null; export const jsxs = null;')
STUBS.set('@hermes/plugin-sdk', [
  'export const host = null',
  'export const haptic = null',
  'export const ROUTES_AREA = null',
  'export const SIDEBAR_NAV_AREA = null',
  'export const STATUSBAR_AREAS = null',
].join('; '))

export async function resolve(specifier, context, nextResolve) {
  if (STUBS.has(specifier)) {
    return {
      url: 'data:text/javascript;base64,' + Buffer.from(STUBS.get(specifier)).toString('base64'),
      shortCircuit: true,
    }
  }
  return nextResolve(specifier, context)
}
