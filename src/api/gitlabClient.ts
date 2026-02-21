import {
  CiStatus,
  GitLabUser,
  MergeRequestCommit,
  MergeRequest,
  MergeRequestApprovals,
  MergeRequestDetails,
  MergeRequestHealth,
  MergeRequestNote,
  MyRelevantMergeRequests,
  OwnMergeRequestChecks,
  ReviewerMergeRequestChecks,
  ReviewerReviewStatus
} from '../types/gitlab';

export interface GitLabClientConfig {
  baseUrl: string;
  token: string;
}

export interface BuildHealthSignalsOptions {
  includeReviewerChecks?: boolean;
  includeLatestCommitAt?: boolean;
}

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly approvalsCache = new Map<string, Promise<MergeRequestApprovals | undefined>>();
  private readonly detailsCache = new Map<string, Promise<MergeRequestDetails | undefined>>();
  private readonly notesCache = new Map<string, Promise<MergeRequestNote[] | undefined>>();
  private readonly commitsCache = new Map<string, Promise<MergeRequestCommit[] | undefined>>();

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

  private normalizeStatusValue(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private isDraftMergeRequest(mergeRequest: MergeRequest): boolean {
    return mergeRequest.draft === true || mergeRequest.work_in_progress === true;
  }

  private hasReviewerMarkedReviewed(mergeRequest: MergeRequest, userId: number): boolean {
    const reviewer = (mergeRequest.reviewers ?? []).find((item) => item.id === userId);
    const reviewerState = this.normalizeStatusValue(reviewer?.state);
    return (
      reviewerState === 'reviewed' ||
      reviewerState === 'approved' ||
      reviewerState === 'requested_changes' ||
      reviewerState === 'commented'
    );
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

  private getMergeRequestCommits(mergeRequest: MergeRequest): Promise<MergeRequestCommit[] | undefined> {
    const key = this.getMergeRequestKey(mergeRequest);
    const cached = this.commitsCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.request<MergeRequestCommit[]>(
      `/api/v4/projects/${encodeURIComponent(String(mergeRequest.project_id))}/merge_requests/${encodeURIComponent(
        String(mergeRequest.iid)
      )}/commits?per_page=100`
    ).catch(() => undefined);

    this.commitsCache.set(key, promise);
    return promise;
  }

  private async isReviewedByUser(mergeRequest: MergeRequest, userId: number): Promise<boolean> {
    if (this.hasReviewerMarkedReviewed(mergeRequest, userId)) {
      return true;
    }

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
    const normalizedCiStatus = this.getNormalizedCiStatus(mergeRequest, details);
    const ciStatus = this.toCiStatus(normalizedCiStatus, details);

    return {
      isApproved,
      hasUnresolvedComments,
      ciStatus
    };
  }

  private getNormalizedCiStatus(mergeRequest: MergeRequest, details?: MergeRequestDetails): string {
    const detailHeadPipelineStatus = this.normalizeStatusValue(details?.head_pipeline?.status);
    if (detailHeadPipelineStatus) {
      return detailHeadPipelineStatus;
    }

    const detailPipelineStatus = this.normalizeStatusValue(details?.pipeline?.status);
    if (detailPipelineStatus) {
      return detailPipelineStatus;
    }

    if (details) {
      // Prefer MR details when available; list response pipeline can be stale.
      return '';
    }

    return this.normalizeStatusValue(mergeRequest.pipeline?.status);
  }

  private isCiFailedStatus(normalizedCiStatus: string, details?: MergeRequestDetails): boolean {
    if (normalizedCiStatus !== 'failed') {
      return false;
    }

    const detailedMergeStatus = this.normalizeStatusValue(details?.detailed_merge_status);
    if (!detailedMergeStatus) {
      return true;
    }

    if (detailedMergeStatus === 'can_be_merged' || detailedMergeStatus === 'mergeable') {
      // Some responses include stale failed pipeline values while merge status is explicitly healthy.
      return false;
    }

    return true;
  }

  private toCiStatus(normalizedCiStatus: string, details?: MergeRequestDetails): CiStatus {
    if (!normalizedCiStatus) {
      return 'unknown';
    }

    if (normalizedCiStatus === 'failed') {
      return this.isCiFailedStatus(normalizedCiStatus, details) ? 'failed' : 'unknown';
    }

    if (normalizedCiStatus === 'success') {
      return 'success';
    }
    if (normalizedCiStatus === 'running') {
      return 'running';
    }
    if (normalizedCiStatus === 'pending') {
      return 'pending';
    }
    if (normalizedCiStatus === 'canceled') {
      return 'canceled';
    }
    if (normalizedCiStatus === 'skipped') {
      return 'skipped';
    }
    if (normalizedCiStatus === 'manual') {
      return 'manual';
    }
    if (normalizedCiStatus === 'scheduled') {
      return 'scheduled';
    }
    if (normalizedCiStatus === 'created') {
      return 'created';
    }
    if (normalizedCiStatus === 'preparing') {
      return 'preparing';
    }
    if (normalizedCiStatus === 'waiting_for_resource') {
      return 'waiting_for_resource';
    }

    return 'unknown';
  }

  private hasMergeConflict(mergeRequest: MergeRequest, details?: MergeRequestDetails): boolean {
    return (
      details?.has_conflicts === true ||
      details?.merge_status === 'cannot_be_merged' ||
      mergeRequest.has_conflicts ||
      mergeRequest.merge_status === 'cannot_be_merged'
    );
  }

  private isLaterThan(left: string | undefined, right: string | undefined): boolean {
    if (!left || !right) {
      return false;
    }

    const leftMs = Date.parse(left);
    const rightMs = Date.parse(right);
    if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) {
      return false;
    }

    return leftMs > rightMs;
  }

  private async getLatestCommitAt(mergeRequest: MergeRequest): Promise<string | undefined> {
    const commits = await this.getMergeRequestCommits(mergeRequest);
    if (!commits || commits.length === 0) {
      return undefined;
    }

    let latestCommitAt: string | undefined;
    let latestCommitAtMs = Number.NEGATIVE_INFINITY;

    for (const commit of commits) {
      const commitCreatedAt = commit.created_at;
      if (!commitCreatedAt) {
        continue;
      }

      const commitCreatedAtMs = Date.parse(commitCreatedAt);
      if (Number.isNaN(commitCreatedAtMs)) {
        continue;
      }

      if (commitCreatedAtMs > latestCommitAtMs) {
        latestCommitAtMs = commitCreatedAtMs;
        latestCommitAt = commitCreatedAt;
      }
    }

    return latestCommitAt;
  }

  private resolveReviewStatus(
    reviewerLastCommentedAt: string | undefined,
    latestCommitAt: string | undefined,
    authorLastCommentedAt: string | undefined
  ): ReviewerReviewStatus {
    if (!reviewerLastCommentedAt) {
      return 'new';
    }

    const needsReview =
      this.isLaterThan(latestCommitAt, reviewerLastCommentedAt) ||
      this.isLaterThan(authorLastCommentedAt, reviewerLastCommentedAt);
    return needsReview ? 'needs_review' : 'waiting_for_author';
  }

  private async buildReviewerMergeRequestChecks(
    mergeRequest: MergeRequest,
    currentUserId: number,
    latestCommitAtInput?: string
  ): Promise<ReviewerMergeRequestChecks> {
    const notes = await this.getMergeRequestNotes(mergeRequest);
    const mrAuthorId = mergeRequest.author?.id;
    let reviewerLastCommentedAt: string | undefined;
    let authorLastCommentedAt: string | undefined;

    for (const note of notes ?? []) {
      if (note.system) {
        continue;
      }

      const noteAuthorId = note.author?.id;
      if (noteAuthorId === currentUserId && !reviewerLastCommentedAt) {
        reviewerLastCommentedAt = note.created_at;
      } else if (typeof mrAuthorId === 'number' && noteAuthorId === mrAuthorId && !authorLastCommentedAt) {
        authorLastCommentedAt = note.created_at;
      }

      if (reviewerLastCommentedAt && authorLastCommentedAt) {
        break;
      }
    }

    const latestCommitAt = latestCommitAtInput ?? (await this.getLatestCommitAt(mergeRequest));
    const reviewStatus = this.resolveReviewStatus(reviewerLastCommentedAt, latestCommitAt, authorLastCommentedAt);

    return {
      reviewStatus,
      reviewerLastCommentedAt,
      latestCommitAt,
      authorLastCommentedAt
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
        const shouldIncludeLatestCommitAt = options?.includeLatestCommitAt || options?.includeReviewerChecks;
        const [details, ownMrChecks, latestCommitAt] = await Promise.all([
          this.getMergeRequestDetails(mergeRequest),
          isCreatedByMe ? this.buildOwnMergeRequestChecks(mergeRequest) : Promise.resolve(undefined),
          shouldIncludeLatestCommitAt ? this.getLatestCommitAt(mergeRequest) : Promise.resolve(undefined)
        ]);
        const reviewerChecks = options?.includeReviewerChecks
          ? await this.buildReviewerMergeRequestChecks(mergeRequest, currentUserId, latestCommitAt)
          : undefined;
        const ciStatus = ownMrChecks?.ciStatus ?? this.toCiStatus(this.getNormalizedCiStatus(mergeRequest, details), details);
        const hasFailedCi = ciStatus === 'failed';

        return {
          mergeRequest,
          ciStatus,
          hasFailedCi,
          hasConflicts: this.hasMergeConflict(mergeRequest, details),
          hasPendingApprovals: approvalsRequired > approvedCount,
          isCreatedByMe,
          latestCommitAt,
          ownMrChecks,
          reviewerChecks
        };
      })
    );
  }
}
