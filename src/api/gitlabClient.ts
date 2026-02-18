import {
  GitLabUser,
  MergeRequest,
  MergeRequestApprovals,
  MergeRequestDetails,
  MergeRequestHealth,
  MergeRequestNote,
  MyRelevantMergeRequests,
  OwnMergeRequestChecks,
  ReviewerMergeRequestChecks
} from '../types/gitlab';

export interface GitLabClientConfig {
  baseUrl: string;
  token: string;
}

export interface BuildHealthSignalsOptions {
  includeReviewerChecks?: boolean;
}

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly approvalsCache = new Map<string, Promise<MergeRequestApprovals | undefined>>();
  private readonly detailsCache = new Map<string, Promise<MergeRequestDetails | undefined>>();
  private readonly notesCache = new Map<string, Promise<MergeRequestNote[] | undefined>>();

  constructor(config: GitLabClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
  }

  private async request<T>(pathWithQuery: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${pathWithQuery}`, {
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  }

  async getCurrentUser(): Promise<GitLabUser> {
    return this.request<GitLabUser>('/api/v4/user');
  }

  private dedupeById(mergeRequests: MergeRequest[]): MergeRequest[] {
    const dedupedById = new Map<number, MergeRequest>();
    for (const mr of mergeRequests) {
      dedupedById.set(mr.id, mr);
    }

    return [...dedupedById.values()];
  }

  private getMergeRequestKey(mergeRequest: MergeRequest): string {
    return `${mergeRequest.project_id}:${mergeRequest.iid}`;
  }

  private isDraftMergeRequest(mergeRequest: MergeRequest): boolean {
    return mergeRequest.draft === true || mergeRequest.work_in_progress === true;
  }

  private getMergeRequestApprovals(mergeRequest: MergeRequest): Promise<MergeRequestApprovals | undefined> {
    const key = this.getMergeRequestKey(mergeRequest);
    const cached = this.approvalsCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.request<MergeRequestApprovals>(
      `/api/v4/projects/${encodeURIComponent(String(mergeRequest.project_id))}/merge_requests/${encodeURIComponent(
        String(mergeRequest.iid)
      )}/approvals`
    ).catch(() => undefined);

    this.approvalsCache.set(key, promise);
    return promise;
  }

  private getMergeRequestDetails(mergeRequest: MergeRequest): Promise<MergeRequestDetails | undefined> {
    const key = this.getMergeRequestKey(mergeRequest);
    const cached = this.detailsCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.request<MergeRequestDetails>(
      `/api/v4/projects/${encodeURIComponent(String(mergeRequest.project_id))}/merge_requests/${encodeURIComponent(
        String(mergeRequest.iid)
      )}`
    ).catch(() => undefined);

    this.detailsCache.set(key, promise);
    return promise;
  }

  private getMergeRequestNotes(mergeRequest: MergeRequest): Promise<MergeRequestNote[] | undefined> {
    const key = this.getMergeRequestKey(mergeRequest);
    const cached = this.notesCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.request<MergeRequestNote[]>(
      `/api/v4/projects/${encodeURIComponent(String(mergeRequest.project_id))}/merge_requests/${encodeURIComponent(
        String(mergeRequest.iid)
      )}/notes?per_page=100&order_by=created_at&sort=desc`
    ).catch(() => undefined);

    this.notesCache.set(key, promise);
    return promise;
  }

  private async isReviewedByUser(mergeRequest: MergeRequest, userId: number): Promise<boolean> {
    if ((mergeRequest.approved_by ?? []).some((approval) => approval.user.id === userId)) {
      return true;
    }

    const approvals = await this.getMergeRequestApprovals(mergeRequest);
    return (approvals?.approved_by ?? []).some((approval) => approval.user.id === userId);
  }

  async listMyRelevantMergeRequests(): Promise<MyRelevantMergeRequests> {
    const currentUser = await this.getCurrentUser();

    const [assigned, reviewRequested] = await Promise.all([
      this.request<MergeRequest[]>(
        `/api/v4/merge_requests?scope=all&state=opened&assignee_id=${currentUser.id}&per_page=100`
      ),
      this.request<MergeRequest[]>(
        `/api/v4/merge_requests?scope=all&state=opened&reviewer_id=${currentUser.id}&per_page=100`
      )
    ]);

    const filteredReviewRequested = this.dedupeById(reviewRequested).filter(
      (mergeRequest) => !this.isDraftMergeRequest(mergeRequest)
    );

    const reviewRequestedWithReviewState = await Promise.all(
      filteredReviewRequested.map(async (mergeRequest) => ({
        mergeRequest,
        reviewedByMe: await this.isReviewedByUser(mergeRequest, currentUser.id)
      }))
    );

    return {
      currentUserId: currentUser.id,
      assigned: this.dedupeById(assigned),
      reviewRequested: reviewRequestedWithReviewState
        .filter((item) => !item.reviewedByMe)
        .map((item) => item.mergeRequest)
    };
  }

  private async buildOwnMergeRequestChecks(mergeRequest: MergeRequest): Promise<OwnMergeRequestChecks> {
    const [approvals, details] = await Promise.all([
      this.getMergeRequestApprovals(mergeRequest),
      this.getMergeRequestDetails(mergeRequest)
    ]);

    const isApproved =
      approvals?.approved === true ||
      approvals?.approvals_left === 0 ||
      (approvals?.approved_by?.length ?? 0) > 0;

    const hasUnresolvedComments =
      (typeof details?.unresolved_discussions_count === 'number' && details.unresolved_discussions_count > 0) ||
      details?.blocking_discussions_resolved === false;
    const ciStatus = details?.head_pipeline?.status ?? details?.pipeline?.status ?? mergeRequest.pipeline?.status;
    const normalizedCiStatus = typeof ciStatus === 'string' ? ciStatus.toLowerCase() : '';

    return {
      isApproved,
      hasUnresolvedComments,
      isCiSuccessful: normalizedCiStatus === 'success',
      isCiFailed: normalizedCiStatus === 'failed'
    };
  }

  private resolveLatestActivity(
    mergeRequestUpdatedAt: string | undefined,
    myLastCommentedAt: string | undefined
  ): ReviewerMergeRequestChecks['latestActivity'] {
    if (!myLastCommentedAt || !mergeRequestUpdatedAt) {
      return 'unknown';
    }

    const mergeRequestUpdatedAtMs = Date.parse(mergeRequestUpdatedAt);
    const myLastCommentedAtMs = Date.parse(myLastCommentedAt);
    if (Number.isNaN(mergeRequestUpdatedAtMs) || Number.isNaN(myLastCommentedAtMs)) {
      return 'unknown';
    }
    if (mergeRequestUpdatedAtMs > myLastCommentedAtMs) {
      return 'mr_update';
    }
    if (mergeRequestUpdatedAtMs < myLastCommentedAtMs) {
      return 'my_comment';
    }
    return 'same_time';
  }

  private async buildReviewerMergeRequestChecks(
    mergeRequest: MergeRequest,
    currentUserId: number
  ): Promise<ReviewerMergeRequestChecks> {
    const notes = await this.getMergeRequestNotes(mergeRequest);
    const myLastComment = (notes ?? []).find((note) => note.author?.id === currentUserId && !note.system);
    const myLastCommentedAt = myLastComment?.created_at;

    return {
      hasMyComment: Boolean(myLastCommentedAt),
      myLastCommentedAt,
      latestActivity: this.resolveLatestActivity(mergeRequest.updated_at, myLastCommentedAt)
    };
  }

  async buildHealthSignals(
    mergeRequests: MergeRequest[],
    currentUserId: number,
    options?: BuildHealthSignalsOptions
  ): Promise<MergeRequestHealth[]> {
    return Promise.all(
      mergeRequests.map(async (mergeRequest) => {
        const approvalsRequired = mergeRequest.approvals_required ?? 0;
        const approvedCount = mergeRequest.approved_by?.length ?? 0;
        const isCreatedByMe = mergeRequest.author?.id === currentUserId;
        const ownMrChecks = isCreatedByMe ? await this.buildOwnMergeRequestChecks(mergeRequest) : undefined;
        const reviewerChecks = options?.includeReviewerChecks
          ? await this.buildReviewerMergeRequestChecks(mergeRequest, currentUserId)
          : undefined;

        return {
          mergeRequest,
          hasFailedCi: ownMrChecks ? ownMrChecks.isCiFailed : mergeRequest.pipeline?.status === 'failed',
          hasConflicts: mergeRequest.has_conflicts || mergeRequest.merge_status === 'cannot_be_merged',
          hasPendingApprovals: approvalsRequired > approvedCount,
          isCreatedByMe,
          ownMrChecks,
          reviewerChecks
        };
      })
    );
  }
}
