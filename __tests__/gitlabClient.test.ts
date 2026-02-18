import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabClient } from '../src/api/gitlabClient';
import { MergeRequest } from '../src/types/gitlab';

describe('GitLabClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listMyRelevantMergeRequests should split assigned/reviewer MRs and filter reviewer-only noise', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 99, username: 'me', name: 'Me' })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          [
            {
              id: 1,
              iid: 10,
              project_id: 100,
              title: 'Assigned MR',
              web_url: 'https://gitlab.com/group/project/-/merge_requests/10',
              state: 'opened',
              has_conflicts: false,
              merge_status: 'can_be_merged'
            },
            {
              id: 1,
              iid: 10,
              project_id: 100,
              title: 'Assigned MR',
              web_url: 'https://gitlab.com/group/project/-/merge_requests/10',
              state: 'opened',
              has_conflicts: false,
              merge_status: 'can_be_merged'
            }
          ] satisfies MergeRequest[]
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          [
            {
              id: 2,
              iid: 20,
              project_id: 200,
              title: 'Draft review MR',
              web_url: 'https://gitlab.com/group/project/-/merge_requests/20',
              state: 'opened',
              draft: true,
              has_conflicts: false,
              merge_status: 'can_be_merged'
            },
            {
              id: 3,
              iid: 30,
              project_id: 300,
              title: 'Already reviewed MR',
              web_url: 'https://gitlab.com/group/project/-/merge_requests/30',
              state: 'opened',
              has_conflicts: false,
              merge_status: 'can_be_merged',
              approved_by: [{ user: { id: 99, name: 'Me' } }]
            },
            {
              id: 4,
              iid: 40,
              project_id: 400,
              title: 'Review target MR',
              web_url: 'https://gitlab.com/group/project/-/merge_requests/40',
              state: 'opened',
              has_conflicts: true,
              merge_status: 'cannot_be_merged'
            }
          ] satisfies MergeRequest[]
      } as Response);

    const client = new GitLabClient({ baseUrl: 'https://gitlab.com/', token: 'token' });
    const result = await client.listMyRelevantMergeRequests();

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://gitlab.com/api/v4/user',
      expect.objectContaining({ headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'token' }) })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/merge_requests?scope=all&state=opened&assignee_id=99&per_page=100',
      expect.any(Object)
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/merge_requests?scope=all&state=opened&reviewer_id=99&per_page=100',
      expect.any(Object)
    );

    expect(result.assigned.map((mr) => mr.id)).toEqual([1]);
    expect(result.reviewRequested.map((mr) => mr.id)).toEqual([4]);
  });

  it('request should throw on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized'
    } as Response);

    const client = new GitLabClient({ baseUrl: 'https://gitlab.com', token: 'bad-token' });

    await expect(client.getCurrentUser()).rejects.toThrow('GitLab API error: 401 Unauthorized');
  });

  it('buildHealthSignals should derive CI/conflict/approval signals', () => {
    const client = new GitLabClient({ baseUrl: 'https://gitlab.com', token: 'token' });
    const data: MergeRequest[] = [
      {
        id: 1,
        iid: 1,
        project_id: 100,
        title: 'MR 1',
        web_url: '',
        state: 'opened',
        has_conflicts: false,
        merge_status: 'can_be_merged',
        pipeline: { status: 'failed' },
        approvals_required: 2,
        approved_by: [{ user: { id: 1, name: 'A' } }]
      },
      {
        id: 2,
        iid: 2,
        project_id: 200,
        title: 'MR 2',
        web_url: '',
        state: 'opened',
        has_conflicts: true,
        merge_status: 'cannot_be_merged'
      }
    ];

    const signals = client.buildHealthSignals(data);

    expect(signals[0]).toMatchObject({ hasFailedCi: true, hasConflicts: false, hasPendingApprovals: true });
    expect(signals[1]).toMatchObject({ hasFailedCi: false, hasConflicts: true, hasPendingApprovals: false });
  });
});
