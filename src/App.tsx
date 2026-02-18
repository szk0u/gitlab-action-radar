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
const reviewReminderEnabledKey = 'review-reminder-enabled';
const reviewReminderTimesKey = 'review-reminder-times';
const reviewReminderLegacyTimeKey = 'review-reminder-time';
const reviewReminderNotifiedSlotsKey = 'review-reminder-notified-slots';

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function parseTime(value: string): { hours: number; minutes: number } | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return undefined;
  }

  return { hours, minutes };
}

function formatLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeReminderTimes(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (parseTime(value)) {
      unique.add(value);
    }
  }
  return [...unique].sort();
}

function resolveInitialReminderTimes(rawTimes: string | null, legacyTime: string | null): string[] {
  if (rawTimes) {
    try {
      const parsed = JSON.parse(rawTimes) as unknown;
      if (Array.isArray(parsed)) {
        const normalized = normalizeReminderTimes(parsed.filter((value): value is string => typeof value === 'string'));
        if (normalized.length > 0) {
          return normalized;
        }
      }
    } catch {
      // Ignore malformed storage and fallback to legacy/default below.
    }
  }

  if (parseTime(legacyTime ?? '')) {
    return [legacyTime as string];
  }

  return ['09:00'];
}

function parseNotifiedSlots(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((slot): slot is string => typeof slot === 'string');
  } catch {
    return [];
  }
}

interface ReviewStatusCounts {
  total: number;
  needsReview: number;
  waitingForAuthor: number;
  new: number;
}

