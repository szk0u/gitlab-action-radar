import {
  CiStatus,
  GitLabUser,
  MergeRequestCommit,
  MergeRequest,
  MergeRequestApprovals,
  MergeRequestDiff,
  MergeRequestDiffStats,
  MergeRequestDetails,
  MergeRequestHealth,
  MergeRequestNote,
  MyRelevantMergeRequests,
  OwnMergeRequestChecks,
  ReviewerMergeRequestChecks,
  ReviewerReviewStatus,
} from '../types/gitlab';

const requestTimeoutMs = 15_000;
const maxRequestRetries = 2;
const baseRetryDelayMs = 750;

export interface GitLabClientConfig {
  baseUrl: string;
  token: string;
}

export interface BuildHealthSignalsOptions {
  includeReviewerChecks?: boolean;
  includeLatestCommitAt?: boolean;
}

export type GitLabApiErrorKind =
  | 'auth'
  | 'permission'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'unknown';

interface GitLabApiErrorOptions {
  status?: number;
  retryable?: boolean;
  retryAfterSeconds?: number;
}

export class GitLabApiError extends Error {
  readonly kind: GitLabApiErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(kind: GitLabApiErrorKind, message: string, options?: GitLabApiErrorOptions) {
    super(message);
    this.name = 'GitLabApiError';
    this.kind = kind;
    this.status = options?.status;
    this.retryable = options?.retryable ?? false;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly approvalsCache = new Map<string, Promise<MergeRequestApprovals | undefined>>();
  private readonly detailsCache = new Map<string, Promise<MergeRequestDetails | undefined>>();
  private readonly notesCache = new Map<string, Promise<MergeRequestNote[] | undefined>>();
  private readonly commitsCache = new Map<string, Promise<MergeRequestCommit[] | undefined>>();
  private readonly diffsCache = new Map<string, Promise<MergeRequestDiff[] | undefined>>();

  constructor(config: GitLabClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return undefined;
    }

    return parsed;
  }

  private buildResponseError(response: Response): GitLabApiError {
    const retryAfterSeconds = this.parseRetryAfterSeconds(response.headers?.get?.('retry-after'));
    const message = `GitLab API error: ${response.status} ${response.statusText}`;

    if (response.status === 401) {
      return new GitLabApiError('auth', message, { status: 401 });
    }
    if (response.status === 403) {
      return new GitLabApiError('permission', message, { status: 403 });
    }
    if (response.status === 429) {
      return new GitLabApiError('rate_limit', message, {
        status: 429,
        retryable: true,
        retryAfterSeconds,
      });
    }
    if (response.status >= 500) {
      return new GitLabApiError('server', message, {
        status: response.status,
        retryable: true,
        retryAfterSeconds,
      });
    }

    return new GitLabApiError('unknown', message, { status: response.status });
  }

  private normalizeRequestError(error: unknown): GitLabApiError {
    if (error instanceof GitLabApiError) {
      return error;
    }
    if (this.isAbortError(error)) {
      return new GitLabApiError('timeout', 'GitLab API request timed out', {
        retryable: true,
      });
    }
    if (error instanceof TypeError) {
      return new GitLabApiError('network', 'GitLab API request failed due to a network error', {
        retryable: true,
      });
    }
    if (error instanceof Error) {
      return new GitLabApiError('unknown', error.message);
    }

    return new GitLabApiError('unknown', String(error));
  }

