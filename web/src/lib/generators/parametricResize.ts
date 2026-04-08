import type { GeneratorParams } from '../../types/editor'
import { normalizeScallopFrameParams } from './scallopFrame'

export function normalizeGeneratorParams(params: GeneratorParams): GeneratorParams {
  if (params.kind === 'scallopFrame') {
    return normalizeScallopFrameParams(params)
  }
  return params
}

export function supportsGeneratorResizeBack(params: GeneratorParams): boolean {
  return params.kind === 'scallopFrame'
}

export function resizeGeneratorToBounds(
  params: GeneratorParams,
  width: number,
  height: number,
): GeneratorParams {
  if (params.kind === 'scallopFrame') {
    return normalizeScallopFrameParams({
      ...params,
      width,
      height,
    })
  }
  return params
}
