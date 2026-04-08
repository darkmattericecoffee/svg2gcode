import type { GeneratorParams, MachiningSettings } from '../../types/editor'

export function resolveParamsAgainstTool(
  params: GeneratorParams,
  settings: MachiningSettings,
): GeneratorParams {
  if (params.kind === 'tenon' && params.matchToolWidth) {
    return { ...params, width: settings.toolDiameter }
  }
  if (params.kind === 'dowelHole' && params.matchToolDiameter) {
    return { ...params, diameter: settings.toolDiameter }
  }
  return params
}
