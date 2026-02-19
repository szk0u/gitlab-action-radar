import { describe, expect, it } from 'vitest';
import { buildAssignedAlertSnapshot, detectAssignedAlertDiff } from '../src/lib/assignedAlertDiff';
import { MergeRequestHealth } from '../src/types/gitlab';

function createHealth(id: number, iid: number, options?: { hasConflicts?: boolean; hasFailedCi?: boolean }): MergeRequestHealth {
  return {
    mergeRequest: {
      id,
      iid,
      project_id: 100 + id,
      title: `MR-${iid}`,
      web_url: `https://gitlab.example.com/group/project/-/merge_requests/${iid}`,
      state: 'opened',
      has_conflicts: options?.hasConflicts === true,
      merge_status: options?.hasConflicts ? 'cannot_be_merged' : 'can_be_merged'
    },
    hasConflicts: options?.hasConflicts === true,
    hasFailedCi: options?.hasFailedCi === true,
    hasPendingApprovals: false,
    isCreatedByMe: true
  };
}

describe('assignedAlertDiff', () => {
  it('detectAssignedAlertDiff should detect transitions to conflict/failed-ci states', () => {
    const previousItems = [createHealth(1, 10, { hasConflicts: false, hasFailedCi: false })];
    const currentItems = [createHealth(1, 10, { hasConflicts: true, hasFailedCi: true })];

    const diff = detectAssignedAlertDiff(buildAssignedAlertSnapshot(previousItems), currentItems);

    expect(diff.newlyConflicted.map((item) => item.mergeRequest.id)).toEqual([1]);
    expect(diff.newlyFailedCi.map((item) => item.mergeRequest.id)).toEqual([1]);
  });

  it('detectAssignedAlertDiff should treat newly-added already-alerting MR as new alert', () => {
    const previousItems = [createHealth(1, 10, { hasConflicts: false, hasFailedCi: false })];
    const currentItems = [
      createHealth(1, 10, { hasConflicts: false, hasFailedCi: false }),
      createHealth(2, 20, { hasConflicts: true, hasFailedCi: false })
    ];

    const diff = detectAssignedAlertDiff(buildAssignedAlertSnapshot(previousItems), currentItems);

    expect(diff.newlyConflicted.map((item) => item.mergeRequest.id)).toEqual([2]);
    expect(diff.newlyFailedCi).toHaveLength(0);
  });

  it('detectAssignedAlertDiff should not include already-alerting items repeatedly', () => {
    const previousItems = [
      createHealth(1, 10, { hasConflicts: true, hasFailedCi: true }),
      createHealth(2, 20, { hasConflicts: false, hasFailedCi: true })
    ];
    const currentItems = [
      createHealth(1, 10, { hasConflicts: true, hasFailedCi: true }),
      createHealth(2, 20, { hasConflicts: false, hasFailedCi: true })
    ];

    const diff = detectAssignedAlertDiff(buildAssignedAlertSnapshot(previousItems), currentItems);

    expect(diff.newlyConflicted).toHaveLength(0);
    expect(diff.newlyFailedCi).toHaveLength(0);
  });
});
