import type { GeneratorParams } from '../../types/editor'
import { generateDowelHole } from './dowelHole'
import { generateTenon } from './tenon'

export function runGenerator(params: GeneratorParams): string {
  switch (params.kind) {
    case 'tenon':
      return generateTenon(params)
    case 'dowelHole':
      return generateDowelHole(params)
  }
}
