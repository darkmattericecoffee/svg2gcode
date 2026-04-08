import { useState, useCallback } from "react"
import type { GenerateJobRequest, JobProgress, GenerateJobResponse } from "@svg2gcode/bridge"

import { useEditorStore } from "../store"
import { initBridge } from "../lib/bridge"
import { prepareGenerationInputs } from "../lib/bridgeAdapter"

export interface GcodeGenerationState {
  isGenerating: boolean
  progress: JobProgress | null
  result: GenerateJobResponse | null
  error: string | null
}

type GcodeWorkerResponse =
  | { type: "progress"; jobId: number; progress: JobProgress }
  | { type: "result"; jobId: number; result: GenerateJobResponse }
  | { type: "error"; jobId: number; error: string }

let workerInstance: Worker | null = null
let nextJobId = 1

function formatToolDiameterMm(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2).replace(/\.?0+$/, "")
}

function normalizeGenerationError(message: string, toolDiameter: number): string {
  const pocketTooNarrow =
    "Filled SVG geometry was found, but the selected tool diameter is too large to fit inside any filled region."

  if (message.includes(pocketTooNarrow)) {
    return `The SVG imported correctly, but this Pocket operation cannot be machined with the current ${formatToolDiameterMm(toolDiameter)} mm bit. Some filled regions are narrower than the tool. Try a smaller bit or switch this part to Contour.`
  }

  return message
}

function getGcodeWorker() {
  if (!workerInstance) {
    workerInstance = new Worker(new URL("../workers/gcodeWorker.ts", import.meta.url), {
      type: "module",
    })
  }
  return workerInstance
}

export function useGcodeGeneration() {
  const [state, setState] = useState<GcodeGenerationState>({
    isGenerating: false,
    progress: null,
    result: null,
    error: null,
  })

  const runGenerationInWorker = useCallback((request: GenerateJobRequest) => {
    const worker = getGcodeWorker()
    const jobId = nextJobId++

    return new Promise<GenerateJobResponse>((resolve, reject) => {
      const handleMessage = (event: MessageEvent<GcodeWorkerResponse>) => {
        const message = event.data
        if (message.jobId !== jobId) return

        if (message.type === "progress") {
          setState((prev) => ({ ...prev, progress: message.progress }))
          return
        }

        worker.removeEventListener("message", handleMessage)

        if (message.type === "result") {
          resolve(message.result)
          return
        }

        reject(new Error(message.error))
      }

      worker.addEventListener("message", handleMessage)
      worker.postMessage({ type: "generate", jobId, request })
    })
  }, [])

  const generate = useCallback(async () => {
    setState({ isGenerating: true, progress: null, result: null, error: null })

    try {
      // Ensure the main-thread bridge is ready for input preparation.
      const baseSettings = await initBridge()

      const { nodesById, rootIds, artboard, machiningSettings } = useEditorStore.getState()

      const request = await prepareGenerationInputs(
        nodesById,
        rootIds,
        artboard,
        machiningSettings,
        baseSettings,
      )

      const result = await runGenerationInWorker(request)

      setState({ isGenerating: false, progress: null, result, error: null })
      return result
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : "GCode generation failed"
      const { machiningSettings } = useEditorStore.getState()
      const message = normalizeGenerationError(rawMessage, machiningSettings.toolDiameter)
      setState({ isGenerating: false, progress: null, result: null, error: message })
      return null
    }
  }, [runGenerationInWorker])

  const downloadGcode = useCallback((gcode: string, filename = "output.gcode") => {
    const blob = new Blob([gcode], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }, [])

  const reset = useCallback(() => {
    setState({ isGenerating: false, progress: null, result: null, error: null })
  }, [])

  return {
    ...state,
    generate,
    downloadGcode,
    reset,
  }
}
