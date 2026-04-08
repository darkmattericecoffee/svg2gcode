import type { TenonParams } from '../../types/editor'
import { makerjs, modelToSvg } from './makerjs'

export function generateTenon(params: TenonParams): string {
  const { width, height, rowCount, colCount, rowSpacing, colSpacing, matchToolWidth } = params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mx = makerjs as any

  // When matchToolWidth is true, we only need center lines — the router bit
  // diameter will naturally create the slot width.
  if (matchToolWidth) {
    const paths: Record<string, object> = {}
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < colCount; c++) {
        const key = `tenon_${r}_${c}`
        const ox = c * colSpacing
        const oy = r * rowSpacing
        paths[key] = new mx.paths.Line([ox, oy], [ox, oy + height])
      }
    }
    return modelToSvg({ paths })
  }

  // Pill / stadium shape: rounded ends matching the router profile.
  // Corner radius = half the shorter dimension for a full pill.
  const cornerRadius = Math.min(width, height) / 2

  const models: Record<string, object> = {}
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const key = `tenon_${r}_${c}`
      models[key] = mx.model.move(
        new mx.models.RoundRectangle(width, height, cornerRadius),
        [c * colSpacing, r * rowSpacing],
      )
    }
  }

  return modelToSvg({ models })
}
