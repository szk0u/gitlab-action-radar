import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, FolderGit2, GitPullRequest } from 'lucide-react';
import { CiStatus, MergeRequest, MergeRequestHealth, ReviewerReviewStatus } from '../types/gitlab';
import { cn } from '../lib/utils';
import { Badge, badgeVariants } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

interface MergeRequestListProps {
  assignedItems: MergeRequestHealth[];
  reviewRequestedItems: MergeRequestHealth[];
  ignoredAssignedAlerts?: IgnoredAssignedAlertDisplay[];
  loading?: boolean;
  error?: string;
  onOpenMergeRequest?: (url: string) => void | Promise<void>;
  onIgnoreAssignedUntilNewCommit?: (mergeRequestId: number) => void;
  tabNavigationRequest?: TabNavigationRequest;
}

export type TabKey = 'assigned' | 'review';
type ReviewStatusFilter = ReviewerReviewStatus | 'all';
type AssignedStatusFilter = 'all' | 'conflicts' | 'failed_ci' | 'pending_approvals';
interface TabNavigationRequest {
  tab: TabKey;
  nonce: number;
}

interface IgnoredAssignedAlertDisplay {
  mergeRequestId: number;
  ignoreConflicts: boolean;
  ignoreFailedCi: boolean;
}

function getProjectLabel(mergeRequest: MergeRequest): string {
  const ref = mergeRequest.references?.full;
  if (ref && ref.includes('!')) {
    return ref.split('!')[0] ?? `Project #${mergeRequest.project_id}`;
  }

  try {
    const url = new URL(mergeRequest.web_url);
    const path = url.pathname;

    for (const marker of ['/-/merge_requests/', '/merge_requests/']) {
      if (path.includes(marker)) {
        const [projectPath] = path.split(marker);
        const cleaned = projectPath?.replace(/^\/+/, '');
        if (cleaned) {
          return cleaned;
        }
      }
    }
  } catch {
    // ignore parse failures and fallback to project_id below.
  }

  return `Project #${mergeRequest.project_id}`;
}

function getAssigneeLabel(mergeRequest: MergeRequest): string {
  const assigneeNames = (mergeRequest.assignees ?? []).map((assignee) => assignee.name).filter(Boolean);
  if (assigneeNames.length > 0) {
    return [...new Set(assigneeNames)].join(', ');
  }

  return mergeRequest.assignee?.name ?? 'Unassigned';
}

function getCiStatusLabel(ciStatus: CiStatus): string {
  if (ciStatus === 'waiting_for_resource') {
    return 'waiting for resource';
  }
  return ciStatus;
}

function getCiBadgeVariant(ciStatus: CiStatus): 'destructive' | 'secondary' | undefined {
  if (ciStatus === 'failed') {
    return 'destructive';
  }
  if (ciStatus === 'success') {
    return undefined;
  }
  return 'secondary';
}

function getCiBadgeClassName(ciStatus: CiStatus): string {
  return ciStatus === 'success' ? 'border-transparent bg-emerald-100 text-emerald-700' : '';
}

