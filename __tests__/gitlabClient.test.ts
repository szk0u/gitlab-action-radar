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
              merge_status: 'can_be_merged'
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
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          approved_by: [{ user: { id: 99, name: 'Me' } }],
          approved: true,
          approvals_left: 0
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          approved_by: [],
          approved: false,
          approvals_left: 1
        })
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
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/300/merge_requests/30/approvals',
      expect.any(Object)
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/400/merge_requests/40/approvals',
      expect.any(Object)
    );

    expect(result.currentUserId).toBe(99);
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

  it('buildHealthSignals should derive CI/conflict/approval signals and own-MR checks', async () => {
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          approved_by: [{ user: { id: 7, name: 'Reviewer' } }],
          approved: true,
          approvals_left: 0
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          blocking_discussions_resolved: false,
          unresolved_discussions_count: 2,
          head_pipeline: { status: 'success' }
        })
      } as Response);

    const client = new GitLabClient({ baseUrl: 'https://gitlab.com', token: 'token' });
    const data: MergeRequest[] = [
      {
        id: 1,
        iid: 1,
        project_id: 100,
        title: 'My MR',
        web_url: 'https://gitlab.com/group/project/-/merge_requests/1',
        state: 'opened',
        author: { id: 99, username: 'me', name: 'Me' },
        has_conflicts: false,
        merge_status: 'can_be_merged',
        pipeline: { status: 'failed' },
        approvals_required: 2,
        approved_by: [{ user: { id: 7, name: 'Reviewer' } }]
      },
      {
        id: 2,
        iid: 2,
        project_id: 200,
        title: 'Other MR',
        web_url: 'https://gitlab.com/group/project/-/merge_requests/2',
        state: 'opened',
        author: { id: 123, username: 'other', name: 'Other' },
        has_conflicts: true,
        merge_status: 'cannot_be_merged'
      }
    ];

    const signals = await client.buildHealthSignals(data, 99);

    expect(signals[0]).toMatchObject({
      hasFailedCi: false,
      hasConflicts: false,
      hasPendingApprovals: true,
      isCreatedByMe: true,
      ownMrChecks: {
        isApproved: true,
        hasUnresolvedComments: true,
        isCiSuccessful: true,
        isCiFailed: false
      }
    });
    expect(signals[1]).toMatchObject({
      hasFailedCi: false,
      hasConflicts: true,
      hasPendingApprovals: false,
      isCreatedByMe: false,
      ownMrChecks: undefined
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/100/merge_requests/1/approvals',
      expect.any(Object)
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/100/merge_requests/1',
      expect.any(Object)
    );
  });

  it('buildHealthSignals should include reviewer comment activity details', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: 11,
          created_at: '2026-02-18T09:00:00Z',
          system: false,
          author: { id: 99, username: 'me', name: 'Me' }
        },
        {
          id: 10,
          created_at: '2026-02-18T08:00:00Z',
          system: false,
          author: { id: 7, username: 'someone', name: 'Someone' }
        }
      ]
    } as Response);

    const client = new GitLabClient({ baseUrl: 'https://gitlab.com', token: 'token' });
    const data: MergeRequest[] = [
      {
        id: 5,
        iid: 50,
        project_id: 500,
        title: 'Review MR',
        web_url: 'https://gitlab.com/group/project/-/merge_requests/50',
        state: 'opened',
        updated_at: '2026-02-18T10:00:00Z',
        author: { id: 123, username: 'author', name: 'Author' },
        has_conflicts: false,
        merge_status: 'can_be_merged'
      }
    ];

    const signals = await client.buildHealthSignals(data, 99, { includeReviewerChecks: true });

    expect(signals[0].reviewerChecks).toMatchObject({
      hasMyComment: true,
      myLastCommentedAt: '2026-02-18T09:00:00Z',
      latestActivity: 'mr_update'
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/500/merge_requests/50/notes?per_page=100&order_by=created_at&sort=desc',
      expect.any(Object)
    );
  });
});
