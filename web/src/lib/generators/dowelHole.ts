import type { DowelHoleParams } from '../../types/editor'
import { makerjs, modelToSvg } from './makerjs'

export function generateDowelHole(params: DowelHoleParams): string {
  const { diameter, rowCount, colCount, rowSpacing, colSpacing, matchToolDiameter } = params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mx = makerjs as any

  // When matchToolDiameter is true, the hole is exactly one bit wide — just
  // plunge straight down.  We emit tiny circles (0.1 mm radius) as point
  // markers; the 'plunge' engraveType tells the gcode pipeline to drill.
  const radius = matchToolDiameter ? 0.1 : diameter / 2

  const models: Record<string, object> = {}
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const key = `hole_${r}_${c}`
      models[key] = mx.model.move(
        new mx.models.Ellipse(radius, radius),
        [c * colSpacing, r * rowSpacing],
      )
    }
  }

  return modelToSvg({ models })
}