function renderOwnMergeRequestChecks(item: MergeRequestHealth) {
  if (!item.isCreatedByMe || !item.ownMrChecks) {
    return null;
  }

  const { isApproved, hasUnresolvedComments } = item.ownMrChecks;

  return (
    <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-200 pt-3">
      <Badge className={isApproved ? 'border-transparent bg-emerald-100 text-emerald-700' : ''} variant={isApproved ? undefined : 'warning'}>
        {isApproved ? 'Approved' : 'Not approved'}
      </Badge>
      <Badge
        className={hasUnresolvedComments ? '' : 'border-transparent bg-emerald-100 text-emerald-700'}
        variant={hasUnresolvedComments ? 'destructive' : undefined}
      >
        {hasUnresolvedComments ? 'Unresolved comments' : 'Comments resolved'}
      </Badge>
    </div>
  );
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

interface ReviewerStatusCounts {
  needsReview: number;
  waitingForAuthor: number;
  new: number;
}

interface AssignedStatusCounts {
  conflicts: number;
  failedCi: number;
  pendingApprovals: number;
}

function getReviewStatus(item: MergeRequestHealth): ReviewerReviewStatus {
  return item.reviewerChecks?.reviewStatus ?? 'new';
}

function getReviewStatusPriority(status: ReviewerReviewStatus): number {
  if (status === 'needs_review') {
    return 0;
  }
  if (status === 'new') {
    return 1;
  }
  return 2;
}

function getUpdatedAtMs(value: string | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function sortReviewRequestedItems(items: MergeRequestHealth[]): MergeRequestHealth[] {
  return [...items].sort((left, right) => {
    const leftPriority = getReviewStatusPriority(getReviewStatus(left));
    const rightPriority = getReviewStatusPriority(getReviewStatus(right));
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return getUpdatedAtMs(right.mergeRequest.updated_at) - getUpdatedAtMs(left.mergeRequest.updated_at);
  });
}

function summarizeReviewerStatuses(items: MergeRequestHealth[]): ReviewerStatusCounts {
  const result: ReviewerStatusCounts = {
    needsReview: 0,
    waitingForAuthor: 0,
    new: 0
  };

  for (const item of items) {
    const status = getReviewStatus(item);
    if (status === 'needs_review') {
      result.needsReview += 1;
      continue;
    }
    if (status === 'waiting_for_author') {
      result.waitingForAuthor += 1;
      continue;
    }
    result.new += 1;
  }

  return result;
}

function summarizeAssignedStatuses(items: MergeRequestHealth[]): AssignedStatusCounts {
  const result: AssignedStatusCounts = {
    conflicts: 0,
    failedCi: 0,
    pendingApprovals: 0
  };

  for (const item of items) {
    if (item.hasConflicts) {
      result.conflicts += 1;
    }
    if (item.hasFailedCi) {
      result.failedCi += 1;
    }
    if (item.hasPendingApprovals) {
      result.pendingApprovals += 1;
    }
  }

  return result;
}

function matchesAssignedStatusFilter(item: MergeRequestHealth, filter: AssignedStatusFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'conflicts') {
    return item.hasConflicts;
  }
  if (filter === 'failed_ci') {
    return item.hasFailedCi;
  }
  if (filter === 'pending_approvals') {
    return item.hasPendingApprovals;
  }
  return false;
}

function renderReviewerChecks(item: MergeRequestHealth, tabKey: TabKey) {
  if (tabKey !== 'review' || !item.reviewerChecks) {
    return null;
  }

  const { reviewStatus, reviewerLastCommentedAt, latestCommitAt, authorLastCommentedAt } = item.reviewerChecks;
  const assigneeLabel = getAssigneeLabel(item.mergeRequest);
  const reviewStatusLabel =
    reviewStatus === 'needs_review'
      ? '要レビュー'
      : reviewStatus === 'waiting_for_author'
        ? '作者修正待ち'
        : '未着手';
  const reviewStatusVariant = reviewStatus === 'needs_review' ? 'destructive' : reviewStatus === 'new' ? 'warning' : 'secondary';
  const hasMyComment = Boolean(reviewerLastCommentedAt);

  return (
    <div className="mt-3 space-y-1.5 border-t border-slate-200 pt-3 text-xs text-slate-600">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">Reviewer activity</Badge>
        <Badge variant={reviewStatusVariant}>{reviewStatusLabel}</Badge>
        <Badge
          className={hasMyComment ? 'border-transparent bg-emerald-100 text-emerald-700' : ''}
          variant={hasMyComment ? undefined : 'warning'}
        >
          {hasMyComment ? 'Commented' : 'No comment'}
        </Badge>
      </div>
      <p>担当者: {assigneeLabel}</p>
      <p>My last comment: {formatDateTime(reviewerLastCommentedAt)}</p>
      <p>Latest commit: {formatDateTime(latestCommitAt)}</p>
      <p>Author last comment: {formatDateTime(authorLastCommentedAt)}</p>
    </div>
  );
}

function renderMergeRequestItem(
  item: MergeRequestHealth,
  tabKey: TabKey,
  ignoredAssignedAlert: IgnoredAssignedAlertDisplay | undefined,
  onOpenMergeRequest?: (url: string) => void | Promise<void>,
  onIgnoreAssignedUntilNewCommit?: (mergeRequestId: number) => void
) {
  const { mergeRequest, ciStatus, hasFailedCi, hasConflicts, hasPendingApprovals } = item;
  const isIgnoredConflict = tabKey === 'assigned' && ignoredAssignedAlert?.ignoreConflicts === true && hasConflicts;
  const isIgnoredFailedCi = tabKey === 'assigned' && ignoredAssignedAlert?.ignoreFailedCi === true && hasFailedCi;
  const isIgnoredAssignedUntilNewCommit = isIgnoredConflict || isIgnoredFailedCi;
  const isAtRisk = hasFailedCi || hasConflicts || hasPendingApprovals;
  const canIgnoreUntilNewCommit = tabKey === 'assigned' && (hasConflicts || hasFailedCi) && !!onIgnoreAssignedUntilNewCommit;
  const ignoreButtonLabel = isIgnoredConflict && isIgnoredFailedCi
    ? '競合・CI失敗を無視中（新コミットで解除）'
    : isIgnoredConflict
      ? '競合を無視中（新コミットで解除）'
      : isIgnoredFailedCi
        ? 'CI失敗を無視中（新コミットで解除）'
        : '新しいコミットまで無視';

  return (
    <li key={mergeRequest.id}>
      <Card className={isAtRisk ? 'border-amber-300' : 'border-emerald-200'}>
        <CardHeader className="gap-2 pb-3">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
            <FolderGit2 className="size-3.5" />
            {getProjectLabel(mergeRequest)}
          </p>
          <CardTitle className="min-w-0 text-base leading-snug">
            <a
              href={mergeRequest.web_url}
              target="_blank"
              rel="noreferrer"
              className="flex w-full min-w-0 items-start gap-2 text-slate-900 underline-offset-4 hover:underline"
              onClick={(event) => {
                if (!onOpenMergeRequest) {
                  return;
                }
                event.preventDefault();
                void onOpenMergeRequest(mergeRequest.web_url);
              }}
            >
              <GitPullRequest className="mt-0.5 size-4 shrink-0 text-slate-500" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                !{mergeRequest.iid} {mergeRequest.title}
              </span>
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Badge className={getCiBadgeClassName(ciStatus)} variant={getCiBadgeVariant(ciStatus)}>
              CI {getCiStatusLabel(ciStatus)}
            </Badge>
            <Badge className={hasConflicts ? '' : 'border-transparent bg-emerald-100 text-emerald-700'} variant={hasConflicts ? 'warning' : undefined}>
              {hasConflicts ? 'Conflicts' : 'No conflicts'}
            </Badge>
            {hasPendingApprovals && <Badge variant="secondary">Pending approvals</Badge>}
            {isIgnoredConflict && <Badge variant="secondary">Conflicts ignored</Badge>}
            {isIgnoredFailedCi && <Badge variant="secondary">CI failure ignored</Badge>}
            {!isAtRisk && <Badge variant="outline">Healthy</Badge>}
          </div>
          {canIgnoreUntilNewCommit && (
            <div className="mt-3 border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={() => onIgnoreAssignedUntilNewCommit?.(mergeRequest.id)}
                className={cn(
                  badgeVariants({ variant: 'secondary' }),
                  'cursor-pointer text-xs transition-opacity hover:opacity-90'
                )}
              >
                {ignoreButtonLabel}
              </button>
            </div>
          )}
          {renderOwnMergeRequestChecks(item)}
          {renderReviewerChecks(item, tabKey)}
        </CardContent>
      </Card>
    </li>
  );
}

function renderList(
  items: MergeRequestHealth[],
  emptyMessage: string,
  tabKey: TabKey,
  ignoredAssignedAlertMap: ReadonlyMap<number, IgnoredAssignedAlertDisplay>,
  onOpenMergeRequest?: (url: string) => void | Promise<void>,
  onIgnoreAssignedUntilNewCommit?: (mergeRequestId: number) => void
) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="pt-5 text-sm text-slate-600">{emptyMessage}</CardContent>
      </Card>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {items.map((item) =>
        renderMergeRequestItem(
          item,
          tabKey,
          tabKey === 'assigned' ? ignoredAssignedAlertMap.get(item.mergeRequest.id) : undefined,
          onOpenMergeRequest,
          onIgnoreAssignedUntilNewCommit
        )
      )}
    </ul>
  );
}

