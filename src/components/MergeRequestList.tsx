import { AlertCircle, CheckCircle2, GitPullRequest } from 'lucide-react';
import { MergeRequestHealth } from '../types/gitlab';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

interface MergeRequestListProps {
  items: MergeRequestHealth[];
  loading?: boolean;
  error?: string;
}

export function MergeRequestList({ items, loading, error }: MergeRequestListProps) {
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

  if (items.length === 0) {
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
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {items.map(({ mergeRequest, hasFailedCi, hasConflicts, hasPendingApprovals }) => {
        const isAtRisk = hasFailedCi || hasConflicts || hasPendingApprovals;

        return (
          <li key={mergeRequest.id}>
            <Card className={isAtRisk ? 'border-amber-300' : 'border-emerald-200'}>
              <CardHeader className="gap-2 pb-3">
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
      })}
    </ul>
  );
}
