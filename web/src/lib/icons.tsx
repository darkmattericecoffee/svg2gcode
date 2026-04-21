/* eslint-disable react-refresh/only-export-components */
import type { ComponentType, SVGProps } from 'react'

import { LocationArrow, TextIndent } from '@gravity-ui/icons'
import ArrowChevronDownIcon from '@gravity-ui/icons/esm/ArrowChevronDown.js'
import ArrowChevronRightIcon from '@gravity-ui/icons/esm/ArrowChevronRight.js'
import ArrowRotateLeftIcon from '@gravity-ui/icons/esm/ArrowRotateLeft.js'
import ArrowRotateRightIcon from '@gravity-ui/icons/esm/ArrowRotateRight.js'
import ArrowUpFromSquareIcon from '@gravity-ui/icons/esm/ArrowUpFromSquare.js'
import CircleXmarkIcon from '@gravity-ui/icons/esm/CircleXmark.js'
import EyeIcon from '@gravity-ui/icons/esm/Eye.js'
import EyeSlashIcon from '@gravity-ui/icons/esm/EyeSlash.js'
import FileArrowDownIcon from '@gravity-ui/icons/esm/FileArrowDown.js'
import FileArrowUpIcon from '@gravity-ui/icons/esm/FileArrowUp.js'
import HandIcon from '@gravity-ui/icons/esm/Hand.js'
import LayersIcon from '@gravity-ui/icons/esm/Layers.js'
import LockIcon from '@gravity-ui/icons/esm/Lock.js'
import LockOpenIcon from '@gravity-ui/icons/esm/LockOpen.js'
import MinusIcon from '@gravity-ui/icons/esm/Minus.js'
import ObjectAlignBottomIcon from '@gravity-ui/icons/esm/ObjectAlignBottom.js'
import ObjectAlignCenterHorizontalIcon from '@gravity-ui/icons/esm/ObjectAlignCenterHorizontal.js'
import ObjectAlignCenterVerticalIcon from '@gravity-ui/icons/esm/ObjectAlignCenterVertical.js'
import ObjectAlignLeftIcon from '@gravity-ui/icons/esm/ObjectAlignLeft.js'
import ObjectAlignRightIcon from '@gravity-ui/icons/esm/ObjectAlignRight.js'
import ObjectAlignTopIcon from '@gravity-ui/icons/esm/ObjectAlignTop.js'
import PictureIcon from '@gravity-ui/icons/esm/Picture.js'
import PlusIcon from '@gravity-ui/icons/esm/Plus.js'
import SquareDashedIcon from '@gravity-ui/icons/esm/SquareDashed.js'
import { Pipette } from 'lucide-react'

export type AppIconComponent = ComponentType<SVGProps<SVGSVGElement>>

export const Icons = {
  alignBottom: ObjectAlignBottomIcon,
  alignCenterHorizontal: ObjectAlignCenterHorizontalIcon,
  alignCenterVertical: ObjectAlignCenterVerticalIcon,
  alignLeft: ObjectAlignLeftIcon,
  alignRight: ObjectAlignRightIcon,
  alignTop: ObjectAlignTopIcon,
  chevronDown: ArrowChevronDownIcon,
  chevronRight: ArrowChevronRightIcon,
  undo: ArrowRotateLeftIcon,
  redo: ArrowRotateRightIcon,
  close: CircleXmarkIcon,
  cursor: LocationArrow,
  export: ArrowUpFromSquareIcon,
  eye: EyeIcon,
  eyeOff: EyeSlashIcon,
  fileArrowDown: FileArrowDownIcon,
  fileUpload: FileArrowUpIcon,
  fit: SquareDashedIcon,
  hand: HandIcon,
  layers: LayersIcon,
  lock: LockIcon,
  lockOpen: LockOpenIcon,
  minus: MinusIcon,
  picture: PictureIcon,
  pipette: Pipette,
  plus: PlusIcon,
  textIndent: TextIndent,
} satisfies Record<string, AppIconComponent>

export function AppIcon({
  icon: Icon,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { icon: AppIconComponent }) {
  return <Icon className={className} {...props} />
}
