export interface MergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  state: string;
  has_conflicts: boolean;
  merge_status: string;
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
