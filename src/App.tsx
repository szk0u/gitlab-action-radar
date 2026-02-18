import { invoke } from '@tauri-apps/api/core';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitLabClient } from './api/gitlabClient';
import { MergeRequestList } from './components/MergeRequestList';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Input } from './components/ui/input';
import { MergeRequestHealth } from './types/gitlab';

const gitlabBaseUrl = import.meta.env.VITE_GITLAB_BASE_URL ?? 'https://gitlab.com';
const gitlabTokenFromEnv = import.meta.env.VITE_GITLAB_TOKEN ?? '';
const gitlabPatIssueUrl =
  import.meta.env.VITE_GITLAB_PAT_ISSUE_URL ?? `${gitlabBaseUrl.replace(/\/$/, '')}/-/user_settings/personal_access_tokens`;

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function App() {
  const [patToken, setPatToken] = useState<string>(gitlabTokenFromEnv);
  const [patInput, setPatInput] = useState<string>('');
  const [hasSavedPatToken, setHasSavedPatToken] = useState<boolean>(false);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [authMessage, setAuthMessage] = useState<string | undefined>();
  const [assignedItems, setAssignedItems] = useState<MergeRequestHealth[]>([]);
  const [reviewRequestedItems, setReviewRequestedItems] = useState<MergeRequestHealth[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const client = useMemo(() => {
    if (!patToken) {
      return undefined;
    }

    return new GitLabClient({ baseUrl: gitlabBaseUrl, token: patToken });
  }, [patToken]);

  useEffect(() => {
    let alive = true;

    const loadSavedPat = async () => {
      if (!isTauriRuntime()) {
        setAuthLoading(false);
        return;
      }

      try {
        const storedToken = await invoke<string | null>('load_pat');
        if (!alive) {
          return;
        }

        if (storedToken && storedToken.trim()) {
          setPatToken(storedToken);
          setHasSavedPatToken(true);
          setAuthMessage('保存済みPATを安全ストアから読み込みました。');
        } else {
          setPatToken(gitlabTokenFromEnv);
          setHasSavedPatToken(false);
        }
      } catch (err) {
        if (!alive) {
          return;
        }

        setPatToken(gitlabTokenFromEnv);
        setHasSavedPatToken(false);
        setAuthMessage(`保存済みPATの読み込みに失敗しました: ${toMessage(err)}`);
      } finally {
        if (alive) {
          setAuthLoading(false);
        }
      }
    };

    void loadSavedPat();

    return () => {
      alive = false;
    };
  }, []);

  const openExternalUrl = useCallback(async (url: string) => {
    if (isTauriRuntime()) {
      try {
        await invoke('open_external_url', { url });
        return;
      } catch {
        // Fall back to browser APIs below.
      }
    }

    const openedWindow = window.open(url, '_blank', 'noopener,noreferrer');
    if (!openedWindow) {
      window.location.assign(url);
    }
  }, []);

  const openPatIssuePage = () => {
    void openExternalUrl(gitlabPatIssueUrl);
  };

  const savePatToken = async () => {
    const token = patInput.trim();
    if (!token) {
      setAuthMessage('PAT を入力してから保存してください。');
      return;
    }

    if (!isTauriRuntime()) {
      setAuthMessage('Tauri ランタイムで起動していないため、安全保存できません。');
      return;
    }

    try {
      await invoke('save_pat', { token });
      setPatToken(token);
      setPatInput('');
      setHasSavedPatToken(true);
      setAuthMessage('PAT を安全ストアに保存しました。');
    } catch (err) {
      setAuthMessage(`PAT の保存に失敗しました: ${toMessage(err)}`);
    }
  };

  const clearSavedPatToken = async () => {
    if (!isTauriRuntime()) {
      setAuthMessage('Tauri ランタイムで起動していないため、保存済みPATを削除できません。');
      return;
    }

    try {
      await invoke('clear_pat');
      setHasSavedPatToken(false);
      setPatToken(gitlabTokenFromEnv);
      setPatInput('');
      setAuthMessage(
        gitlabTokenFromEnv
          ? '保存済みPATを削除し、環境変数の PAT に戻しました。'
          : '保存済みPATを削除しました。'
      );
    } catch (err) {
      setAuthMessage(`保存済みPATの削除に失敗しました: ${toMessage(err)}`);
    }
  };

  const loadMergeRequests = useCallback(async () => {
    if (!client) {
      setAssignedItems([]);
      setReviewRequestedItems([]);
      setLoading(false);
      setError('PAT を保存するか、VITE_GITLAB_TOKEN を設定してください。');
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      const mergeRequests = await client.listMyRelevantMergeRequests();
      const [assignedSignals, reviewRequestedSignals] = await Promise.all([
        client.buildHealthSignals(mergeRequests.assigned, mergeRequests.currentUserId),
        client.buildHealthSignals(mergeRequests.reviewRequested, mergeRequests.currentUserId, {
          includeReviewerChecks: true
        })
      ]);
      setAssignedItems(assignedSignals);
      setReviewRequestedItems(reviewRequestedSignals);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    void loadMergeRequests();
  }, [authLoading, loadMergeRequests]);

  return (
    <main className="min-h-screen bg-radial-[at_50%_0%] from-slate-200 to-slate-100 px-4 py-6 text-slate-900">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <CardTitle className="text-2xl">GitLab Action Radar</CardTitle>
                <CardDescription className="mt-1">Assigned to me / Review requested MRs</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => void loadMergeRequests()} disabled={loading || !client}>
                  <RefreshCw className={loading ? 'animate-spin' : ''} />
                  Reload
                </Button>
                <Button type="button" variant="outline" onClick={openPatIssuePage}>
                  Open PAT page
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                value={patInput}
                onChange={(event) => setPatInput(event.target.value)}
                placeholder="glpat-..."
                aria-label="GitLab PAT"
                className="sm:flex-1"
              />
              <Button type="button" onClick={() => void savePatToken()} disabled={authLoading}>
                Save PAT
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void clearSavedPatToken()}
                disabled={authLoading || !hasSavedPatToken}
              >
                Clear saved PAT
              </Button>
            </div>
            {authMessage && <p className="text-sm text-slate-600">{authMessage}</p>}
            {hasSavedPatToken && <p className="text-sm text-slate-600">現在は安全ストアのPATを使用しています。</p>}
            {!hasSavedPatToken && gitlabTokenFromEnv && (
              <p className="text-sm text-slate-600">現在は環境変数のPATを使用しています。</p>
            )}
          </CardContent>
        </Card>

        <MergeRequestList
          assignedItems={assignedItems}
          reviewRequestedItems={reviewRequestedItems}
          loading={loading}
          error={error}
          onOpenMergeRequest={openExternalUrl}
        />
      </div>
    </main>
  );
}