export function MergeRequestList({
  assignedItems,
  reviewRequestedItems,
  ignoredAssignedAlerts,
  loading,
  error,
  onOpenMergeRequest,
  onIgnoreAssignedUntilNewCommit,
  tabNavigationRequest
}: MergeRequestListProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('assigned');
  const [assignedStatusFilter, setAssignedStatusFilter] = useState<AssignedStatusFilter>('all');
  const [reviewStatusFilter, setReviewStatusFilter] = useState<ReviewStatusFilter>('all');
  const ignoredAssignedAlertMap = useMemo(
    () => new Map((ignoredAssignedAlerts ?? []).map((entry) => [entry.mergeRequestId, entry])),
    [ignoredAssignedAlerts]
  );
  const filteredAssignedItems = useMemo(
    () => assignedItems.filter((item) => matchesAssignedStatusFilter(item, assignedStatusFilter)),
    [assignedItems, assignedStatusFilter]
  );
  const assignedStatusCounts = useMemo(() => summarizeAssignedStatuses(assignedItems), [assignedItems]);
  const assignedListEmptyMessage = useMemo(() => {
    if (assignedStatusFilter === 'conflicts') {
      return 'No assigned merge requests in 競合.';
    }
    if (assignedStatusFilter === 'failed_ci') {
      return 'No assigned merge requests in CI失敗.';
    }
    if (assignedStatusFilter === 'pending_approvals') {
      return 'No assigned merge requests in 承認待ち.';
    }
    return 'No assigned merge requests.';
  }, [assignedStatusFilter]);
  const sortedReviewRequestedItems = useMemo(
    () => sortReviewRequestedItems(reviewRequestedItems),
    [reviewRequestedItems]
  );
  const filteredReviewRequestedItems = useMemo(() => {
    if (reviewStatusFilter === 'all') {
      return sortedReviewRequestedItems;
    }
    return sortedReviewRequestedItems.filter((item) => getReviewStatus(item) === reviewStatusFilter);
  }, [reviewStatusFilter, sortedReviewRequestedItems]);
  const reviewStatusCounts = useMemo(
    () => summarizeReviewerStatuses(reviewRequestedItems),
    [reviewRequestedItems]
  );
  const reviewListEmptyMessage = useMemo(() => {
    if (reviewStatusFilter === 'needs_review') {
      return 'No review-requested merge requests in 要レビュー.';
    }
    if (reviewStatusFilter === 'new') {
      return 'No review-requested merge requests in 未着手.';
    }
    if (reviewStatusFilter === 'waiting_for_author') {
      return 'No review-requested merge requests in 作者修正待ち.';
    }
    return 'No review-requested merge requests.';
  }, [reviewStatusFilter]);

  const toggleReviewStatusFilter = (status: ReviewerReviewStatus) => {
    setReviewStatusFilter((current) => (current === status ? 'all' : status));
  };
  const toggleAssignedStatusFilter = (status: Exclude<AssignedStatusFilter, 'all'>) => {
    setAssignedStatusFilter((current) => (current === status ? 'all' : status));
  };

  useEffect(() => {
    if (assignedItems.length === 0 && reviewRequestedItems.length > 0) {
      setActiveTab('review');
    }
    if (reviewRequestedItems.length === 0 && assignedItems.length > 0) {
      setActiveTab('assigned');
    }
  }, [assignedItems.length, reviewRequestedItems.length]);

  useEffect(() => {
    if (!tabNavigationRequest) {
      return;
    }
    setActiveTab(tabNavigationRequest.tab);
  }, [tabNavigationRequest]);

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-5 text-sm text-slate-600">Loading merge requests...</CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-red-200">
        <CardContent className="flex items-center gap-2 pt-5 text-sm text-red-700" role="alert">
          <AlertCircle className="size-4" />
          {error}
        </CardContent>
      </Card>
    );
  }

  if (assignedItems.length === 0 && reviewRequestedItems.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 pt-5 text-sm text-slate-600">
          <CheckCircle2 className="size-4" />
          No opened merge requests.
        </CardContent>
      </Card>
    );
  }

  return (
    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabKey)}>
      <TabsList className="grid w-full grid-cols-2 sm:w-[320px]">
        <TabsTrigger value="assigned">Assigned ({assignedItems.length})</TabsTrigger>
        <TabsTrigger value="review">Review requested ({reviewRequestedItems.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="assigned">
        <div className="space-y-3">
          <Card>
            <CardContent className="flex flex-wrap gap-2 pt-4 text-xs text-slate-600">
              <button
                type="button"
                aria-pressed={assignedStatusFilter === 'conflicts'}
                className={cn(
                  badgeVariants({ variant: 'warning' }),
                  'cursor-pointer transition-opacity',
                  assignedStatusFilter === 'conflicts' ? 'ring-2 ring-amber-300 ring-offset-1' : 'opacity-75 hover:opacity-100'
                )}
                onClick={() => toggleAssignedStatusFilter('conflicts')}
              >
                競合 {assignedStatusCounts.conflicts}
              </button>
              <button
                type="button"
                aria-pressed={assignedStatusFilter === 'failed_ci'}
                className={cn(
                  badgeVariants({ variant: 'destructive' }),
                  'cursor-pointer transition-opacity',
                  assignedStatusFilter === 'failed_ci' ? 'ring-2 ring-red-300 ring-offset-1' : 'opacity-75 hover:opacity-100'
                )}
                onClick={() => toggleAssignedStatusFilter('failed_ci')}
              >
                CI失敗 {assignedStatusCounts.failedCi}
              </button>
              <button
                type="button"
                aria-pressed={assignedStatusFilter === 'pending_approvals'}
                className={cn(
                  badgeVariants({ variant: 'secondary' }),
                  'cursor-pointer transition-opacity',
                  assignedStatusFilter === 'pending_approvals' ? 'ring-2 ring-slate-300 ring-offset-1' : 'opacity-75 hover:opacity-100'
                )}
                onClick={() => toggleAssignedStatusFilter('pending_approvals')}
              >
                承認待ち {assignedStatusCounts.pendingApprovals}
              </button>
            </CardContent>
          </Card>
          {renderList(
            filteredAssignedItems,
            assignedListEmptyMessage,
            'assigned',
            ignoredAssignedAlertMap,
            onOpenMergeRequest,
            onIgnoreAssignedUntilNewCommit
          )}
        </div>
      </TabsContent>
      <TabsContent value="review" className="space-y-3">
        <Card>
          <CardContent className="flex flex-wrap gap-2 pt-4 text-xs text-slate-600">
            <button
              type="button"
              aria-pressed={reviewStatusFilter === 'needs_review'}
              className={cn(
                badgeVariants({ variant: 'destructive' }),
                'cursor-pointer transition-opacity',
                reviewStatusFilter === 'needs_review' ? 'ring-2 ring-red-300 ring-offset-1' : 'opacity-75 hover:opacity-100'
              )}
              onClick={() => toggleReviewStatusFilter('needs_review')}
            >
              要レビュー {reviewStatusCounts.needsReview}
            </button>
            <button
              type="button"
              aria-pressed={reviewStatusFilter === 'new'}
              className={cn(
                badgeVariants({ variant: 'warning' }),
                'cursor-pointer transition-opacity',
                reviewStatusFilter === 'new' ? 'ring-2 ring-amber-300 ring-offset-1' : 'opacity-75 hover:opacity-100'
              )}
              onClick={() => toggleReviewStatusFilter('new')}
            >
              未着手 {reviewStatusCounts.new}
            </button>
            <button
              type="button"
              aria-pressed={reviewStatusFilter === 'waiting_for_author'}
              className={cn(
                badgeVariants({ variant: 'secondary' }),
                'cursor-pointer transition-opacity',
                reviewStatusFilter === 'waiting_for_author' ? 'ring-2 ring-slate-300 ring-offset-1' : 'opacity-75 hover:opacity-100'
              )}
              onClick={() => toggleReviewStatusFilter('waiting_for_author')}
            >
              作者修正待ち {reviewStatusCounts.waitingForAuthor}
            </button>
          </CardContent>
        </Card>
        {renderList(
          filteredReviewRequestedItems,
          reviewListEmptyMessage,
          'review',
          ignoredAssignedAlertMap,
          onOpenMergeRequest,
          onIgnoreAssignedUntilNewCommit
        )}
      </TabsContent>
    </Tabs>
  );
}
