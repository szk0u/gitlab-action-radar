export interface MergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  state: string;
  updated_at?: string;
  assignee?: GitLabUser | null;
  assignees?: GitLabUser[];
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
  reviewers?: MergeRequestReviewer[];
  labels?: Array<string | GitLabLabel>;
  milestone?: GitLabMilestone | null;
  user_notes_count?: number;
  changes_count?: string;
  diffStats?: MergeRequestDiffStats;
  approvals_required?: number;
  approved_by?: Array<{ user: { id: number; name: string } }>;
}

export interface MergeRequestReviewer {
  id: number;
  username?: string;
  name?: string;
  state?: string;
}

export interface GitLabLabel {
  id?: number;
  name: string;
  color?: string;
  text_color?: string;
}

export interface GitLabMilestone {
  id: number;
  iid?: number;
  project_id?: number;
  title: string;
  description?: string;
  state?: string;
  due_date?: string | null;
}

export interface MergeRequestDiffStats {
  changedFiles: number;
  additions?: number;
  deletions?: number;
}

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

export interface MergeRequestHealth {
  mergeRequest: MergeRequest;
  ciStatus: CiStatus;
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
  detailed_merge_status?: string;
  reviewers?: MergeRequestReviewer[];
  labels?: Array<string | GitLabLabel>;
  milestone?: GitLabMilestone | null;
  user_notes_count?: number;
  changes_count?: string;
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
  ciStatus: CiStatus;
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

export interface MergeRequestDiff {
  diff?: string;
}

export type ReviewerReviewStatus = 'needs_review' | 'waiting_for_author' | 'new';

export type CiStatus =
  | 'success'
  | 'failed'
  | 'running'
  | 'pending'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'scheduled'
  | 'created'
  | 'preparing'
  | 'waiting_for_resource'
  | 'unknown';

export interface ReviewerMergeRequestChecks {
  reviewStatus: ReviewerReviewStatus;
  reviewerLastCommentedAt?: string;
  latestCommitAt?: string;
  authorLastCommentedAt?: string;
}
