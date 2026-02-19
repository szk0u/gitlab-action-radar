import { invoke } from '@tauri-apps/api/core';
import { requestPermission as requestNotificationPermissionApi, sendNotification } from '@tauri-apps/plugin-notification';
import { Store } from '@tauri-apps/plugin-store';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitLabClient } from './api/gitlabClient';
import { MergeRequestList } from './components/MergeRequestList';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Input } from './components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { AssignedAlertSnapshot, AssignedAlertDiff, buildAssignedAlertSnapshot, detectAssignedAlertDiff } from './lib/assignedAlertDiff';
import { MergeRequestHealth } from './types/gitlab';

const gitlabBaseUrl = import.meta.env.VITE_GITLAB_BASE_URL ?? 'https://gitlab.com';
const gitlabTokenFromEnv = import.meta.env.VITE_GITLAB_TOKEN ?? '';
const gitlabPatIssueUrl =
  import.meta.env.VITE_GITLAB_PAT_ISSUE_URL ?? `${gitlabBaseUrl.replace(/\/$/, '')}/-/user_settings/personal_access_tokens`;
const localStorageReviewReminderEnabledKey = 'review-reminder-enabled';
const localStorageReviewReminderTimesKey = 'review-reminder-times';
const localStorageReviewReminderLegacyTimeKey = 'review-reminder-time';
const localStorageReviewReminderNotifiedSlotsKey = 'review-reminder-notified-slots';
const localStorageAutoPollingEnabledKey = 'auto-polling-enabled';
const localStorageAutoPollingIntervalMinutesKey = 'auto-polling-interval-minutes';
const localStorageAssignedAlertSnapshotKey = 'assigned-alert-snapshot';
const localStorageAssignedAlertSnapshotInitializedKey = 'assigned-alert-snapshot-initialized';
const localStorageAssignedAlertSnapshotUserIdKey = 'assigned-alert-snapshot-user-id';
const appSettingsStorePath = 'app-settings.json';
const appSettingsStoreKey = 'settings';
const defaultAutoPollingIntervalMinutes = 1;
const minAutoPollingIntervalMinutes = 1;
const maxAutoPollingIntervalMinutes = 60;

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
        return normalizeReminderTimes(parsed.filter((value): value is string => typeof value === 'string'));
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

function normalizePollingIntervalMinutes(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultAutoPollingIntervalMinutes;
  }

  const rounded = Math.round(value);
  if (rounded < minAutoPollingIntervalMinutes) {
    return minAutoPollingIntervalMinutes;
  }
  if (rounded > maxAutoPollingIntervalMinutes) {
    return maxAutoPollingIntervalMinutes;
  }
  return rounded;
}

function parseAutoPollingIntervalMinutes(value: string | null): number {
  if (!value) {
    return defaultAutoPollingIntervalMinutes;
  }

  const parsed = Number(value);
  return normalizePollingIntervalMinutes(parsed);
}

interface AssignedAlertSnapshotEntry {
  mergeRequestId: number;
  hasConflicts: boolean;
  hasFailedCi: boolean;
}

function normalizeAssignedAlertSnapshotUserId(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function normalizeAssignedAlertSnapshotEntries(rawEntries: unknown): AssignedAlertSnapshotEntry[] {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const deduped = new Map<number, AssignedAlertSnapshotEntry>();
  for (const rawEntry of rawEntries) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      continue;
    }

    const entry = rawEntry as Partial<AssignedAlertSnapshotEntry>;
    if (typeof entry.mergeRequestId !== 'number' || !Number.isInteger(entry.mergeRequestId) || entry.mergeRequestId <= 0) {
      continue;
    }

    deduped.set(entry.mergeRequestId, {
      mergeRequestId: entry.mergeRequestId,
      hasConflicts: entry.hasConflicts === true,
      hasFailedCi: entry.hasFailedCi === true
    });
  }

  return [...deduped.values()].sort((left, right) => left.mergeRequestId - right.mergeRequestId);
}

