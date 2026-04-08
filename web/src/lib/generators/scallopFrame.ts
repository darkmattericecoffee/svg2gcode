import type { ScallopFrameParams } from '../../types/editor'
import { makerjs, modelToSvg } from './makerjs'

export interface ScallopLayout {
  width: number
  height: number
  scallopSize: number
  horizontalCount: number
  verticalCount: number
}

function roundGeometry(value: number): number {
  return Math.round(value * 1000) / 1000
}

function getCandidateScallopSizes(
  targetWidth: number,
  targetHeight: number,
  minScallopSize: number,
  horizontalCount: number,
  verticalCount: number,
): number[] {
  const candidates = [
    minScallopSize,
    targetWidth / horizontalCount,
    targetHeight / verticalCount,
    (targetWidth + targetHeight) / (horizontalCount + verticalCount),
  ]
  return Array.from(new Set(
    candidates
      .filter((candidate) => Number.isFinite(candidate))
      .map((candidate) => Math.max(minScallopSize, candidate)),
  ))
}

export function resolveScallopLayout(
  targetWidth: number,
  targetHeight: number,
  minScallopSize: number,
): ScallopLayout {
  const safeMinSize = Math.max(1, minScallopSize)
  const safeTargetWidth = Math.max(safeMinSize * 2, targetWidth)
  const safeTargetHeight = Math.max(safeMinSize * 2, targetHeight)

  let best: ScallopLayout | null = null
  let bestError = Number.POSITIVE_INFINITY

  const maxHorizontalCount = Math.max(2, Math.ceil(safeTargetWidth / safeMinSize) + 3)
  const maxVerticalCount = Math.max(2, Math.ceil(safeTargetHeight / safeMinSize) + 3)

  for (let horizontalCount = 2; horizontalCount <= maxHorizontalCount; horizontalCount++) {
    for (let verticalCount = 2; verticalCount <= maxVerticalCount; verticalCount++) {
      const candidateSizes = getCandidateScallopSizes(
        safeTargetWidth,
        safeTargetHeight,
        safeMinSize,
        horizontalCount,
        verticalCount,
      )

      for (const scallopSize of candidateSizes) {
        const width = horizontalCount * scallopSize
        const height = verticalCount * scallopSize
        const error = Math.abs(width - safeTargetWidth) + Math.abs(height - safeTargetHeight)

        if (
          error < bestError - 0.0001 ||
          (
            Math.abs(error - bestError) <= 0.0001 &&
            (
              best == null ||
              scallopSize < best.scallopSize - 0.0001 ||
              (
                Math.abs(scallopSize - best.scallopSize) <= 0.0001 &&
                horizontalCount * verticalCount > best.horizontalCount * best.verticalCount
              )
            )
          )
        ) {
          bestError = error
          best = {
            width: roundGeometry(width),
            height: roundGeometry(height),
            scallopSize: roundGeometry(scallopSize),
            horizontalCount,
            verticalCount,
          }
        }
      }
    }
  }

  return best ?? {
    width: roundGeometry(safeMinSize * 2),
    height: roundGeometry(safeMinSize * 2),
    scallopSize: roundGeometry(safeMinSize),
    horizontalCount: 2,
    verticalCount: 2,
  }
}

export function normalizeScallopFrameParams(params: ScallopFrameParams): ScallopFrameParams {
  const layout = resolveScallopLayout(params.width, params.height, params.minScallopSize)
  return {
    ...params,
    width: layout.width,
    height: layout.height,
    minScallopSize: Math.max(1, roundGeometry(params.minScallopSize)),
  }
}

export function generateScallopFrame(params: ScallopFrameParams): string {
  const normalized = normalizeScallopFrameParams(params)
  const layout = resolveScallopLayout(normalized.width, normalized.height, normalized.minScallopSize)
  const radius = layout.scallopSize / 2
  const insetWidth = Math.max(layout.width - layout.scallopSize, 0.001)
  const insetHeight = Math.max(layout.height - layout.scallopSize, 0.001)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mx = makerjs as any

  let model = mx.model.move(
    new mx.models.RoundRectangle(insetWidth, insetHeight, 0),
    [radius, radius],
  )

  const unionCircle = (x: number, y: number) => {
    model = mx.model.combineUnion(
      model,
      mx.model.move(new mx.models.Ellipse(radius, radius), [x, y]),
    )
  }

  for (let col = 0; col < layout.horizontalCount; col++) {
    const x = radius + col * layout.scallopSize
    unionCircle(x, radius)
    unionCircle(x, layout.height - radius)
  }

  for (let row = 1; row < layout.verticalCount - 1; row++) {
    const y = radius + row * layout.scallopSize
    unionCircle(radius, y)
    unionCircle(layout.width - radius, y)
  }

  return modelToSvg(model)
}
