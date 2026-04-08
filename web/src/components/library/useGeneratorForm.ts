import { useCallback, useEffect, useRef, useState } from 'react'

import { useEditorStore } from '../../store'
import type { GeneratorParams } from '../../types/editor'

export function useGeneratorForm(
  initialParams: GeneratorParams,
  mode: 'new' | 'edit',
  nodeId?: string,
) {
  const [draft, setDraft] = useState<GeneratorParams>(initialParams)
  const updateGeneratorParams = useEditorStore((s) => s.updateGeneratorParams)
  const isMounted = useRef(false)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset draft when the node changes (switching selection)
  useEffect(() => {
    setDraft(initialParams)
  }, [initialParams, nodeId])

  // Mark as mounted after first render so we skip the initial debounce
  useEffect(() => {
    isMounted.current = true
  }, [])

  const setPatch = useCallback(
    (patch: Partial<GeneratorParams>) => {
      const next = { ...draft, ...patch } as GeneratorParams
      setDraft(next)

      if (mode === 'edit' && nodeId && isMounted.current) {
        if (debounceTimer.current) clearTimeout(debounceTimer.current)
        debounceTimer.current = setTimeout(() => {
          updateGeneratorParams(nodeId, next)
        }, 300)
      }
    },
    [draft, mode, nodeId, updateGeneratorParams],
  )

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [])

  return { draft, setPatch }
}
