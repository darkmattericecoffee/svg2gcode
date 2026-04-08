// Thin wrapper around makerjs. Vite pre-bundles makerjs (CJS→ESM) via optimizeDeps.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — makerjs ships CJS; Vite converts it to ESM at dev time
import * as makerjs from 'makerjs'

export { makerjs }

export function modelToSvg(model: object): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mx = makerjs as any
  return mx.exporter.toSVG(model, {
    units: mx.unitType.Millimeter,
    strokeOnly: true,
  }) as string
}
