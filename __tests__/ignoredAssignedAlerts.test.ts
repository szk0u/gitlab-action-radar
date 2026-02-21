import { describe, expect, it } from 'vitest';
import { applyIgnoredAssignedAlertsUntilNewCommit } from '../src/lib/ignoredAssignedAlerts';
import { MergeRequestHealth } from '../src/types/gitlab';

function createAssignedHealth(
  id: number,
  options?: {
    hasConflicts?: boolean;
    hasFailedCi?: boolean;
    latestCommitAt?: string;
  }
): MergeRequestHealth {
  return {
    mergeRequest: {
      id,
      iid: id,
      project_id: 1,
      title: `MR-${id}`,
      web_url: `https://gitlab.com/group/project/-/merge_requests/${id}`,
      state: 'opened',
      has_conflicts: options?.hasConflicts === true,
      merge_status: options?.hasConflicts ? 'cannot_be_merged' : 'can_be_merged'
    },
    ciStatus: options?.hasFailedCi === true ? 'failed' : 'success',
    hasFailedCi: options?.hasFailedCi === true,
    hasConflicts: options?.hasConflicts === true,
    hasPendingApprovals: false,
    isCreatedByMe: false,
    latestCommitAt: options?.latestCommitAt
  };
}

describe('ignoredAssignedAlerts', () => {
  it('should hide only explicitly ignored MR while commit is unchanged', () => {
    const mr = createAssignedHealth(1, {
      hasConflicts: true,
      latestCommitAt: '2026-02-19T00:00:00Z'
    });

    const first = applyIgnoredAssignedAlertsUntilNewCommit(
      [mr],
      new Map([
        [
          1,
          {
            commitSignature: '2026-02-19T00:00:00Z',
            ignoreConflicts: true,
            ignoreFailedCi: false
          }
        ]
      ])
    );
    expect(first.ignoredMergeRequestIds.has(1)).toBe(true);
    expect(first.activeIgnoredSignals.get(1)).toEqual({
      ignoreConflicts: true,
      ignoreFailedCi: false
    });
    expect(first.nextState.get(1)).toMatchObject({
      commitSignature: '2026-02-19T00:00:00Z',
      ignoreConflicts: true,
      ignoreFailedCi: false
    });
  });

  it('should release ignored MR when new commit is pushed', () => {
    const newCommit = createAssignedHealth(2, {
      hasFailedCi: true,
      latestCommitAt: '2026-02-19T01:00:00Z'
    });
    const result = applyIgnoredAssignedAlertsUntilNewCommit(
      [newCommit],
      new Map([
        [
          2,
          {
            commitSignature: '2026-02-19T00:00:00Z',
            ignoreConflicts: false,
            ignoreFailedCi: true
          }
        ]
      ])
    );
    expect(result.ignoredMergeRequestIds.has(2)).toBe(false);
    expect(result.activeIgnoredSignals.has(2)).toBe(false);
    expect(result.nextState.has(2)).toBe(false);
  });

  it('should not hide non-ignored MR', () => {
    const conflictMr = createAssignedHealth(3, {
      hasConflicts: true,
      latestCommitAt: '2026-02-19T00:00:00Z'
    });
    const result = applyIgnoredAssignedAlertsUntilNewCommit([conflictMr], new Map());
    expect(result.ignoredMergeRequestIds.size).toBe(0);
    expect(result.nextState.size).toBe(0);
  });

  it('should remove ignored state when MR no longer has conflict/failed CI', () => {
    const healthyMr = createAssignedHealth(3, {
      hasConflicts: false,
      hasFailedCi: false,
      latestCommitAt: '2026-02-19T00:00:00Z'
    });
    const result = applyIgnoredAssignedAlertsUntilNewCommit(
      [healthyMr],
      new Map([
        [
          3,
          {
            commitSignature: '2026-02-19T00:00:00Z',
            ignoreConflicts: true,
            ignoreFailedCi: true
          }
        ]
      ])
    );
    expect(result.ignoredMergeRequestIds.has(3)).toBe(false);
    expect(result.activeIgnoredSignals.has(3)).toBe(false);
    expect(result.nextState.has(3)).toBe(false);
  });

  it('should keep only requested signal ignored when both conflict and CI failure exist', () => {
    const riskyMr = createAssignedHealth(4, {
      hasConflicts: true,
      hasFailedCi: true,
      latestCommitAt: '2026-02-19T00:00:00Z'
    });

    const result = applyIgnoredAssignedAlertsUntilNewCommit(
      [riskyMr],
      new Map([
        [
          4,
          {
            commitSignature: '2026-02-19T00:00:00Z',
            ignoreConflicts: true,
            ignoreFailedCi: false
          }
        ]
      ])
    );

    expect(result.ignoredMergeRequestIds.has(4)).toBe(true);
    expect(result.activeIgnoredSignals.get(4)).toEqual({
      ignoreConflicts: true,
      ignoreFailedCi: false
    });
  });
});