function summarizeReviewStatusCounts(items: MergeRequestHealth[]): ReviewStatusCounts {
  const result: ReviewStatusCounts = {
    total: items.length,
    needsReview: 0,
    waitingForAuthor: 0,
    new: 0
  };

  for (const item of items) {
    const status = item.reviewerChecks?.reviewStatus ?? 'new';
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
  const [reviewReminderEnabled, setReviewReminderEnabled] = useState(false);
  const [reviewReminderTimes, setReviewReminderTimes] = useState<string[]>(['09:00']);
  const [reviewReminderTimeInput, setReviewReminderTimeInput] = useState('09:00');
  const [notifiedReviewReminderSlots, setNotifiedReviewReminderSlots] = useState<string[]>([]);
  const [reviewReminderMessage, setReviewReminderMessage] = useState<string | undefined>();

  const client = useMemo(() => {
    if (!patToken) {
      return undefined;
    }

    return new GitLabClient({ baseUrl: gitlabBaseUrl, token: patToken });
  }, [patToken]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const enabledValue = window.localStorage.getItem(reviewReminderEnabledKey);
    const timesValue = window.localStorage.getItem(reviewReminderTimesKey);
    const legacyTimeValue = window.localStorage.getItem(reviewReminderLegacyTimeKey);
    const notifiedSlotsValue = window.localStorage.getItem(reviewReminderNotifiedSlotsKey);
    const initialTimes = resolveInitialReminderTimes(timesValue, legacyTimeValue);

    setReviewReminderEnabled(enabledValue === 'true');
    setReviewReminderTimes(initialTimes);
    setReviewReminderTimeInput(initialTimes[0] ?? '09:00');
    setNotifiedReviewReminderSlots(parseNotifiedSlots(notifiedSlotsValue));
    window.localStorage.removeItem(reviewReminderLegacyTimeKey);
  }, []);

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

  const addReviewReminderTime = useCallback(() => {
    if (!parseTime(reviewReminderTimeInput)) {
      setReviewReminderMessage('通知時刻の形式が不正です。');
      return;
    }

    setReviewReminderTimes((previous) => {
      const next = normalizeReminderTimes([...previous, reviewReminderTimeInput]);
      return next;
    });
  }, [reviewReminderTimeInput]);

  const removeReviewReminderTime = useCallback((time: string) => {
    setReviewReminderTimes((previous) => previous.filter((item) => item !== time));
  }, []);

  const notifyReviewReminder = useCallback(async (counts: ReviewStatusCounts, scheduledTime: string) => {
    if (counts.total <= 0) {
      return;
    }

    if (typeof window === 'undefined' || !('Notification' in window)) {
      setReviewReminderMessage('この環境では通知機能を利用できません。');
      return;
    }

    try {
      let permission = Notification.permission;
      if (permission === 'default') {
        permission = await Notification.requestPermission();
      }

      if (permission !== 'granted') {
        setReviewReminderMessage('通知が許可されていないため、リマインドを送信できません。');
        return;
      }

      new Notification('GitLab Action Radar', {
        body: `要レビュー ${counts.needsReview}件 / 作者修正待ち ${counts.waitingForAuthor}件 / 未着手 ${counts.new}件`
      });
      setReviewReminderMessage(
        `リマインド通知を送信しました (${scheduledTime}) - 要レビュー ${counts.needsReview}件 / 作者修正待ち ${counts.waitingForAuthor}件 / 未着手 ${counts.new}件`
      );
    } catch (err) {
      setReviewReminderMessage(`通知送信に失敗しました: ${toMessage(err)}`);
    }
  }, []);

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

  const loadMergeRequests = useCallback(async (options?: { notifyReviewReminder?: boolean; reminderTime?: string }) => {
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

      if (options?.notifyReviewReminder) {
        const reviewStatusCounts = summarizeReviewStatusCounts(reviewRequestedSignals);
        const reminderTimeLabel = options.reminderTime ?? new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date());
        if (reviewStatusCounts.total > 0) {
          await notifyReviewReminder(reviewStatusCounts, reminderTimeLabel);
        } else {
          setReviewReminderMessage(`${reminderTimeLabel} 時点ではレビュー対象のMRはありませんでした。`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [client, notifyReviewReminder]);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    void loadMergeRequests();
  }, [authLoading, loadMergeRequests]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(reviewReminderEnabledKey, String(reviewReminderEnabled));
  }, [reviewReminderEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(reviewReminderTimesKey, JSON.stringify(reviewReminderTimes));
  }, [reviewReminderTimes]);

  useEffect(() => {
    if (!reviewReminderEnabled) {
      return;
    }

    if (typeof window === 'undefined' || !('Notification' in window)) {
      return;
    }

    if (Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, [reviewReminderEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(reviewReminderNotifiedSlotsKey, JSON.stringify(notifiedReviewReminderSlots));
  }, [notifiedReviewReminderSlots]);

  useEffect(() => {
    if (!reviewReminderEnabled || authLoading || !client) {
      return;
    }

    const activeTimes = normalizeReminderTimes(reviewReminderTimes);
    if (activeTimes.length === 0) {
      return;
    }

    const tick = () => {
      const now = new Date();
      const today = formatLocalDate(now);
      const todayPrefix = `${today} `;
      const todaySlots = notifiedReviewReminderSlots.filter((slot) => slot.startsWith(todayPrefix));
      if (todaySlots.length !== notifiedReviewReminderSlots.length) {
        setNotifiedReviewReminderSlots(todaySlots);
      }

      for (const time of activeTimes) {
        const scheduled = parseTime(time);
        if (!scheduled) {
          continue;
        }
        if (now.getHours() !== scheduled.hours || now.getMinutes() !== scheduled.minutes) {
          continue;
        }

        const slotKey = `${today} ${time}`;
        if (todaySlots.includes(slotKey)) {
          continue;
        }

        setNotifiedReviewReminderSlots((previous) => {
          if (previous.includes(slotKey)) {
            return previous;
          }
          return [...previous, slotKey];
        });
        void loadMergeRequests({ notifyReviewReminder: true, reminderTime: time });
        break;
      }
    };

    tick();
    const intervalId = window.setInterval(tick, 20_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [authLoading, client, loadMergeRequests, notifiedReviewReminderSlots, reviewReminderEnabled, reviewReminderTimes]);

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

            <div className="space-y-2 border-t border-slate-200 pt-3">
              <p className="text-sm font-medium text-slate-700">Review reminder</p>
              <div className="flex flex-col gap-2">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={reviewReminderEnabled}
                    onChange={(event) => setReviewReminderEnabled(event.target.checked)}
                    className="size-4"
                  />
                  Enable reminder
                </label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    type="time"
                    value={reviewReminderTimeInput}
                    onChange={(event) => setReviewReminderTimeInput(event.target.value)}
                    step={60}
                    disabled={!reviewReminderEnabled}
                    className="sm:w-[160px]"
                    aria-label="Review reminder time"
                  />
                  <Button type="button" variant="outline" onClick={addReviewReminderTime} disabled={!reviewReminderEnabled}>
                    Add time
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {reviewReminderTimes.length > 0 ? (
                    reviewReminderTimes.map((time) => (
                      <Button
                        key={time}
                        type="button"
                        variant="secondary"
                        onClick={() => removeReviewReminderTime(time)}
                        disabled={!reviewReminderEnabled}
                      >
                        {time} Remove
                      </Button>
                    ))
                  ) : (
                    <p className="text-xs text-slate-500">通知時刻が未設定です。</p>
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-600">設定した各時刻に review requested MR があればOS通知します。</p>
              {reviewReminderMessage && <p className="text-xs text-slate-600">{reviewReminderMessage}</p>}
            </div>
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
