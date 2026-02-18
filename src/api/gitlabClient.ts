import {
  GitLabUser,
  MergeRequest,
  MergeRequestApprovals,
  MergeRequestHealth,
  MyRelevantMergeRequests
} from '../types/gitlab';

export interface GitLabClientConfig {
  baseUrl: string;
  token: string;
}

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly token: string;

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

  private isDraftMergeRequest(mergeRequest: MergeRequest): boolean {
    return mergeRequest.draft === true || mergeRequest.work_in_progress === true;
  }

  private async getMergeRequestApprovals(mergeRequest: MergeRequest): Promise<MergeRequestApprovals> {
    return this.request<MergeRequestApprovals>(
      `/api/v4/projects/${encodeURIComponent(String(mergeRequest.project_id))}/merge_requests/${encodeURIComponent(
        String(mergeRequest.iid)
      )}/approvals`
    );
  }

  private async isReviewedByUser(mergeRequest: MergeRequest, userId: number): Promise<boolean> {
    if ((mergeRequest.approved_by ?? []).some((approval) => approval.user.id === userId)) {
      return true;
    }

    try {
      const approvals = await this.getMergeRequestApprovals(mergeRequest);
      return (approvals.approved_by ?? []).some((approval) => approval.user.id === userId);
    } catch {
      return false;
    }
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
      assigned: this.dedupeById(assigned),
      reviewRequested: reviewRequestedWithReviewState
        .filter((item) => !item.reviewedByMe)
        .map((item) => item.mergeRequest)
    };
  }

  buildHealthSignals(mergeRequests: MergeRequest[]): MergeRequestHealth[] {
    return mergeRequests.map((mr) => {
      const approvalsRequired = mr.approvals_required ?? 0;
      const approvedCount = mr.approved_by?.length ?? 0;

      return {
        mergeRequest: mr,
        hasFailedCi: mr.pipeline?.status === 'failed',
        hasConflicts: mr.has_conflicts || mr.merge_status === 'cannot_be_merged',
        hasPendingApprovals: approvalsRequired > approvedCount
      };
    });
  }
}
