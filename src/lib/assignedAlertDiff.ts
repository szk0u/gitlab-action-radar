import { MergeRequestHealth } from '../types/gitlab';

export interface AssignedAlertSnapshot {
  hasConflicts: boolean;
  hasFailedCi: boolean;
}

export interface AssignedAlertDiff {
  newlyConflicted: MergeRequestHealth[];
  newlyFailedCi: MergeRequestHealth[];
}

export function buildAssignedAlertSnapshot(items: MergeRequestHealth[]): Map<number, AssignedAlertSnapshot> {
  const snapshot = new Map<number, AssignedAlertSnapshot>();
  for (const item of items) {
    snapshot.set(item.mergeRequest.id, {
      hasConflicts: item.hasConflicts,
      hasFailedCi: item.hasFailedCi
    });
  }
  return snapshot;
}

export function detectAssignedAlertDiff(
  previousSnapshot: ReadonlyMap<number, AssignedAlertSnapshot>,
  currentItems: MergeRequestHealth[]
): AssignedAlertDiff {
  const newlyConflicted: MergeRequestHealth[] = [];
  const newlyFailedCi: MergeRequestHealth[] = [];

  for (const item of currentItems) {
    const previous = previousSnapshot.get(item.mergeRequest.id);
    if (item.hasConflicts && previous?.hasConflicts !== true) {
      newlyConflicted.push(item);
    }
    if (item.hasFailedCi && previous?.hasFailedCi !== true) {
      newlyFailedCi.push(item);
    }
  }

  return { newlyConflicted, newlyFailedCi };
}
