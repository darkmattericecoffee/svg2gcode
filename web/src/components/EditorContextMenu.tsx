"use client"

import type { ComponentType, Key } from 'react'
import {
  BringToFront,
  ClipboardPaste,
  Copy,
  Group as GroupIcon,
  MoveDown,
  MoveUp,
  Pencil,
  RotateCcw,
  RotateCw,
  Scissors,
  SendToBack,
  SquareDashed,
  Trash2,
  Ungroup,
} from 'lucide-react'
import { Button, Dropdown, Kbd, Label } from '@heroui/react'

import { useEditorStore } from '../store'
import type { CanvasNode } from '../types/editor'

interface EditorContextMenuProps {
  isOpen: boolean
  x: number
  y: number
  showRename?: boolean
  onRename?: () => void
  jobActions?: {
    jobs: Array<{ id: string; label: string; name: string }>
    canAssign: boolean
    onAddToJob: (targetJobId: string | 'new') => void
  }
  onOpenChange: (isOpen: boolean) => void
}

type ModifierKey = 'command' | 'shift' | 'delete'
type ShortcutToken =
  | { type: 'abbr'; value: ModifierKey }
  | { type: 'text'; value: string }

const iconClassName = 'size-4 shrink-0 text-muted'
const dangerIconClassName = 'size-4 shrink-0 text-danger'

function Shortcut({ keys }: { keys: ShortcutToken[] }) {
  return (
    <Kbd className="ms-auto" slot="keyboard" variant="light">
      {keys.map((key, index) =>
        key.type === 'abbr' ? (
          <Kbd.Abbr key={`${key.value}-${index}`} keyValue={key.value} />
        ) : (
          <Kbd.Content key={`${key.value}-${index}`}>{key.value}</Kbd.Content>
        ),
      )}
    </Kbd>
  )
}

function ItemIcon({
  icon: Icon,
  danger = false,
}: {
  icon: ComponentType<{ className?: string }>
  danger?: boolean
}) {
  return <Icon className={danger ? dangerIconClassName : iconClassName} />
}