function parseAssignedAlertSnapshotEntries(value: string | null): AssignedAlertSnapshotEntry[] {
  if (!value) {
    return [];
  }

  try {
    return normalizeAssignedAlertSnapshotEntries(JSON.parse(value));
  } catch {
    return [];
  }
}

function parseAssignedAlertSnapshotUserId(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return normalizeAssignedAlertSnapshotUserId(parsed);
}

function restoreAssignedAlertSnapshot(entries: AssignedAlertSnapshotEntry[]): Map<number, AssignedAlertSnapshot> {
  const snapshot = new Map<number, AssignedAlertSnapshot>();
  for (const entry of entries) {
    snapshot.set(entry.mergeRequestId, {
      hasConflicts: entry.hasConflicts,
      hasFailedCi: entry.hasFailedCi
    });
  }
  return snapshot;
}

function serializeAssignedAlertSnapshotEntries(snapshot: ReadonlyMap<number, AssignedAlertSnapshot>): AssignedAlertSnapshotEntry[] {
  return [...snapshot.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([mergeRequestId, value]) => ({
      mergeRequestId,
      hasConflicts: value.hasConflicts,
      hasFailedCi: value.hasFailedCi
    }));
}

interface AppSettingsPayload {
  reviewReminderEnabled?: boolean;
  reviewReminderTimes?: string[];
  notifiedReviewReminderSlots?: string[];
  autoPollingEnabled?: boolean;
  autoPollingIntervalMinutes?: number;
  assignedAlertSnapshot?: AssignedAlertSnapshotEntry[];
  assignedAlertSnapshotInitialized?: boolean;
  assignedAlertSnapshotUserId?: number;
}

interface AppSettings {
  reviewReminderEnabled: boolean;
  reviewReminderTimes: string[];
  notifiedReviewReminderSlots: string[];
  autoPollingEnabled: boolean;
  autoPollingIntervalMinutes: number;
  assignedAlertSnapshot: AssignedAlertSnapshotEntry[];
  assignedAlertSnapshotInitialized: boolean;
  assignedAlertSnapshotUserId?: number;
}

function serializeSettings(settings: AppSettings): string {
  return JSON.stringify(settings);
}

function normalizeAppSettings(payload: AppSettingsPayload | null | undefined): AppSettings {
  const times =
    payload && Array.isArray(payload.reviewReminderTimes)
      ? normalizeReminderTimes(payload.reviewReminderTimes.filter((value): value is string => typeof value === 'string'))
      : ['09:00'];
  const notifiedSlots =
    payload && Array.isArray(payload.notifiedReviewReminderSlots)
      ? payload.notifiedReviewReminderSlots.filter((slot): slot is string => typeof slot === 'string')
      : [];
  const assignedAlertSnapshotUserId = normalizeAssignedAlertSnapshotUserId(payload?.assignedAlertSnapshotUserId);
  const assignedAlertSnapshotInitialized = payload?.assignedAlertSnapshotInitialized === true && assignedAlertSnapshotUserId != null;
  const assignedAlertSnapshot = assignedAlertSnapshotInitialized
    ? normalizeAssignedAlertSnapshotEntries(payload?.assignedAlertSnapshot)
    : [];

  return {
    reviewReminderEnabled: payload?.reviewReminderEnabled === true,
    reviewReminderTimes: times,
    notifiedReviewReminderSlots: notifiedSlots,
    autoPollingEnabled: payload?.autoPollingEnabled == null ? true : payload.autoPollingEnabled === true,
    autoPollingIntervalMinutes: normalizePollingIntervalMinutes(payload?.autoPollingIntervalMinutes ?? defaultAutoPollingIntervalMinutes),
    assignedAlertSnapshot,
    assignedAlertSnapshotInitialized,
    assignedAlertSnapshotUserId
  };
}

