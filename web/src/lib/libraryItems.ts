import dominoImage from '../assets/library/domino.png'
import dowelImage from '../assets/library/dowel.png'
import scallopFrameImage from '../assets/library/scallop-frame.svg'
import type {
  BasicShapeKind,
  DowelHoleParams,
  GeneratorParams,
  ScallopFrameParams,
  TenonParams,
} from '../types/editor'

export const LIBRARY_DRAG_MIME = 'application/x-svg2gcode-library-item'

export const DEFAULT_TENON: TenonParams = {
  kind: 'tenon',
  name: 'Tenon',
  width: 10,
  height: 20,
  matchToolWidth: false,
  rowCount: 1,
  colCount: 1,
  rowSpacing: 30,
  colSpacing: 30,
  outputType: 'pocket',
}

export const DEFAULT_DOWEL: DowelHoleParams = {
  kind: 'dowelHole',
  name: 'Dowel Hole',
  diameter: 8,
  matchToolDiameter: false,
  rowCount: 1,
  colCount: 1,
  rowSpacing: 30,
  colSpacing: 30,
  outputType: 'pocket',
}

export const DEFAULT_SCALLOP_FRAME: ScallopFrameParams = {
  kind: 'scallopFrame',
  name: 'Scallop Frame',
  width: 120,
  height: 90,
  minScallopSize: 12,
  outputType: 'contour',
}

export interface GeneratorLibraryItem {
  itemType: 'generator'
  kind: GeneratorParams['kind']
  label: string
  description: string
  imageSrc: string
  tags: string[]
  defaultParams: GeneratorParams
}

export interface ShapeLibraryItem {
  itemType: 'shape'
  kind: BasicShapeKind
  label: string
  description: string
  tags: string[]
}

export type LibraryItem = GeneratorLibraryItem | ShapeLibraryItem

export type LibraryDragPayload =
  | { itemType: 'generator'; params: GeneratorParams }
  | { itemType: 'shape'; kind: BasicShapeKind }

export const GENERATOR_LIBRARY_ITEMS: GeneratorLibraryItem[] = [
  {
    itemType: 'generator',
    kind: 'tenon',
    label: 'Tenon / Domino',
    description: 'Mortise pocket or contour.',
    imageSrc: dominoImage,
    tags: ['tenon', 'domino', 'mortise', 'joinery'],
    defaultParams: DEFAULT_TENON,
  },
  {
    itemType: 'generator',
    kind: 'dowelHole',
    label: 'Dowel Hole',
    description: 'Round dowel holes.',
    imageSrc: dowelImage,
    tags: ['dowel', 'hole', 'drill', 'joinery'],
    defaultParams: DEFAULT_DOWEL,
  },
  {
    itemType: 'generator',
    kind: 'scallopFrame',
    label: 'Scallop Frame',
    description: 'Resizable scalloped frame.',
    imageSrc: scallopFrameImage,
    tags: ['scallop', 'frame', 'border', 'decorative'],
    defaultParams: DEFAULT_SCALLOP_FRAME,
  },
]

export const SHAPE_LIBRARY_ITEMS: ShapeLibraryItem[] = [
  {
    itemType: 'shape',
    kind: 'rectangle',
    label: 'Rectangle',
    description: 'Rounded outline shape.',
    tags: ['rectangle', 'rounded', 'box', 'shape', 'outline'],
  },
  {
    itemType: 'shape',
    kind: 'circle',
    label: 'Circle',
    description: 'Round outline shape.',
    tags: ['circle', 'round', 'shape', 'outline'],
  },
  {
    itemType: 'shape',
    kind: 'triangle',
    label: 'Triangle',
    description: 'Triangle outline shape.',
    tags: ['triangle', 'shape', 'outline'],
  },
]

export const LIBRARY_ITEMS: LibraryItem[] = [
  ...GENERATOR_LIBRARY_ITEMS,
  ...SHAPE_LIBRARY_ITEMS,
]

export function createLibraryDragPayload(item: LibraryItem): LibraryDragPayload {
  if (item.itemType === 'generator') {
    return { itemType: 'generator', params: item.defaultParams }
  }

  return { itemType: 'shape', kind: item.kind }
}

export function parseLibraryDragPayload(value: string): LibraryDragPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<LibraryDragPayload>
    if (parsed.itemType === 'generator' && parsed.params) {
      return parsed as LibraryDragPayload
    }
    if (parsed.itemType === 'shape' && parsed.kind) {
      return parsed as LibraryDragPayload
    }
  } catch {
    return null
  }

  return null
}