export function EditorContextMenu({
  isOpen,
  x,
  y,
  showRename = false,
  onRename,
  jobActions,
  onOpenChange,
}: EditorContextMenuProps) {
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const nodesById = useEditorStore((state) => state.nodesById)
  const clipboard = useEditorStore((state) => state.clipboard)
  const copySelected = useEditorStore((state) => state.copySelected)
  const cutSelected = useEditorStore((state) => state.cutSelected)
  const pasteClipboard = useEditorStore((state) => state.pasteClipboard)
  const groupSelected = useEditorStore((state) => state.groupSelected)
  const ungroupSelected = useEditorStore((state) => state.ungroupSelected)
  const deleteSelected = useEditorStore((state) => state.deleteSelected)
  const orderSelected = useEditorStore((state) => state.orderSelected)
  const rotateSelected = useEditorStore((state) => state.rotateSelected)
  const setSelectedEngraveType = useEditorStore((state) => state.setSelectedEngraveType)

  const hasSelection = selectedIds.length > 0
  const canPaste = Boolean(clipboard)
  const selectedNodes = selectedIds
    .map((id) => nodesById[id])
    .filter((node): node is CanvasNode => Boolean(node))
  const canGroup =
    selectedNodes.length >= 2 &&
    selectedNodes.every((node) => node.parentId === selectedNodes[0]?.parentId)
  const canUngroup = selectedNodes.some((node) => node.type === 'group')

  const runAction = (key: Key) => {
    switch (String(key)) {
      case 'copy':
        copySelected()
        break
      case 'paste':
        pasteClipboard()
        break
      case 'cut':
        cutSelected()
        break
      case 'delete':
        deleteSelected()
        break
      case 'group':
        groupSelected()
        break
      case 'ungroup':
        ungroupSelected()
        break
      case 'rename':
        onRename?.()
        break
      case 'order-forward':
        orderSelected('forward')
        break
      case 'order-backward':
        orderSelected('backward')
        break
      case 'order-front':
        orderSelected('front')
        break
      case 'order-back':
        orderSelected('back')
        break
      case 'rotate-ccw':
        rotateSelected(-90)
        break
      case 'rotate-cw':
        rotateSelected(90)
        break
      case 'cut-type-contour':
        setSelectedEngraveType('contour')
        break
      case 'cut-type-pocket':
        setSelectedEngraveType('pocket')
        break
      case 'job-new':
        jobActions?.onAddToJob('new')
        break
      default:
        if (String(key).startsWith('job-existing:')) {
          jobActions?.onAddToJob(String(key).slice('job-existing:'.length))
        }
        break
    }
  }

  return (
    <Dropdown isOpen={isOpen} onOpenChange={onOpenChange}>
      <Button
        aria-label="Object actions"
        className="pointer-events-none fixed z-50 h-1 min-h-0 w-1 min-w-0 opacity-0"
        style={{ left: x, top: y }}
        variant="secondary"
      />
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu onAction={runAction} aria-label="Object actions">
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="grouping" textValue="Grouping" isDisabled={!canGroup && !canUngroup}>
              <ItemIcon icon={GroupIcon} />
              <Label>Grouping</Label>
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover>
              <Dropdown.Menu onAction={runAction} aria-label="Grouping actions">
                <Dropdown.Item id="group" textValue="Group" isDisabled={!canGroup}>
                  <ItemIcon icon={GroupIcon} />
                  <Label>Group</Label>
                  <Shortcut keys={[{ type: 'abbr', value: 'command' }, { type: 'text', value: 'G' }]} />
                </Dropdown.Item>
                <Dropdown.Item id="ungroup" textValue="Ungroup" isDisabled={!canUngroup}>
                  <ItemIcon icon={Ungroup} />
                  <Label>Ungroup</Label>
                  <Shortcut
                    keys={[
                      { type: 'abbr', value: 'command' },
                      { type: 'abbr', value: 'shift' },
                      { type: 'text', value: 'G' },
                    ]}
                  />
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>

          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="ordering" textValue="Ordering" isDisabled={!hasSelection}>
              <ItemIcon icon={BringToFront} />
              <Label>Ordering</Label>
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover>
              <Dropdown.Menu onAction={runAction} aria-label="Ordering actions">
                <Dropdown.Item id="order-forward" textValue="Forward">
                  <ItemIcon icon={MoveUp} />
                  <Label>Forward</Label>
                  <Shortcut keys={[{ type: 'abbr', value: 'command' }, { type: 'text', value: ']' }]} />
                </Dropdown.Item>
                <Dropdown.Item id="order-backward" textValue="Backward">
                  <ItemIcon icon={MoveDown} />
                  <Label>Backward</Label>
                  <Shortcut keys={[{ type: 'abbr', value: 'command' }, { type: 'text', value: '[' }]} />
                </Dropdown.Item>
                <Dropdown.Item id="order-front" textValue="To front">
                  <ItemIcon icon={BringToFront} />
                  <Label>To front</Label>
                  <Shortcut
                    keys={[
                      { type: 'abbr', value: 'command' },
                      { type: 'abbr', value: 'shift' },
                      { type: 'text', value: ']' },
                    ]}
                  />
                </Dropdown.Item>
                <Dropdown.Item id="order-back" textValue="To back">
                  <ItemIcon icon={SendToBack} />
                  <Label>To back</Label>
                  <Shortcut
                    keys={[
                      { type: 'abbr', value: 'command' },
                      { type: 'abbr', value: 'shift' },
                      { type: 'text', value: '[' },
                    ]}
                  />
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>

          <Dropdown.Item id="copy" textValue="Copy" isDisabled={!hasSelection}>
            <ItemIcon icon={Copy} />
            <Label>Copy</Label>
            <Shortcut keys={[{ type: 'abbr', value: 'command' }, { type: 'text', value: 'C' }]} />
          </Dropdown.Item>
          <Dropdown.Item id="paste" textValue="Paste" isDisabled={!canPaste}>
            <ItemIcon icon={ClipboardPaste} />
            <Label>Paste</Label>
            <Shortcut keys={[{ type: 'abbr', value: 'command' }, { type: 'text', value: 'V' }]} />
          </Dropdown.Item>
          <Dropdown.Item id="cut" textValue="Cut" isDisabled={!hasSelection}>
            <ItemIcon icon={Scissors} />
            <Label>Cut</Label>
            <Shortcut keys={[{ type: 'abbr', value: 'command' }, { type: 'text', value: 'X' }]} />
          </Dropdown.Item>

          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="rotate" textValue="Rotate" isDisabled={!hasSelection}>
              <ItemIcon icon={RotateCw} />
              <Label>Rotate</Label>
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover>
              <Dropdown.Menu onAction={runAction} aria-label="Rotate actions">
                <Dropdown.Item id="rotate-ccw" textValue="90 degrees counter-clockwise">
                  <ItemIcon icon={RotateCcw} />
                  <Label>90 degrees CCW</Label>
                </Dropdown.Item>
                <Dropdown.Item id="rotate-cw" textValue="90 degrees clockwise">
                  <ItemIcon icon={RotateCw} />
                  <Label>90 degrees CW</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>

          {showRename ? (
            <Dropdown.Item id="rename" textValue="Rename" isDisabled={!hasSelection || !onRename}>
              <ItemIcon icon={Pencil} />
              <Label>Rename</Label>
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="delete" textValue="Delete" variant="danger" isDisabled={!hasSelection}>
            <ItemIcon icon={Trash2} danger />
            <Label>Delete</Label>
            <Shortcut keys={[{ type: 'abbr', value: 'delete' }]} />
          </Dropdown.Item>

          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="cut-type" textValue="Cut type" isDisabled={!hasSelection}>
              <ItemIcon icon={SquareDashed} />
              <Label>Cut type</Label>
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover>
              <Dropdown.Menu onAction={runAction} aria-label="Cut type actions">
                <Dropdown.Item id="cut-type-contour" textValue="Contour">
                  <ItemIcon icon={SquareDashed} />
                  <Label>Contour</Label>
                </Dropdown.Item>
                <Dropdown.Item id="cut-type-pocket" textValue="Pocket">
                  <ItemIcon icon={SquareDashed} />
                  <Label>Pocket</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>

          {jobActions ? (
            <Dropdown.SubmenuTrigger>
              <Dropdown.Item id="add-to-job" textValue="Add to job" isDisabled={!hasSelection || !jobActions.canAssign}>
                <ItemIcon icon={GroupIcon} />
                <Label>Add to job</Label>
                <Dropdown.SubmenuIndicator />
              </Dropdown.Item>
              <Dropdown.Popover>
                <Dropdown.Menu onAction={runAction} aria-label="Job actions">
                  <Dropdown.Item id="job-new" textValue="New job from selection">
                    <ItemIcon icon={GroupIcon} />
                    <Label>New job from selection</Label>
                  </Dropdown.Item>
                  {jobActions.jobs.map((job) => (
                    <Dropdown.Item key={job.id} id={`job-existing:${job.id}`} textValue={`${job.label} ${job.name}`}>
                      <ItemIcon icon={GroupIcon} />
                      <Label>{job.label}</Label>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.SubmenuTrigger>
          ) : null}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