function loadLegacyLocalStorageSettings(): AppSettings {
  if (typeof window === 'undefined') {
    return normalizeAppSettings(undefined);
  }

  const enabledValue = window.localStorage.getItem(localStorageReviewReminderEnabledKey);
  const timesValue = window.localStorage.getItem(localStorageReviewReminderTimesKey);
  const legacyTimeValue = window.localStorage.getItem(localStorageReviewReminderLegacyTimeKey);
  const notifiedSlotsValue = window.localStorage.getItem(localStorageReviewReminderNotifiedSlotsKey);
  const autoPollingEnabledValue = window.localStorage.getItem(localStorageAutoPollingEnabledKey);
  const autoPollingIntervalMinutesValue = window.localStorage.getItem(localStorageAutoPollingIntervalMinutesKey);
  const assignedAlertSnapshotValue = window.localStorage.getItem(localStorageAssignedAlertSnapshotKey);
  const assignedAlertSnapshotInitializedValue = window.localStorage.getItem(localStorageAssignedAlertSnapshotInitializedKey);
  const assignedAlertSnapshotUserIdValue = window.localStorage.getItem(localStorageAssignedAlertSnapshotUserIdKey);
  const assignedAlertSnapshotUserId = parseAssignedAlertSnapshotUserId(assignedAlertSnapshotUserIdValue);
  const assignedAlertSnapshotInitialized =
    assignedAlertSnapshotInitializedValue === 'true' && assignedAlertSnapshotUserId != null;

  return {
    reviewReminderEnabled: enabledValue === 'true',
    reviewReminderTimes: resolveInitialReminderTimes(timesValue, legacyTimeValue),
    notifiedReviewReminderSlots: parseNotifiedSlots(notifiedSlotsValue),
    autoPollingEnabled: autoPollingEnabledValue == null ? true : autoPollingEnabledValue === 'true',
    autoPollingIntervalMinutes: parseAutoPollingIntervalMinutes(autoPollingIntervalMinutesValue),
    assignedAlertSnapshot: assignedAlertSnapshotInitialized ? parseAssignedAlertSnapshotEntries(assignedAlertSnapshotValue) : [],
    assignedAlertSnapshotInitialized,
    assignedAlertSnapshotUserId
  };
}

function saveSettingsToLegacyLocalStorage(settings: AppSettings): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(localStorageReviewReminderEnabledKey, String(settings.reviewReminderEnabled));
  window.localStorage.setItem(localStorageReviewReminderTimesKey, JSON.stringify(settings.reviewReminderTimes));
  window.localStorage.setItem(localStorageReviewReminderNotifiedSlotsKey, JSON.stringify(settings.notifiedReviewReminderSlots));
  window.localStorage.setItem(localStorageAutoPollingEnabledKey, String(settings.autoPollingEnabled));
  window.localStorage.setItem(localStorageAutoPollingIntervalMinutesKey, String(settings.autoPollingIntervalMinutes));
  window.localStorage.setItem(localStorageAssignedAlertSnapshotKey, JSON.stringify(settings.assignedAlertSnapshot));
  window.localStorage.setItem(
    localStorageAssignedAlertSnapshotInitializedKey,
    String(settings.assignedAlertSnapshotInitialized)
  );

  if (settings.assignedAlertSnapshotUserId == null) {
    window.localStorage.removeItem(localStorageAssignedAlertSnapshotUserIdKey);
  } else {
    window.localStorage.setItem(localStorageAssignedAlertSnapshotUserIdKey, String(settings.assignedAlertSnapshotUserId));
  }
}

interface ReviewStatusCounts {
  total: number;
  needsReview: number;
  waitingForAuthor: number;
  new: number;
}

interface TrayIndicatorSummary {
  conflictCount: number;
  failedCiCount: number;
  reviewPendingCount: number;
  actionableTotalCount: number;
}

type NotificationPermissionState = NotificationPermission | 'unsupported';

function normalizeNotificationPermissionState(value: string): NotificationPermissionState {
  if (value === 'granted' || value === 'denied' || value === 'default') {
    return value;
  }
  return 'default';
}

