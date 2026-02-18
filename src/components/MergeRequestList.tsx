import { AlertCircle, CheckCircle2, FolderGit2, GitPullRequest } from 'lucide-react';
import { MergeRequest, MergeRequestHealth } from '../types/gitlab';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

interface MergeRequestListProps {
  assignedItems: MergeRequestHealth[];
  reviewRequestedItems: MergeRequestHealth[];
  loading?: boolean;
  error?: string;
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

function renderMergeRequestItem(item: MergeRequestHealth) {
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
        </CardContent>
      </Card>
    </li>
  );
}

function renderSection(title: string, items: MergeRequestHealth[], emptyMessage: string) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <Card>
          <CardContent className="pt-5 text-sm text-slate-600">{emptyMessage}</CardContent>
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">{items.map(renderMergeRequestItem)}</ul>
      )}
    </section>
  );
}

export function MergeRequestList({ assignedItems, reviewRequestedItems, loading, error }: MergeRequestListProps) {
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
    <div className="space-y-5">
      {renderSection('Assigned to me', assignedItems, 'No assigned merge requests.')}
      {renderSection('Review requested', reviewRequestedItems, 'No review-requested merge requests.')}
    </div>
  );
}
