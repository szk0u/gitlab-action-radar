export interface MergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  state: string;
  updated_at?: string;
  author?: {
    id: number;
    username: string;
    name: string;
  };
  draft?: boolean;
  work_in_progress?: boolean;
  has_conflicts: boolean;
  merge_status: string;
  references?: {
    full?: string;
  };
  pipeline?: {
    status: string;
  };
  approvals_required?: number;
  approved_by?: Array<{ user: { id: number; name: string } }>;
}

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

export interface MergeRequestHealth {
  mergeRequest: MergeRequest;
  hasFailedCi: boolean;
  hasConflicts: boolean;
  hasPendingApprovals: boolean;
  isCreatedByMe: boolean;
  latestCommitAt?: string;
  ownMrChecks?: OwnMergeRequestChecks;
  reviewerChecks?: ReviewerMergeRequestChecks;
}

export interface MyRelevantMergeRequests {
  currentUserId: number;
  assigned: MergeRequest[];
  reviewRequested: MergeRequest[];
}

export interface MergeRequestApprovals {
  approved_by: Array<{ user: { id: number; name: string } }>;
  approved?: boolean;
  approvals_left?: number;
}

export interface MergeRequestDetails {
  blocking_discussions_resolved?: boolean;
  unresolved_discussions_count?: number;
  has_conflicts?: boolean;
  merge_status?: string;
  head_pipeline?: {
    status?: string;
  };
  pipeline?: {
    status?: string;
  };
}

export interface OwnMergeRequestChecks {
  isApproved: boolean;
  hasUnresolvedComments: boolean;
  isCiSuccessful: boolean;
  isCiFailed: boolean;
}

export interface MergeRequestNote {
  id: number;
  created_at: string;
  system?: boolean;
  author?: {
    id: number;
    username: string;
    name: string;
  };
}

export interface MergeRequestCommit {
  id: string;
  created_at?: string;
}

export type ReviewerReviewStatus = 'needs_review' | 'waiting_for_author' | 'new';

export interface ReviewerMergeRequestChecks {
  reviewStatus: ReviewerReviewStatus;
  reviewerLastCommentedAt?: string;
  latestCommitAt?: string;
  authorLastCommentedAt?: string;
}
