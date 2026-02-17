import { MergeRequestHealth } from '../types/gitlab';

interface MergeRequestListProps {
  items: MergeRequestHealth[];
  loading?: boolean;
  error?: string;
}

export function MergeRequestList({ items, loading, error }: MergeRequestListProps) {
  if (loading) {
    return <p>Loading merge requests...</p>;
  }

  if (error) {
    return <p role="alert">{error}</p>;
  }

  if (items.length === 0) {
    return <p>No opened merge requests.</p>;
  }

  return (
    <ul className="mr-list">
      {items.map(({ mergeRequest, hasFailedCi, hasConflicts, hasPendingApprovals }) => (
        <li key={mergeRequest.id} className="mr-card">
          <a href={mergeRequest.web_url} target="_blank" rel="noreferrer">
            !{mergeRequest.iid} {mergeRequest.title}
          </a>
          <div className="flags">
            {hasFailedCi && <span className="flag danger">CI failure</span>}
            {hasConflicts && <span className="flag warning">Conflicts</span>}
            {hasPendingApprovals && <span className="flag neutral">Pending approvals</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
