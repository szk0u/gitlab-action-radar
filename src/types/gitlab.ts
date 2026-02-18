export interface MergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  state: string;
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
  ownMrChecks?: OwnMergeRequestChecks;
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
