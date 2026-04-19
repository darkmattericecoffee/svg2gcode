import { engraveTypeLabel, engraveTypeToFillMode, fillModeToEngraveType } from "./engraving";
import { colorForOperation } from "./colors";
import type { AssignmentProfileGroup, ElementAssignment, FillMode, FrontendOperation } from "./types";
import { roundMm } from "./utils";

export function getAssignmentProfileKey(
  targetDepthMm: number,
  fillMode: FillMode | null,
  engraveType: ElementAssignment["engraveType"],
  cutOrderGroupId?: string,
) {
  const groupPart = cutOrderGroupId ?? "default";
  return `${groupPart}::${targetDepthMm}::${engraveType ?? "default"}::${fillMode ?? "default"}`;
}

export function groupAssignmentsForIds(
  assignments: Record<string, ElementAssignment>,
  elementIds: string[],
) {
  const groups = new Map<
    string,
    {
      targetDepthMm: number;
      engraveType: ElementAssignment["engraveType"];
      fillMode: FillMode | null;
      elementIds: string[];
      cutOrderGroupId?: string;
      minCutOrderIndex?: number;
    }
  >();

  for (const elementId of elementIds) {
    const assignment = assignments[elementId];
    if (!assignment) {
      continue;
    }

    const engraveType = assignment.engraveType ?? fillModeToEngraveType(assignment.fillMode);
    const fillMode = assignment.fillMode ?? engraveTypeToFillMode(engraveType);
    const cutOrderGroupId = assignment.cutOrderGroupId;
    const key = getAssignmentProfileKey(assignment.targetDepthMm, fillMode, engraveType, cutOrderGroupId);
    const existing = groups.get(key);
    if (existing) {
      existing.elementIds.push(elementId);
      if (assignment.cutOrderIndex != null) {
        existing.minCutOrderIndex = existing.minCutOrderIndex == null
          ? assignment.cutOrderIndex
          : Math.min(existing.minCutOrderIndex, assignment.cutOrderIndex);
      }
    } else {
      groups.set(key, {
        targetDepthMm: assignment.targetDepthMm,
        engraveType,
        fillMode,
        elementIds: [elementId],
        cutOrderGroupId,
        minCutOrderIndex: assignment.cutOrderIndex,
      });
    }
  }

  return Array.from(groups.entries())
    .map(([key, group], index): AssignmentProfileGroup => ({
      key,
      targetDepthMm: group.targetDepthMm,
      engraveType: group.engraveType,
      fillMode: group.fillMode,
      elementIds: group.elementIds,
      color: colorForOperation(index),
      cutOrderGroupId: group.cutOrderGroupId,
      minCutOrderIndex: group.minCutOrderIndex,
    }))
    .sort((left, right) => {
      // When cut-order data is present, honour it first — this is what preserves
      // the SVG-group clustering requested by the user. Depth is secondary so
      // the multi-pass step-down per group still runs deep→shallow inside a group.
      const leftIdx = left.minCutOrderIndex;
      const rightIdx = right.minCutOrderIndex;
      if (leftIdx != null && rightIdx != null && leftIdx !== rightIdx) {
        return leftIdx - rightIdx;
      }
      if (left.targetDepthMm !== right.targetDepthMm) {
        return left.targetDepthMm - right.targetDepthMm;
      }
      return `${left.engraveType ?? ""}${left.fillMode ?? ""}`.localeCompare(
        `${right.engraveType ?? ""}${right.fillMode ?? ""}`,
      );
    });
}

export function deriveOperationsFromProfileGroups(groups: AssignmentProfileGroup[]): FrontendOperation[] {
  return groups.map((group) => ({
    id: `profile-${group.key}`,
    name: `${roundMm(group.targetDepthMm)}mm${
      group.engraveType ? ` · ${engraveTypeLabel(group.engraveType)}` : group.fillMode ? ` · ${group.fillMode}` : ""
    }`,
    target_depth_mm: group.targetDepthMm,
    assigned_element_ids: group.elementIds,
    color: group.color,
    engrave_type: group.engraveType,
    fill_mode: group.fillMode,
  }));
}
