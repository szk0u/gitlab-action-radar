import { MergeRequestHealth } from '../types/gitlab';

export interface IgnoredAssignedAlertState {
  commitSignature: string;
  ignoreConflicts: boolean;
  ignoreFailedCi: boolean;
}

export interface ActiveIgnoredAssignedSignals {
  ignoreConflicts: boolean;
  ignoreFailedCi: boolean;
}

export function toCommitSignature(latestCommitAt: string | undefined): string {
  const trimmed = latestCommitAt?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'no-commit';
}

export function applyIgnoredAssignedAlertsUntilNewCommit(
  items: MergeRequestHealth[],
  previousState: ReadonlyMap<number, IgnoredAssignedAlertState>
): {
  ignoredMergeRequestIds: Set<number>;
  activeIgnoredSignals: Map<number, ActiveIgnoredAssignedSignals>;
  nextState: Map<number, IgnoredAssignedAlertState>;
} {
  const ignoredMergeRequestIds = new Set<number>();
  const activeIgnoredSignals = new Map<number, ActiveIgnoredAssignedSignals>();
  const nextState = new Map<number, IgnoredAssignedAlertState>();

  for (const item of items) {
    const mergeRequestId = item.mergeRequest.id;
    const previous = previousState.get(mergeRequestId);

    if (!previous) {
      continue;
    }

    const commitSignature = toCommitSignature(item.latestCommitAt);
    if (previous.commitSignature !== commitSignature) {
      continue;
    }

    const ignoreConflicts = previous.ignoreConflicts === true && item.hasConflicts;
    const ignoreFailedCi = previous.ignoreFailedCi === true && item.hasFailedCi;
    if (!ignoreConflicts && !ignoreFailedCi) {
      continue;
    }

    nextState.set(mergeRequestId, previous);
    ignoredMergeRequestIds.add(mergeRequestId);
    activeIgnoredSignals.set(mergeRequestId, {
      ignoreConflicts,
      ignoreFailedCi
    });
  }

  return { ignoredMergeRequestIds, activeIgnoredSignals, nextState };
}
