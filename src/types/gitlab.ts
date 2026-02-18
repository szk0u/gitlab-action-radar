export interface MergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  state: string;
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
}

export interface MyRelevantMergeRequests {
  assigned: MergeRequest[];
  reviewRequested: MergeRequest[];
}

export interface MergeRequestApprovals {
  approved_by: Array<{ user: { id: number; name: string } }>;
}
