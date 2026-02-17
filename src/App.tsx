import { useEffect, useMemo, useState } from 'react';
import { GitLabClient } from './api/gitlabClient';
import { MergeRequestList } from './components/MergeRequestList';
import { MergeRequestHealth } from './types/gitlab';

const gitlabBaseUrl = import.meta.env.VITE_GITLAB_BASE_URL ?? 'https://gitlab.com';
const gitlabToken = import.meta.env.VITE_GITLAB_TOKEN ?? '';

export function App() {
  const client = useMemo(() => new GitLabClient({ baseUrl: gitlabBaseUrl, token: gitlabToken }), []);
  const [items, setItems] = useState<MergeRequestHealth[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!gitlabToken) {
      setError('Set VITE_GITLAB_TOKEN in your environment.');
      return;
    }

    const load = async () => {
      setLoading(true);
      setError(undefined);
      try {
        const mergeRequests = await client.listMyRelevantMergeRequests();
        setItems(client.buildHealthSignals(mergeRequests));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [client]);

  return (
    <main className="app-shell">
      <h1>GitLab Action Radar</h1>
      <p className="subtitle">Assigned to me / Review requested MRs</p>
      <MergeRequestList items={items} loading={loading} error={error} />
    </main>
  );
}
