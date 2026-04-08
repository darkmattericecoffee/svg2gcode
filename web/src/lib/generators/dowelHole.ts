import type { DowelHoleParams } from '../../types/editor'
import { makerjs, modelToSvg } from './makerjs'

export function generateDowelHole(params: DowelHoleParams): string {
  const { diameter, rowCount, colCount, rowSpacing, colSpacing, matchToolDiameter } = params

  if (matchToolDiameter) {
    const markerRadius = 0.1
    const circles: string[] = []

    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < colCount; c++) {
        circles.push(
          `<circle cx="${c * colSpacing}" cy="${r * rowSpacing}" r="${markerRadius}" />`,
        )
      }
    }

    return [
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#000" stroke-width="0.2">',
      ...circles,
      '</svg>',
    ].join('')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mx = makerjs as any

  const radius = diameter / 2

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
