import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FolderGit2, GitPullRequest } from 'lucide-react';
import { MergeRequest, MergeRequestHealth } from '../types/gitlab';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

interface MergeRequestListProps {
  assignedItems: MergeRequestHealth[];
  reviewRequestedItems: MergeRequestHealth[];
  loading?: boolean;
  error?: string;
  onOpenMergeRequest?: (url: string) => void | Promise<void>;
}

type TabKey = 'assigned' | 'review';

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

function renderOwnMergeRequestChecks(item: MergeRequestHealth) {
  if (!item.isCreatedByMe || !item.ownMrChecks) {
    return null;
  }

  const { isApproved, hasUnresolvedComments, isCiSuccessful } = item.ownMrChecks;

  return (
    <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-200 pt-3">
      <Badge variant="outline">My MR</Badge>
      <Badge className={isApproved ? 'border-transparent bg-emerald-100 text-emerald-700' : ''} variant={isApproved ? undefined : 'warning'}>
        {isApproved ? 'Approved' : 'Not approved'}
      </Badge>
      <Badge
        className={hasUnresolvedComments ? '' : 'border-transparent bg-emerald-100 text-emerald-700'}
        variant={hasUnresolvedComments ? 'destructive' : undefined}
      >
        {hasUnresolvedComments ? 'Unresolved comments' : 'Comments resolved'}
      </Badge>
      <Badge className={isCiSuccessful ? 'border-transparent bg-emerald-100 text-emerald-700' : ''} variant={isCiSuccessful ? undefined : 'secondary'}>
        {isCiSuccessful ? 'CI success' : 'CI not success'}
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

function renderReviewerChecks(item: MergeRequestHealth, tabKey: TabKey) {
  if (tabKey !== 'review' || !item.reviewerChecks) {
    return null;
  }

  const { hasMyComment, myLastCommentedAt, latestActivity } = item.reviewerChecks;
  const latestActivityLabel =
    latestActivity === 'mr_update'
      ? 'MR更新が最新'
      : latestActivity === 'my_comment'
        ? '自分のコメントが最新'
        : latestActivity === 'same_time'
          ? '同時刻'
          : '比較不可';

  return (
    <div className="mt-3 space-y-1.5 border-t border-slate-200 pt-3 text-xs text-slate-600">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">Reviewer activity</Badge>
        <Badge
          className={hasMyComment ? 'border-transparent bg-emerald-100 text-emerald-700' : ''}
          variant={hasMyComment ? undefined : 'warning'}
        >
          {hasMyComment ? 'Commented' : 'No comment'}
        </Badge>
      </div>
      <p>MR updated: {formatDateTime(item.mergeRequest.updated_at)}</p>
      <p>My last comment: {formatDateTime(myLastCommentedAt)}</p>
      <p>Latest: {latestActivityLabel}</p>
    </div>
  );
}

function renderMergeRequestItem(
  item: MergeRequestHealth,
  tabKey: TabKey,
  onOpenMergeRequest?: (url: string) => void | Promise<void>
) {
  const { mergeRequest, hasFailedCi, hasConflicts, hasPendingApprovals } = item;
  const isAtRisk = hasFailedCi || hasConflicts || hasPendingApprovals;

  return (
    <li key={mergeRequest.id}>
      <Card className={isAtRisk ? 'border-amber-300' : 'border-emerald-200'}>
        <CardHeader className="gap-2 pb-3">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
            <FolderGit2 className="size-3.5" />
            {getProjectLabel(mergeRequest)}
          </p>
          <CardTitle className="text-base leading-snug">
            <a
              href={mergeRequest.web_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-start gap-2 text-slate-900 underline-offset-4 hover:underline"
              onClick={(event) => {
                if (!onOpenMergeRequest) {
                  return;
                }
                event.preventDefault();
                void onOpenMergeRequest(mergeRequest.web_url);
              }}
            >
              <GitPullRequest className="mt-0.5 size-4 shrink-0 text-slate-500" />
              <span>
                !{mergeRequest.iid} {mergeRequest.title}
              </span>
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {hasFailedCi && <Badge variant="destructive">CI failure</Badge>}
            {hasConflicts && <Badge variant="warning">Conflicts</Badge>}
            {hasPendingApprovals && <Badge variant="secondary">Pending approvals</Badge>}
            {!isAtRisk && <Badge variant="outline">Healthy</Badge>}
          </div>
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
  onOpenMergeRequest?: (url: string) => void | Promise<void>
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
      {items.map((item) => renderMergeRequestItem(item, tabKey, onOpenMergeRequest))}
    </ul>
  );
}

export function MergeRequestList({
  assignedItems,
  reviewRequestedItems,
  loading,
  error,
  onOpenMergeRequest
}: MergeRequestListProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('assigned');

  useEffect(() => {
    if (assignedItems.length === 0 && reviewRequestedItems.length > 0) {
      setActiveTab('review');
    }
    if (reviewRequestedItems.length === 0 && assignedItems.length > 0) {
      setActiveTab('assigned');
    }
  }, [assignedItems.length, reviewRequestedItems.length]);

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
        {renderList(assignedItems, 'No assigned merge requests.', 'assigned', onOpenMergeRequest)}
      </TabsContent>
      <TabsContent value="review">
        {renderList(reviewRequestedItems, 'No review-requested merge requests.', 'review', onOpenMergeRequest)}
      </TabsContent>
    </Tabs>
  );
}
