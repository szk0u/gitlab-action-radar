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
            },
            {
              id: 5,
              iid: 50,
              project_id: 500,
              title: 'Reviewer state reviewed MR',
              web_url: 'https://gitlab.com/group/project/-/merge_requests/50',
              state: 'opened',
              has_conflicts: false,
              merge_status: 'can_be_merged',
              reviewers: [{ id: 99, state: 'reviewed' }]
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
    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/500/merge_requests/50/approvals',
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
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url === 'https://gitlab.com/api/v4/projects/100/merge_requests/1/approvals') {
        return {
          ok: true,
          json: async () => ({
            approved_by: [{ user: { id: 7, name: 'Reviewer' } }],
            approved: true,
            approvals_left: 0
          })
        } as Response;
      }

      if (url === 'https://gitlab.com/api/v4/projects/100/merge_requests/1') {
        return {
          ok: true,
          json: async () => ({
            blocking_discussions_resolved: false,
            unresolved_discussions_count: 2,
            head_pipeline: { status: 'success' }
          })
        } as Response;
      }

      if (url === 'https://gitlab.com/api/v4/projects/200/merge_requests/2') {
        return {
          ok: true,
          json: async () => ({
            has_conflicts: true,
            merge_status: 'cannot_be_merged',
            detailed_merge_status: 'ci_must_pass',
            head_pipeline: { status: 'failed' }
          })
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

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
        has_conflicts: false,
        merge_status: 'can_be_merged',
        pipeline: { status: 'success' }
      }
    ];

    const signals = await client.buildHealthSignals(data, 99);

    expect(signals[0]).toMatchObject({
      ciStatus: 'success',
      hasFailedCi: false,
      hasConflicts: false,
      hasPendingApprovals: true,
      isCreatedByMe: true,
      ownMrChecks: {
        isApproved: true,
        hasUnresolvedComments: true,
        ciStatus: 'success'
      }
    });
    expect(signals[1]).toMatchObject({
      ciStatus: 'failed',
      hasFailedCi: true,
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
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/200/merge_requests/2',
      expect.any(Object)
    );
  });

  it('buildHealthSignals should avoid CI false positives when detailed merge status is healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url === 'https://gitlab.com/api/v4/projects/300/merge_requests/3') {
        return {
          ok: true,
          json: async () => ({
            has_conflicts: false,
            merge_status: 'can_be_merged',
            detailed_merge_status: 'can_be_merged',
            head_pipeline: { status: 'failed' }
          })
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const client = new GitLabClient({ baseUrl: 'https://gitlab.com', token: 'token' });
    const data: MergeRequest[] = [
      {
        id: 3,
        iid: 3,
        project_id: 300,
        title: 'Healthy detailed status MR',
        web_url: 'https://gitlab.com/group/project/-/merge_requests/3',
        state: 'opened',
        author: { id: 123, username: 'other', name: 'Other' },
        has_conflicts: false,
        merge_status: 'can_be_merged',
        pipeline: { status: 'failed' }
      }
    ];

    const signals = await client.buildHealthSignals(data, 99);

    expect(signals[0]).toMatchObject({
      ciStatus: 'unknown',
      hasFailedCi: false,
      hasConflicts: false
    });
  });

  it('buildHealthSignals should keep failed CI when detailed merge status is not explicitly healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url === 'https://gitlab.com/api/v4/projects/301/merge_requests/31') {
        return {
          ok: true,
          json: async () => ({
            has_conflicts: false,
            merge_status: 'can_be_merged',
            detailed_merge_status: 'not_approved',
            head_pipeline: { status: 'failed' }
          })
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const client = new GitLabClient({ baseUrl: 'https://gitlab.com', token: 'token' });
    const data: MergeRequest[] = [
      {
        id: 31,
        iid: 31,
        project_id: 301,
        title: 'Not approved with failed CI MR',
        web_url: 'https://gitlab.com/group/project/-/merge_requests/31',
        state: 'opened',
        author: { id: 123, username: 'other', name: 'Other' },
        has_conflicts: false,
        merge_status: 'can_be_merged',
        pipeline: { status: 'failed' }
      }
    ];

    const signals = await client.buildHealthSignals(data, 99);

    expect(signals[0]).toMatchObject({
      ciStatus: 'failed',
      hasFailedCi: true,
      hasConflicts: false
    });
  });

  it('buildHealthSignals should include reviewer review status details', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url === 'https://gitlab.com/api/v4/projects/500/merge_requests/50') {
        return {
          ok: true,
          json: async () => ({
            has_conflicts: false,
            merge_status: 'can_be_merged',
            head_pipeline: { status: 'success' }
          })
        } as Response;
      }

      if (url === 'https://gitlab.com/api/v4/projects/500/merge_requests/50/notes?per_page=100&order_by=created_at&sort=desc') {
        return {
          ok: true,
          json: async () => [
            {
              id: 11,
              created_at: '2026-02-18T10:00:00Z',
              system: false,
              author: { id: 123, username: 'author', name: 'Author' }
            },
            {
              id: 10,
              created_at: '2026-02-18T09:00:00Z',
              system: false,
              author: { id: 99, username: 'me', name: 'Me' }
            },
            {
              created_at: '2026-02-18T08:00:00Z',
              system: false,
              author: { id: 7, username: 'someone', name: 'Someone' }
            }
          ]
        } as Response;
      }

      if (url === 'https://gitlab.com/api/v4/projects/500/merge_requests/50/commits?per_page=100') {
        return {
          ok: true,
          json: async () => [
            { id: 'b', created_at: '2026-02-18T08:30:00Z' },
            { id: 'a', created_at: '2026-02-18T08:00:00Z' }
          ]
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

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
      reviewStatus: 'needs_review',
      reviewerLastCommentedAt: '2026-02-18T09:00:00Z',
      latestCommitAt: '2026-02-18T08:30:00Z',
      authorLastCommentedAt: '2026-02-18T10:00:00Z'
    });
    expect(signals[0]).toMatchObject({
      ciStatus: 'success',
      hasFailedCi: false,
      hasConflicts: false
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/500/merge_requests/50/notes?per_page=100&order_by=created_at&sort=desc',
      expect.any(Object)
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/500/merge_requests/50',
      expect.any(Object)
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/500/merge_requests/50/commits?per_page=100',
      expect.any(Object)
    );
  });

  it('buildHealthSignals should classify reviewer statuses for waiting/new flows', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url === 'https://gitlab.com/api/v4/projects/600/merge_requests/60') {
        return {
          ok: true,
          json: async () => ({
            has_conflicts: false,
            merge_status: 'can_be_merged'
          })
        } as Response;
      }

      if (url === 'https://gitlab.com/api/v4/projects/600/merge_requests/60/notes?per_page=100&order_by=created_at&sort=desc') {
        return {
          ok: true,
          json: async () => [
            {
              id: 20,
              created_at: '2026-02-18T09:00:00Z',
              system: false,
              author: { id: 99, username: 'me', name: 'Me' }
            },
            {
              id: 19,
              created_at: '2026-02-18T08:30:00Z',
              system: false,
              author: { id: 777, username: 'author1', name: 'Author1' }
            }
          ]
        } as Response;
      }

      if (url === 'https://gitlab.com/api/v4/projects/600/merge_requests/60/commits?per_page=100') {
        return {
          ok: true,
          json: async () => [{ id: 'c1', created_at: '2026-02-18T08:00:00Z' }]
        } as Response;
      }

      if (url === 'https://gitlab.com/api/v4/projects/610/merge_requests/61') {
        return {
          ok: true,
          json: async () => ({
            has_conflicts: false,
            merge_status: 'can_be_merged'
          })
        } as Response;
      }

      if (url === 'https://gitlab.com/api/v4/projects/610/merge_requests/61/notes?per_page=100&order_by=created_at&sort=desc') {
        return {
          ok: true,
          json: async () => [
            {
              id: 30,
              created_at: '2026-02-18T11:00:00Z',
              system: false,
              author: { id: 888, username: 'author2', name: 'Author2' }
            }
          ]
        } as Response;
      }

      if (url === 'https://gitlab.com/api/v4/projects/610/merge_requests/61/commits?per_page=100') {
        return {
          ok: true,
          json: async () => [{ id: 'c2', created_at: '2026-02-18T10:00:00Z' }]
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const client = new GitLabClient({ baseUrl: 'https://gitlab.com', token: 'token' });
    const data: MergeRequest[] = [
      {
        id: 6,
        iid: 60,
        project_id: 600,
        title: 'Waiting MR',
        web_url: 'https://gitlab.com/group/project/-/merge_requests/60',
        state: 'opened',
        author: { id: 777, username: 'author1', name: 'Author1' },
        has_conflicts: false,
        merge_status: 'can_be_merged'
      },
      {
        id: 7,
        iid: 61,
        project_id: 610,
        title: 'New MR',
        web_url: 'https://gitlab.com/group/project/-/merge_requests/61',
        state: 'opened',
        author: { id: 888, username: 'author2', name: 'Author2' },
        has_conflicts: false,
        merge_status: 'can_be_merged'
      }
    ];

    const signals = await client.buildHealthSignals(data, 99, { includeReviewerChecks: true });

    expect(signals[0].reviewerChecks?.reviewStatus).toBe('waiting_for_author');
    expect(signals[1].reviewerChecks?.reviewStatus).toBe('new');
  });
});