  private getRetryDelayMs(error: GitLabApiError, attempt: number): number {
    if (error.retryAfterSeconds != null) {
      return error.retryAfterSeconds * 1_000;
    }

    return baseRetryDelayMs * 2 ** attempt;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, ms);
    });
  }

  private async fetchWithTimeout(pathWithQuery: string): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);

    try {
      return await fetch(`${this.baseUrl}${pathWithQuery}`, {
        headers: {
          'PRIVATE-TOKEN': this.token,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  private async request<T>(pathWithQuery: string): Promise<T> {
    for (let attempt = 0; attempt <= maxRequestRetries; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(pathWithQuery);
        if (!response.ok) {
          throw this.buildResponseError(response);
        }

        return (await response.json()) as T;
      } catch (error) {
        const normalizedError = this.normalizeRequestError(error);
        if (!normalizedError.retryable || attempt === maxRequestRetries) {
          throw normalizedError;
        }

        await this.delay(this.getRetryDelayMs(normalizedError, attempt));
      }
    }

    throw new GitLabApiError('unknown', 'GitLab API request failed unexpectedly');
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

  private getMergeRequestApprovals(
    mergeRequest: MergeRequest,
  ): Promise<MergeRequestApprovals | undefined> {
    const key = this.getMergeRequestKey(mergeRequest);
    const cached = this.approvalsCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.request<MergeRequestApprovals>(
      `/api/v4/projects/${encodeURIComponent(String(mergeRequest.project_id))}/merge_requests/${encodeURIComponent(
        String(mergeRequest.iid),
      )}/approvals`,
    ).catch(() => undefined);

    this.approvalsCache.set(key, promise);
    return promise;
  }

  private getMergeRequestDetails(
    mergeRequest: MergeRequest,
  ): Promise<MergeRequestDetails | undefined> {
    const key = this.getMergeRequestKey(mergeRequest);
    const cached = this.detailsCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.request<MergeRequestDetails>(
      `/api/v4/projects/${encodeURIComponent(String(mergeRequest.project_id))}/merge_requests/${encodeURIComponent(
        String(mergeRequest.iid),
      )}`,
    ).catch(() => undefined);

    this.detailsCache.set(key, promise);
    return promise;
  }

  private getMergeRequestNotes(
    mergeRequest: MergeRequest,
  ): Promise<MergeRequestNote[] | undefined> {
    const key = this.getMergeRequestKey(mergeRequest);
    const cached = this.notesCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.request<MergeRequestNote[]>(
      `/api/v4/projects/${encodeURIComponent(String(mergeRequest.project_id))}/merge_requests/${encodeURIComponent(
        String(mergeRequest.iid),
      )}/notes?per_page=100&order_by=created_at&sort=desc`,
    ).catch(() => undefined);

    this.notesCache.set(key, promise);
    return promise;
  }

  private getMergeRequestCommits(
    mergeRequest: MergeRequest,
  ): Promise<MergeRequestCommit[] | undefined> {
    const key = this.getMergeRequestKey(mergeRequest);
    const cached = this.commitsCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.request<MergeRequestCommit[]>(
      `/api/v4/projects/${encodeURIComponent(String(mergeRequest.project_id))}/merge_requests/${encodeURIComponent(
        String(mergeRequest.iid),
      )}/commits?per_page=100`,
    ).catch(() => undefined);

    this.commitsCache.set(key, promise);
    return promise;
  }

  private getMergeRequestDiffs(
    mergeRequest: MergeRequest,
  ): Promise<MergeRequestDiff[] | undefined> {
    const key = this.getMergeRequestKey(mergeRequest);
    const cached = this.diffsCache.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.request<MergeRequestDiff[]>(
      `/api/v4/projects/${encodeURIComponent(String(mergeRequest.project_id))}/merge_requests/${encodeURIComponent(
        String(mergeRequest.iid),
      )}/diffs?per_page=100&unidiff=true`,
    ).catch(() => undefined);

    this.diffsCache.set(key, promise);
    return promise;
  }

  private countDiffLineChanges(diff: string | undefined): { additions: number; deletions: number } {
    if (!diff) {
      return { additions: 0, deletions: 0 };
    }

    let additions = 0;
    let deletions = 0;

    for (const line of diff.split('\n')) {
      if (
        line.startsWith('+++') ||
        line.startsWith('---') ||
        line.startsWith('diff ') ||
        line.startsWith('index ') ||
        line.startsWith('@@')
      ) {
        continue;
      }

      if (line.startsWith('+')) {
        additions += 1;
        continue;
      }

      if (line.startsWith('-')) {
        deletions += 1;
      }
    }

    return { additions, deletions };
  }

  private parseChangedFilesCount(value: string | undefined, fallback: number): number {
    if (!value) {
      return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private async buildDiffStats(
    mergeRequest: MergeRequest,
  ): Promise<MergeRequestDiffStats | undefined> {
    const diffs = await this.getMergeRequestDiffs(mergeRequest);
    if (!diffs) {
      const changedFiles = this.parseChangedFilesCount(mergeRequest.changes_count, 0);
      return changedFiles > 0 ? { changedFiles } : undefined;
    }

    let additions = 0;
    let deletions = 0;

    for (const diff of diffs) {
      const counts = this.countDiffLineChanges(diff.diff);
      additions += counts.additions;
      deletions += counts.deletions;
    }

    return {
      changedFiles: this.parseChangedFilesCount(mergeRequest.changes_count, diffs.length),
      additions,
      deletions,
    };
  }

  private enrichMergeRequest(
    mergeRequest: MergeRequest,
    details: MergeRequestDetails | undefined,
    diffStats: MergeRequestDiffStats | undefined,
  ): MergeRequest {
    if (!details && !diffStats) {
      return mergeRequest;
    }

    return {
      ...mergeRequest,
      reviewers: details?.reviewers ?? mergeRequest.reviewers,
      labels: details?.labels ?? mergeRequest.labels,
      milestone: details?.milestone ?? mergeRequest.milestone,
      user_notes_count: details?.user_notes_count ?? mergeRequest.user_notes_count,
      changes_count: details?.changes_count ?? mergeRequest.changes_count,
      diffStats: diffStats ?? mergeRequest.diffStats,
    };
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
        `/api/v4/merge_requests?scope=all&state=opened&assignee_id=${currentUser.id}&per_page=100`,
      ),
      this.request<MergeRequest[]>(
        `/api/v4/merge_requests?scope=all&state=opened&reviewer_id=${currentUser.id}&per_page=100`,
      ),
    ]);

    const filteredReviewRequested = this.dedupeById(reviewRequested).filter(
      (mergeRequest) => !this.isDraftMergeRequest(mergeRequest),
    );

    const reviewRequestedWithReviewState = await Promise.all(
      filteredReviewRequested.map(async (mergeRequest) => ({
        mergeRequest,
        reviewedByMe: await this.isReviewedByUser(mergeRequest, currentUser.id),
      })),
    );

    return {
      currentUserId: currentUser.id,
      assigned: this.dedupeById(assigned),
      reviewRequested: reviewRequestedWithReviewState
        .filter((item) => !item.reviewedByMe)
        .map((item) => item.mergeRequest),
    };
  }

  private async buildOwnMergeRequestChecks(
    mergeRequest: MergeRequest,
  ): Promise<OwnMergeRequestChecks> {
    const [approvals, details] = await Promise.all([
      this.getMergeRequestApprovals(mergeRequest),
      this.getMergeRequestDetails(mergeRequest),
    ]);

    const isApproved =
      approvals?.approved === true ||
      approvals?.approvals_left === 0 ||
      (approvals?.approved_by?.length ?? 0) > 0;

    const hasUnresolvedComments =
      (typeof details?.unresolved_discussions_count === 'number' &&
        details.unresolved_discussions_count > 0) ||
      details?.blocking_discussions_resolved === false;
    const normalizedCiStatus = this.getNormalizedCiStatus(mergeRequest, details);
    const ciStatus = this.toCiStatus(normalizedCiStatus, details);

    return {
      isApproved,
      hasUnresolvedComments,
      ciStatus,
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
    authorLastCommentedAt: string | undefined,
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
    latestCommitAtInput?: string,
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
      } else if (
        typeof mrAuthorId === 'number' &&
        noteAuthorId === mrAuthorId &&
        !authorLastCommentedAt
      ) {
        authorLastCommentedAt = note.created_at;
      }

      if (reviewerLastCommentedAt && authorLastCommentedAt) {
        break;
      }
    }

    const latestCommitAt = latestCommitAtInput ?? (await this.getLatestCommitAt(mergeRequest));
    const reviewStatus = this.resolveReviewStatus(
      reviewerLastCommentedAt,
      latestCommitAt,
      authorLastCommentedAt,
    );

    return {
      reviewStatus,
      reviewerLastCommentedAt,
      latestCommitAt,
      authorLastCommentedAt,
    };
  }

  async buildHealthSignals(
    mergeRequests: MergeRequest[],
    currentUserId: number,
    options?: BuildHealthSignalsOptions,
  ): Promise<MergeRequestHealth[]> {
    return Promise.all(
      mergeRequests.map(async (mergeRequest) => {
        const approvalsRequired = mergeRequest.approvals_required ?? 0;
        const approvedCount = mergeRequest.approved_by?.length ?? 0;
        const isCreatedByMe = mergeRequest.author?.id === currentUserId;
        const shouldIncludeLatestCommitAt =
          options?.includeLatestCommitAt || options?.includeReviewerChecks;
        const [details, ownMrChecks, latestCommitAt, diffStats] = await Promise.all([
          this.getMergeRequestDetails(mergeRequest),
          isCreatedByMe
            ? this.buildOwnMergeRequestChecks(mergeRequest)
            : Promise.resolve(undefined),
          shouldIncludeLatestCommitAt
            ? this.getLatestCommitAt(mergeRequest)
            : Promise.resolve(undefined),
          this.buildDiffStats(mergeRequest),
        ]);
        const reviewerChecks = options?.includeReviewerChecks
          ? await this.buildReviewerMergeRequestChecks(mergeRequest, currentUserId, latestCommitAt)
          : undefined;
        const ciStatus =
          ownMrChecks?.ciStatus ??
          this.toCiStatus(this.getNormalizedCiStatus(mergeRequest, details), details);
        const hasFailedCi = ciStatus === 'failed';

        return {
          mergeRequest: this.enrichMergeRequest(mergeRequest, details, diffStats),
          ciStatus,
          hasFailedCi,
          hasConflicts: this.hasMergeConflict(mergeRequest, details),
          hasPendingApprovals: approvalsRequired > approvedCount,
          isCreatedByMe,
          latestCommitAt,
          ownMrChecks,
          reviewerChecks,
        };
      }),
    );
  }
}
