import { GitLabUser, MergeRequest, MergeRequestHealth } from '../types/gitlab';

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

  async listMyRelevantMergeRequests(): Promise<MergeRequest[]> {
    const currentUser = await this.getCurrentUser();

    const [assigned, reviewRequested] = await Promise.all([
      this.request<MergeRequest[]>(
        `/api/v4/merge_requests?scope=all&state=opened&assignee_id=${currentUser.id}&per_page=100`
      ),
      this.request<MergeRequest[]>(
        `/api/v4/merge_requests?scope=all&state=opened&reviewer_id=${currentUser.id}&per_page=100`
      )
    ]);

    const merged = [...assigned, ...reviewRequested];
    const dedupedById = new Map<number, MergeRequest>();
    for (const mr of merged) {
      dedupedById.set(mr.id, mr);
    }

    return [...dedupedById.values()];
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
