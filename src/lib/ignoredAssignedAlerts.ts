import { MergeRequestHealth } from '../types/gitlab';

export interface IgnoredAssignedAlertState {
  commitSignature: string;
}

export function toCommitSignature(latestCommitAt: string | undefined): string {
  const trimmed = latestCommitAt?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'no-commit';
}

export function applyIgnoredAssignedAlertsUntilNewCommit(
  items: MergeRequestHealth[],
  previousState: ReadonlyMap<number, IgnoredAssignedAlertState>
): { ignoredMergeRequestIds: Set<number>; nextState: Map<number, IgnoredAssignedAlertState> } {
  const ignoredMergeRequestIds = new Set<number>();
  const nextState = new Map<number, IgnoredAssignedAlertState>();

  for (const item of items) {
    const mergeRequestId = item.mergeRequest.id;
    const shouldIgnoreByState = item.hasConflicts || item.hasFailedCi;
    const previous = previousState.get(mergeRequestId);

    if (!shouldIgnoreByState) {
      continue;
    }

    if (!previous) {
      continue;
    }

    const commitSignature = toCommitSignature(item.latestCommitAt);
    if (previous.commitSignature === commitSignature) {
      nextState.set(mergeRequestId, previous);
      ignoredMergeRequestIds.add(mergeRequestId);
      continue;
    }
  }

  return { ignoredMergeRequestIds, nextState };
}
