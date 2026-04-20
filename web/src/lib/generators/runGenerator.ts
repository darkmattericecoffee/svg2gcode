import type { GeneratorParams } from '../../types/editor'
import { generateDowelHole } from './dowelHole'
import { generateScallopFrame } from './scallopFrame'
import { generateTenon } from './tenon'
import { generateText } from './text'

export function runGenerator(params: GeneratorParams): string {
  switch (params.kind) {
    case 'tenon':
      return generateTenon(params)
    case 'dowelHole':
      return generateDowelHole(params)
    case 'scallopFrame':
      return generateScallopFrame(params)
    case 'text':
      return generateText(params)
  }
}