function getNotificationPermissionState(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }

  const permission = await requestNotificationPermissionApi();
  return normalizeNotificationPermissionState(permission);
}

function getNotificationPermissionLabel(permission: NotificationPermissionState): string {
  if (permission === 'granted') {
    return '許可済み';
  }
  if (permission === 'denied') {
    return '拒否';
  }
  if (permission === 'default') {
    return '未選択';
  }
  return '非対応環境';
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

function summarizeTrayIndicator(
  assigned: MergeRequestHealth[],
  reviewRequested: MergeRequestHealth[]
): TrayIndicatorSummary {
  let conflictCount = 0;
  let failedCiCount = 0;
  let reviewPendingCount = 0;
  const actionableMergeRequestIds = new Set<number>();

  for (const item of assigned) {
    if (item.hasConflicts) {
      conflictCount += 1;
      actionableMergeRequestIds.add(item.mergeRequest.id);
    }

    if (item.hasFailedCi) {
      failedCiCount += 1;
      actionableMergeRequestIds.add(item.mergeRequest.id);
    }
  }

  for (const item of reviewRequested) {
    const status = item.reviewerChecks?.reviewStatus ?? 'new';
    if (status === 'needs_review' || status === 'new') {
      reviewPendingCount += 1;
      actionableMergeRequestIds.add(item.mergeRequest.id);
    }
  }

  return {
    conflictCount,
    failedCiCount,
    reviewPendingCount,
    actionableTotalCount: actionableMergeRequestIds.size
  };
}

function getMergeRequestLabel(item: MergeRequestHealth): string {
  const reference = item.mergeRequest.references?.full?.trim();
  if (reference) {
    return reference;
  }
  return `!${item.mergeRequest.iid}`;
}

function buildImmediateAlertNotificationBody(diff: AssignedAlertDiff): string {
  const segments: string[] = [];
  if (diff.newlyConflicted.length > 0) {
    segments.push(`新規競合 ${diff.newlyConflicted.length}件`);
  }
  if (diff.newlyFailedCi.length > 0) {
    segments.push(`新規CI失敗 ${diff.newlyFailedCi.length}件`);
  }

  const labelSet = new Set<string>();
  for (const item of diff.newlyConflicted) {
    labelSet.add(getMergeRequestLabel(item));
  }
  for (const item of diff.newlyFailedCi) {
    labelSet.add(getMergeRequestLabel(item));
  }

  const labels = [...labelSet];
  const previewLabels = labels.slice(0, 3);
  const restCount = labels.length - previewLabels.length;
  const detail = previewLabels.join(', ');
  const restSuffix = restCount > 0 ? ` ほか${restCount}件` : '';
  return `${segments.join(' / ')}${detail ? ` (${detail}${restSuffix})` : ''}`;
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
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(() =>
    getNotificationPermissionState()
  );
  const [autoPollingEnabled, setAutoPollingEnabled] = useState(true);
  const [autoPollingIntervalMinutes, setAutoPollingIntervalMinutes] = useState(defaultAutoPollingIntervalMinutes);
  const [assignedAlertSnapshotEntries, setAssignedAlertSnapshotEntries] = useState<AssignedAlertSnapshotEntry[]>([]);
  const [assignedAlertSnapshotInitialized, setAssignedAlertSnapshotInitialized] = useState(false);
  const [assignedAlertSnapshotUserId, setAssignedAlertSnapshotUserId] = useState<number | undefined>();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const loadInFlightRef = useRef(false);
  const assignedAlertSnapshotRef = useRef<Map<number, AssignedAlertSnapshot>>(new Map());
  const assignedAlertSnapshotInitializedRef = useRef(false);
  const assignedAlertSnapshotUserIdRef = useRef<number | undefined>(undefined);
  const settingsStoreRef = useRef<Store | null>(null);
  const lastPersistedSettingsRef = useRef<string | null>(null);
  const getSettingsStore = useCallback(async (): Promise<Store> => {
    if (settingsStoreRef.current) {
      return settingsStoreRef.current;
    }

    const store = await Store.load(appSettingsStorePath);
    settingsStoreRef.current = store;
    return store;
  }, []);
  const saveAppSettings = useCallback(async (settings: AppSettings): Promise<void> => {
    const serializedSettings = serializeSettings(settings);
    if (lastPersistedSettingsRef.current === serializedSettings) {
      return;
    }

    if (isTauriRuntime()) {
      const settingsStore = await getSettingsStore();
      await settingsStore.set(appSettingsStoreKey, settings);
      await settingsStore.save();
    } else {
      saveSettingsToLegacyLocalStorage(settings);
    }

    lastPersistedSettingsRef.current = serializedSettings;
  }, [getSettingsStore]);

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

    let alive = true;
    const applySettings = (settings: AppSettings) => {
      setReviewReminderEnabled(settings.reviewReminderEnabled);
      setReviewReminderTimes(settings.reviewReminderTimes);
      setReviewReminderTimeInput(settings.reviewReminderTimes[0] ?? '09:00');
      setNotifiedReviewReminderSlots(settings.notifiedReviewReminderSlots);
      setAutoPollingEnabled(settings.autoPollingEnabled);
      setAutoPollingIntervalMinutes(settings.autoPollingIntervalMinutes);
      setAssignedAlertSnapshotEntries(settings.assignedAlertSnapshot);
      setAssignedAlertSnapshotInitialized(settings.assignedAlertSnapshotInitialized);
      setAssignedAlertSnapshotUserId(settings.assignedAlertSnapshotUserId);
      assignedAlertSnapshotRef.current = restoreAssignedAlertSnapshot(settings.assignedAlertSnapshot);
      assignedAlertSnapshotInitializedRef.current = settings.assignedAlertSnapshotInitialized;
      assignedAlertSnapshotUserIdRef.current = settings.assignedAlertSnapshotUserId;
    };

    const loadSettings = async () => {
      const tauriRuntime = isTauriRuntime();
      let nextSettings: AppSettings | undefined;

      if (tauriRuntime) {
        try {
          const settingsStore = await getSettingsStore();
          const storedSettings = await settingsStore.get<AppSettingsPayload>(appSettingsStoreKey);
          if (storedSettings) {
            nextSettings = normalizeAppSettings(storedSettings);
            lastPersistedSettingsRef.current = serializeSettings(nextSettings);
          }
        } catch {
          // Ignore Tauri settings load failure and fallback to legacy localStorage.
        }
      }

      if (!nextSettings) {
        nextSettings = loadLegacyLocalStorageSettings();
        window.localStorage.removeItem(localStorageReviewReminderLegacyTimeKey);

        if (tauriRuntime) {
          try {
            await saveAppSettings(nextSettings);
          } catch {
            // Ignore migration failure and keep the loaded in-memory settings.
          }
        } else {
          lastPersistedSettingsRef.current = serializeSettings(nextSettings);
        }
      }

      if (!alive) {
        return;
      }

      applySettings(nextSettings);
      setSettingsLoaded(true);
    };

    void loadSettings();

    return () => {
      alive = false;
    };
  }, [getSettingsStore, saveAppSettings]);

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

  const ensureNotificationPermissionForSend = useCallback(async (): Promise<NotificationPermissionState> => {
    const currentPermission = getNotificationPermissionState();
    if (currentPermission === 'unsupported') {
      setNotificationPermission(currentPermission);
      return currentPermission;
    }

    let nextPermission: NotificationPermissionState = currentPermission;
    if (currentPermission === 'default') {
      nextPermission = await requestNotificationPermission();
    }

    setNotificationPermission(nextPermission);
    return nextPermission;
  }, []);

  const refreshNotificationPermission = useCallback(() => {
    setNotificationPermission(getNotificationPermissionState());
  }, []);

  const openNotificationPermissionScreen = useCallback(async () => {
    const currentPermission = getNotificationPermissionState();
    setNotificationPermission(currentPermission);

    if (currentPermission === 'unsupported') {
      setReviewReminderMessage('この環境では通知機能を利用できません。');
      return;
    }

    if (currentPermission === 'default') {
      try {
        const nextPermission = await requestNotificationPermission();
        setNotificationPermission(nextPermission);
        if (nextPermission === 'granted') {
          setReviewReminderMessage('通知が許可されました。');
        } else {
          setReviewReminderMessage('通知が未許可のため、リマインドは送信されません。');
        }
      } catch (err) {
        setReviewReminderMessage(`通知許可の確認に失敗しました: ${toMessage(err)}`);
      }
      return;
    }

    if (isTauriRuntime()) {
      try {
        await invoke('open_notification_settings');
        setReviewReminderMessage('OSの通知設定を開きました。許可後に画面を再表示してください。');
      } catch (err) {
        setReviewReminderMessage(`通知設定を開けませんでした: ${toMessage(err)}`);
      }
      return;
    }

    if (currentPermission === 'denied') {
      setReviewReminderMessage('通知が拒否されています。ブラウザ設定から通知を許可してください。');
      return;
    }

    setReviewReminderMessage('通知はすでに許可されています。');
  }, []);

  const sendTestNotification = useCallback(async () => {
    const permission = await ensureNotificationPermissionForSend();
    if (permission === 'unsupported') {
      setReviewReminderMessage('この環境では通知機能を利用できません。');
      return;
    }

    if (permission !== 'granted') {
      setReviewReminderMessage('通知が未許可です。先に通知許可を設定してください。');
      return;
    }

    try {
      sendNotification({
        title: 'GitLab Action Radar',
        body: 'テスト通知です。通知一覧に表示されるか確認してください。'
      });
      setReviewReminderMessage('テスト通知を送信しました。');
    } catch (err) {
      setReviewReminderMessage(`テスト通知の送信に失敗しました: ${toMessage(err)}`);
    }
  }, [ensureNotificationPermissionForSend]);

  const updateTrayIndicator = useCallback(async (summary: TrayIndicatorSummary) => {
    if (!isTauriRuntime()) {
      return;
    }

    try {
      await invoke('update_tray_indicator', { payload: summary });
    } catch {
      // Ignore tray update failures and keep the current UI behavior.
    }
  }, []);

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

    const permission = await ensureNotificationPermissionForSend();
    if (permission === 'unsupported') {
      setReviewReminderMessage('この環境では通知機能を利用できません。');
      return;
    }

    if (permission !== 'granted') {
      setReviewReminderMessage('通知が許可されていないため、リマインドを送信できません。');
      return;
    }

    try {
      sendNotification({
        title: 'GitLab Action Radar',
        body: `要レビュー ${counts.needsReview}件 / 作者修正待ち ${counts.waitingForAuthor}件 / 未着手 ${counts.new}件`
      });
      setReviewReminderMessage(
        `リマインド通知を送信しました (${scheduledTime}) - 要レビュー ${counts.needsReview}件 / 作者修正待ち ${counts.waitingForAuthor}件 / 未着手 ${counts.new}件`
      );
    } catch (err) {
      setReviewReminderMessage(`通知送信に失敗しました: ${toMessage(err)}`);
    }
  }, [ensureNotificationPermissionForSend]);

  const notifyImmediateAssignedAlerts = useCallback(async (diff: AssignedAlertDiff) => {
    if (diff.newlyConflicted.length === 0 && diff.newlyFailedCi.length === 0) {
      return;
    }

    const permission = await ensureNotificationPermissionForSend();
    if (permission !== 'granted') {
      return;
    }

    try {
      sendNotification({
        title: 'GitLab Action Radar',
        body: buildImmediateAlertNotificationBody(diff)
      });
    } catch (err) {
      setReviewReminderMessage(`即時通知の送信に失敗しました: ${toMessage(err)}`);
    }
  }, [ensureNotificationPermissionForSend]);

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

  const loadMergeRequests = useCallback(async (options?: { notifyReviewReminder?: boolean; reminderTime?: string; background?: boolean }) => {
    if (loadInFlightRef.current) {
      return;
    }

    if (!client) {
      assignedAlertSnapshotRef.current = new Map();
      assignedAlertSnapshotInitializedRef.current = false;
      assignedAlertSnapshotUserIdRef.current = undefined;
      setAssignedAlertSnapshotEntries([]);
      setAssignedAlertSnapshotInitialized(false);
      setAssignedAlertSnapshotUserId(undefined);
      setAssignedItems([]);
      setReviewRequestedItems([]);
      setLoading(false);
      setError('PAT を保存するか、VITE_GITLAB_TOKEN を設定してください。');
      await updateTrayIndicator({
        conflictCount: 0,
        failedCiCount: 0,
        reviewPendingCount: 0,
        actionableTotalCount: 0
      });
      return;
    }

    loadInFlightRef.current = true;
    const background = options?.background === true;
    if (!background) {
      setLoading(true);
    }
    setError(undefined);
    try {
      const mergeRequests = await client.listMyRelevantMergeRequests();
      const [assignedSignals, reviewRequestedSignals] = await Promise.all([
        client.buildHealthSignals(mergeRequests.assigned, mergeRequests.currentUserId),
        client.buildHealthSignals(mergeRequests.reviewRequested, mergeRequests.currentUserId, {
          includeReviewerChecks: true
        })
      ]);
      const canCompareWithPreviousSnapshot =
        assignedAlertSnapshotInitializedRef.current && assignedAlertSnapshotUserIdRef.current === mergeRequests.currentUserId;
      const previousSnapshot = canCompareWithPreviousSnapshot ? assignedAlertSnapshotRef.current : new Map<number, AssignedAlertSnapshot>();
      const assignedAlertDiff = detectAssignedAlertDiff(previousSnapshot, assignedSignals);
      const nextAssignedAlertSnapshot = buildAssignedAlertSnapshot(assignedSignals);
      assignedAlertSnapshotRef.current = nextAssignedAlertSnapshot;
      assignedAlertSnapshotInitializedRef.current = true;
      assignedAlertSnapshotUserIdRef.current = mergeRequests.currentUserId;
      setAssignedAlertSnapshotEntries(serializeAssignedAlertSnapshotEntries(nextAssignedAlertSnapshot));
      setAssignedAlertSnapshotInitialized(true);
      setAssignedAlertSnapshotUserId(mergeRequests.currentUserId);
      if (canCompareWithPreviousSnapshot) {
        await notifyImmediateAssignedAlerts(assignedAlertDiff);
      }
      setAssignedItems(assignedSignals);
      setReviewRequestedItems(reviewRequestedSignals);
      await updateTrayIndicator(summarizeTrayIndicator(assignedSignals, reviewRequestedSignals));

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
      if (!background) {
        setLoading(false);
      }
      loadInFlightRef.current = false;
    }
  }, [client, notifyImmediateAssignedAlerts, notifyReviewReminder, updateTrayIndicator]);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    void loadMergeRequests();
  }, [authLoading, loadMergeRequests]);

  useEffect(() => {
    if (!autoPollingEnabled || authLoading || !client) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    const intervalMs = normalizePollingIntervalMinutes(autoPollingIntervalMinutes) * 60_000;
    const intervalId = window.setInterval(() => {
      void loadMergeRequests({ background: true });
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [authLoading, autoPollingEnabled, autoPollingIntervalMinutes, client, loadMergeRequests]);

  useEffect(() => {
    if (!settingsLoaded || typeof window === 'undefined') {
      return;
    }

    const nextSettings: AppSettings = {
      reviewReminderEnabled,
      reviewReminderTimes: normalizeReminderTimes(reviewReminderTimes),
      notifiedReviewReminderSlots,
      autoPollingEnabled,
      autoPollingIntervalMinutes: normalizePollingIntervalMinutes(autoPollingIntervalMinutes),
      assignedAlertSnapshot: assignedAlertSnapshotEntries,
      assignedAlertSnapshotInitialized,
      assignedAlertSnapshotUserId
    };

    void saveAppSettings(nextSettings).catch(() => {
      // Ignore settings save failure and keep the current in-memory state.
    });
  }, [
    assignedAlertSnapshotEntries,
    assignedAlertSnapshotInitialized,
    assignedAlertSnapshotUserId,
    autoPollingEnabled,
    autoPollingIntervalMinutes,
    notifiedReviewReminderSlots,
    reviewReminderEnabled,
    reviewReminderTimes,
    saveAppSettings,
    settingsLoaded
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    refreshNotificationPermission();
    const onVisibilityChange = () => {
      refreshNotificationPermission();
    };
    window.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refreshNotificationPermission]);

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

        if (loadInFlightRef.current) {
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

  const notificationPermissionLabel = getNotificationPermissionLabel(notificationPermission);
  const notificationPermissionButtonLabel =
    notificationPermission === 'default' ? '通知許可をリクエスト' : '通知設定を開く';
  const notificationPermissionButtonDisabled = notificationPermission === 'unsupported';

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
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="radar">
              <TabsList className="grid w-full max-w-xs grid-cols-2">
                <TabsTrigger value="radar">Radar</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>

              <TabsContent value="radar">
                <MergeRequestList
                  assignedItems={assignedItems}
                  reviewRequestedItems={reviewRequestedItems}
                  loading={loading}
                  error={error}
                  onOpenMergeRequest={openExternalUrl}
                />
              </TabsContent>

              <TabsContent value="settings" className="space-y-3">
                <section className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                  <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                    <div>
                      <p className="text-sm font-medium text-slate-700">GitLab PAT</p>
                      <p className="text-xs text-slate-600">PATを安全ストアに保存して利用します。</p>
                    </div>
                    <Button type="button" variant="outline" onClick={openPatIssuePage}>
                      Open PAT page
                    </Button>
                  </div>
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
                </section>

                <section className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                  <p className="text-sm font-medium text-slate-700">Auto polling</p>
                  <div className="flex flex-col gap-2">
                    <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={autoPollingEnabled}
                        onChange={(event) => setAutoPollingEnabled(event.target.checked)}
                        className="size-4"
                      />
                      Enable periodic refresh
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={minAutoPollingIntervalMinutes}
                        max={maxAutoPollingIntervalMinutes}
                        step={1}
                        value={autoPollingIntervalMinutes}
                        onChange={(event) =>
                          setAutoPollingIntervalMinutes(
                            normalizePollingIntervalMinutes(Number(event.target.value))
                          )
                        }
                        disabled={!autoPollingEnabled}
                        className="w-[120px]"
                        aria-label="Auto polling interval minutes"
                      />
                      <span className="text-xs text-slate-600">minutes</span>
                    </div>
                  </div>
                  <p className="text-xs text-slate-600">
                    GitLab負荷を抑えるため {minAutoPollingIntervalMinutes}〜{maxAutoPollingIntervalMinutes} 分で設定します
                    （既定 {defaultAutoPollingIntervalMinutes} 分）。
                  </p>
                </section>

                <section className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                  <p className="text-sm font-medium text-slate-700">Review reminder</p>
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                      <span>通知許可:</span>
                      <span
                        className={
                          notificationPermission === 'granted'
                            ? 'font-medium text-emerald-700'
                            : notificationPermission === 'unsupported'
                              ? 'font-medium text-slate-500'
                              : 'font-medium text-amber-700'
                        }
                      >
                        {notificationPermissionLabel}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void openNotificationPermissionScreen()}
                        className="h-8"
                        disabled={notificationPermissionButtonDisabled}
                      >
                        {notificationPermissionButtonLabel}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void sendTestNotification()}
                        className="h-8"
                        disabled={notificationPermission === 'unsupported'}
                      >
                        テスト通知を送信
                      </Button>
                    </div>
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
                </section>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
