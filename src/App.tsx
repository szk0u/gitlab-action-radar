import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { requestPermission as requestNotificationPermissionApi, sendNotification } from '@tauri-apps/plugin-notification';
import { Store } from '@tauri-apps/plugin-store';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitLabClient } from './api/gitlabClient';
import { MergeRequestList, type TabKey } from './components/MergeRequestList';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Input } from './components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { AssignedAlertSnapshot, AssignedAlertDiff, buildAssignedAlertSnapshot, detectAssignedAlertDiff } from './lib/assignedAlertDiff';
import {
  IgnoredAssignedAlertState,
  applyIgnoredAssignedAlertsUntilNewCommit,
  toCommitSignature
} from './lib/ignoredAssignedAlerts';
import { MergeRequestHealth } from './types/gitlab';

const gitlabBaseUrl = import.meta.env.VITE_GITLAB_BASE_URL ?? 'https://gitlab.com';
const gitlabTokenFromEnvRaw = import.meta.env.VITE_GITLAB_TOKEN ?? '';
const gitlabTokenFromEnv = import.meta.env.DEV ? gitlabTokenFromEnvRaw : '';
const isGitlabTokenFromEnvBlocked = !import.meta.env.DEV && gitlabTokenFromEnvRaw.trim().length > 0;
const personalAccessTokenLabel = 'Personal Access Token (PAT)';
const gitlabPatMinimumScope = 'read_api';
const gitlabPatIssueTokenName = 'GitLab Action Radar';
const gitlabTokenFromEnvBlockedMessage = `VITE_GITLAB_TOKEN は開発時のみ有効です。${personalAccessTokenLabel} を安全ストアに保存してください。`;
const missingPatTokenMessage = isGitlabTokenFromEnvBlocked
  ? `${personalAccessTokenLabel} を保存してください。VITE_GITLAB_TOKEN は開発時のみ有効です。`
  : import.meta.env.DEV
    ? `${personalAccessTokenLabel} を保存するか、VITE_GITLAB_TOKEN を設定してください。`
    : `${personalAccessTokenLabel} を保存してください。`;
const gitlabPatIssuePageBaseUrl =
  import.meta.env.VITE_GITLAB_PAT_ISSUE_URL ?? `${gitlabBaseUrl.replace(/\/$/, '')}/-/user_settings/personal_access_tokens`;
const gitlabPatIssueUrl = buildGitlabPatIssueUrl(gitlabPatIssuePageBaseUrl, gitlabPatIssueTokenName, gitlabPatMinimumScope);
const localStorageReviewReminderEnabledKey = 'review-reminder-enabled';
const localStorageReviewReminderTimesKey = 'review-reminder-times';
const localStorageReviewReminderLegacyTimeKey = 'review-reminder-time';
const localStorageReviewReminderNotifiedSlotsKey = 'review-reminder-notified-slots';
const localStorageAutoPollingEnabledKey = 'auto-polling-enabled';
const localStorageAutoPollingIntervalMinutesKey = 'auto-polling-interval-minutes';
const localStorageAssignedAlertSnapshotKey = 'assigned-alert-snapshot';
const localStorageAssignedAlertSnapshotInitializedKey = 'assigned-alert-snapshot-initialized';
const localStorageAssignedAlertSnapshotUserIdKey = 'assigned-alert-snapshot-user-id';
const localStorageIgnoredAssignedAlertsKey = 'ignored-assigned-alerts';
const localStorageIgnoredAssignedAlertsUserIdKey = 'ignored-assigned-alerts-user-id';
const appSettingsStorePath = 'app-settings.json';
const appSettingsStoreKey = 'settings';
const defaultAutoPollingIntervalMinutes = 1;
const minAutoPollingIntervalMinutes = 1;
const maxAutoPollingIntervalMinutes = 60;
const notificationOpenTabEventName = 'notification-open-tab';

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function toSafeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function buildGitlabPatIssueUrl(baseUrl: string, tokenName: string, scope: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('name', tokenName);
    url.searchParams.set('scopes', scope);
    return url.toString();
  } catch {
    return baseUrl;
  }
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

interface IgnoredAssignedAlertEntry {
  mergeRequestId: number;
  commitSignature: string;
}

function normalizeSettingsUserId(value: unknown): number | undefined {
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
  return normalizeSettingsUserId(parsed);
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

function normalizeIgnoredAssignedAlertEntries(rawEntries: unknown): IgnoredAssignedAlertEntry[] {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const deduped = new Map<number, IgnoredAssignedAlertEntry>();
  for (const rawEntry of rawEntries) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      continue;
    }

    const entry = rawEntry as Partial<IgnoredAssignedAlertEntry>;
    if (typeof entry.mergeRequestId !== 'number' || !Number.isInteger(entry.mergeRequestId) || entry.mergeRequestId <= 0) {
      continue;
    }

    deduped.set(entry.mergeRequestId, {
      mergeRequestId: entry.mergeRequestId,
      commitSignature: typeof entry.commitSignature === 'string' ? entry.commitSignature : 'no-commit'
    });
  }

  return [...deduped.values()].sort((left, right) => left.mergeRequestId - right.mergeRequestId);
}

function parseIgnoredAssignedAlertEntries(value: string | null): IgnoredAssignedAlertEntry[] {
  if (!value) {
    return [];
  }

  try {
    return normalizeIgnoredAssignedAlertEntries(JSON.parse(value));
  } catch {
    return [];
  }
}

function parseIgnoredAssignedAlertsUserId(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return normalizeSettingsUserId(parsed);
}

function restoreIgnoredAssignedAlerts(entries: IgnoredAssignedAlertEntry[]): Map<number, IgnoredAssignedAlertState> {
  const state = new Map<number, IgnoredAssignedAlertState>();
  for (const entry of entries) {
    state.set(entry.mergeRequestId, {
      commitSignature: entry.commitSignature
    });
  }
  return state;
}

function serializeIgnoredAssignedAlerts(snapshot: ReadonlyMap<number, IgnoredAssignedAlertState>): IgnoredAssignedAlertEntry[] {
  return [...snapshot.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([mergeRequestId, value]) => ({
      mergeRequestId,
      commitSignature: value.commitSignature
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
  ignoredAssignedAlerts?: IgnoredAssignedAlertEntry[];
  ignoredAssignedAlertsUserId?: number;
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
  ignoredAssignedAlerts: IgnoredAssignedAlertEntry[];
  ignoredAssignedAlertsUserId?: number;
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
  const assignedAlertSnapshotUserId = normalizeSettingsUserId(payload?.assignedAlertSnapshotUserId);
  const assignedAlertSnapshotInitialized = payload?.assignedAlertSnapshotInitialized === true && assignedAlertSnapshotUserId != null;
  const assignedAlertSnapshot = assignedAlertSnapshotInitialized
    ? normalizeAssignedAlertSnapshotEntries(payload?.assignedAlertSnapshot)
    : [];
  const ignoredAssignedAlertsUserId = normalizeSettingsUserId(payload?.ignoredAssignedAlertsUserId);
  const ignoredAssignedAlerts =
    ignoredAssignedAlertsUserId != null
      ? normalizeIgnoredAssignedAlertEntries(payload?.ignoredAssignedAlerts)
      : [];

  return {
    reviewReminderEnabled: payload?.reviewReminderEnabled === true,
    reviewReminderTimes: times,
    notifiedReviewReminderSlots: notifiedSlots,
    autoPollingEnabled: payload?.autoPollingEnabled == null ? true : payload.autoPollingEnabled === true,
    autoPollingIntervalMinutes: normalizePollingIntervalMinutes(payload?.autoPollingIntervalMinutes ?? defaultAutoPollingIntervalMinutes),
    assignedAlertSnapshot,
    assignedAlertSnapshotInitialized,
    assignedAlertSnapshotUserId,
    ignoredAssignedAlerts,
    ignoredAssignedAlertsUserId
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
  const ignoredAssignedAlertsValue = window.localStorage.getItem(localStorageIgnoredAssignedAlertsKey);
  const ignoredAssignedAlertsUserIdValue = window.localStorage.getItem(localStorageIgnoredAssignedAlertsUserIdKey);
  const assignedAlertSnapshotUserId = parseAssignedAlertSnapshotUserId(assignedAlertSnapshotUserIdValue);
  const assignedAlertSnapshotInitialized =
    assignedAlertSnapshotInitializedValue === 'true' && assignedAlertSnapshotUserId != null;
  const ignoredAssignedAlertsUserId = parseIgnoredAssignedAlertsUserId(ignoredAssignedAlertsUserIdValue);

  return {
    reviewReminderEnabled: enabledValue === 'true',
    reviewReminderTimes: resolveInitialReminderTimes(timesValue, legacyTimeValue),
    notifiedReviewReminderSlots: parseNotifiedSlots(notifiedSlotsValue),
    autoPollingEnabled: autoPollingEnabledValue == null ? true : autoPollingEnabledValue === 'true',
    autoPollingIntervalMinutes: parseAutoPollingIntervalMinutes(autoPollingIntervalMinutesValue),
    assignedAlertSnapshot: assignedAlertSnapshotInitialized ? parseAssignedAlertSnapshotEntries(assignedAlertSnapshotValue) : [],
    assignedAlertSnapshotInitialized,
    assignedAlertSnapshotUserId,
    ignoredAssignedAlerts: ignoredAssignedAlertsUserId != null ? parseIgnoredAssignedAlertEntries(ignoredAssignedAlertsValue) : [],
    ignoredAssignedAlertsUserId
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
  window.localStorage.setItem(localStorageIgnoredAssignedAlertsKey, JSON.stringify(settings.ignoredAssignedAlerts));
  window.localStorage.setItem(
    localStorageAssignedAlertSnapshotInitializedKey,
    String(settings.assignedAlertSnapshotInitialized)
  );

  if (settings.assignedAlertSnapshotUserId == null) {
    window.localStorage.removeItem(localStorageAssignedAlertSnapshotUserIdKey);
  } else {
    window.localStorage.setItem(localStorageAssignedAlertSnapshotUserIdKey, String(settings.assignedAlertSnapshotUserId));
  }

  if (settings.ignoredAssignedAlertsUserId == null) {
    window.localStorage.removeItem(localStorageIgnoredAssignedAlertsUserIdKey);
  } else {
    window.localStorage.setItem(localStorageIgnoredAssignedAlertsUserIdKey, String(settings.ignoredAssignedAlertsUserId));
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
interface TabNavigationRequest {
  tab: TabKey;
  nonce: number;
}

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
  const [activeMainTab, setActiveMainTab] = useState<'radar' | 'settings'>('radar');
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
  const [ignoredAssignedAlertEntries, setIgnoredAssignedAlertEntries] = useState<IgnoredAssignedAlertEntry[]>([]);
  const [ignoredAssignedAlertsUserId, setIgnoredAssignedAlertsUserId] = useState<number | undefined>();
  const [tabNavigationRequest, setTabNavigationRequest] = useState<TabNavigationRequest | undefined>();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const loadInFlightRef = useRef(false);
  const assignedAlertSnapshotRef = useRef<Map<number, AssignedAlertSnapshot>>(new Map());
  const assignedAlertSnapshotInitializedRef = useRef(false);
  const assignedAlertSnapshotUserIdRef = useRef<number | undefined>(undefined);
  const ignoredAssignedAlertsRef = useRef<Map<number, IgnoredAssignedAlertState>>(new Map());
  const ignoredAssignedAlertsUserIdRef = useRef<number | undefined>(undefined);
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
  const ignoredAssignedMergeRequestIds = useMemo(
    () => ignoredAssignedAlertEntries.map((entry) => entry.mergeRequestId),
    [ignoredAssignedAlertEntries]
  );

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
      setIgnoredAssignedAlertEntries(settings.ignoredAssignedAlerts);
      setIgnoredAssignedAlertsUserId(settings.ignoredAssignedAlertsUserId);
      ignoredAssignedAlertsRef.current = restoreIgnoredAssignedAlerts(settings.ignoredAssignedAlerts);
      ignoredAssignedAlertsUserIdRef.current = settings.ignoredAssignedAlertsUserId;
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
          setAuthMessage(isGitlabTokenFromEnvBlocked ? gitlabTokenFromEnvBlockedMessage : undefined);
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
    const safeUrl = toSafeHttpUrl(url);
    if (!safeUrl) {
      console.warn('Blocked unsafe external URL:', url);
      return;
    }

    if (isTauriRuntime()) {
      try {
        await invoke('open_external_url', { url: safeUrl });
      } catch (err) {
        console.error('Failed to open URL via backend command:', err);
      }
      return;
    }

    if (!import.meta.env.DEV) {
      return;
    }

    const openedWindow = window.open(safeUrl, '_blank', 'noopener,noreferrer');
    if (!openedWindow) {
      window.location.assign(safeUrl);
    }
  }, []);

  const scrollToTop = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const scroll = () => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    scroll();
    window.requestAnimationFrame(scroll);
  }, []);

  const requestTabNavigation = useCallback((tab: TabKey) => {
    setActiveMainTab('radar');
    setTabNavigationRequest((previous) => ({
      tab,
      nonce: (previous?.nonce ?? 0) + 1
    }));
    scrollToTop();
  }, [scrollToTop]);

  const consumePendingNotificationTab = useCallback(async () => {
    if (!isTauriRuntime()) {
      return;
    }

    try {
      const tab = await invoke<string | null>('take_pending_notification_tab');
      if (tab === 'assigned' || tab === 'review') {
        requestTabNavigation(tab);
      }
    } catch {
      // Ignore command failures and rely on event delivery.
    }
  }, [requestTabNavigation]);

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

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let alive = true;
    let unlisten: (() => void) | undefined;
    const registerNotificationOpenTabListener = async () => {
      try {
        const nextUnlisten = await listen<string>(notificationOpenTabEventName, (event) => {
          const tab = event.payload;
          if (tab === 'assigned' || tab === 'review') {
            requestTabNavigation(tab);
          }
        });
        if (!alive) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      } catch {
        // Ignore registration failure and keep notification delivery behavior.
      }
    };

    void registerNotificationOpenTabListener();

    return () => {
      alive = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, [requestTabNavigation]);

  useEffect(() => {
    if (!isTauriRuntime() || typeof window === 'undefined') {
      return;
    }

    const syncPendingTab = () => {
      void consumePendingNotificationTab();
    };

    syncPendingTab();
    window.addEventListener('focus', syncPendingTab);
    document.addEventListener('visibilitychange', syncPendingTab);
    const intervalId = window.setInterval(syncPendingTab, 1500);

    return () => {
      window.removeEventListener('focus', syncPendingTab);
      document.removeEventListener('visibilitychange', syncPendingTab);
      window.clearInterval(intervalId);
    };
  }, [consumePendingNotificationTab]);

  const sendClickableNotification = useCallback(async (options: { title: string; body: string; openTab: TabKey }) => {
    if (isTauriRuntime()) {
      try {
        await invoke('send_clickable_notification', { payload: options });
        return;
      } catch (err) {
        console.error('Failed to send clickable notification via backend command:', err);
        // Fall back to standard notifications below.
      }
    }

    sendNotification({
      title: options.title,
      body: options.body
    });
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
      await sendClickableNotification({
        title: 'GitLab Action Radar',
        body: `要レビュー ${counts.needsReview}件 / 作者修正待ち ${counts.waitingForAuthor}件 / 未着手 ${counts.new}件`,
        openTab: 'review'
      });
      setReviewReminderMessage(
        `リマインド通知を送信しました (${scheduledTime}) - 要レビュー ${counts.needsReview}件 / 作者修正待ち ${counts.waitingForAuthor}件 / 未着手 ${counts.new}件`
      );
    } catch (err) {
      setReviewReminderMessage(`通知送信に失敗しました: ${toMessage(err)}`);
    }
  }, [ensureNotificationPermissionForSend, sendClickableNotification]);

  const notifyImmediateAssignedAlerts = useCallback(async (diff: AssignedAlertDiff) => {
    if (diff.newlyConflicted.length === 0 && diff.newlyFailedCi.length === 0) {
      return;
    }

    const permission = await ensureNotificationPermissionForSend();
    if (permission !== 'granted') {
      return;
    }

    try {
      await sendClickableNotification({
        title: 'GitLab Action Radar',
        body: buildImmediateAlertNotificationBody(diff),
        openTab: 'assigned'
      });
    } catch (err) {
      setReviewReminderMessage(`即時通知の送信に失敗しました: ${toMessage(err)}`);
    }
  }, [ensureNotificationPermissionForSend, sendClickableNotification]);

  const savePatToken = async () => {
    const token = patInput.trim();
    if (!token) {
      setAuthMessage(`${personalAccessTokenLabel} を入力してから保存してください。`);
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
      setAuthMessage(`${personalAccessTokenLabel} を安全ストアに保存しました。`);
    } catch (err) {
      setAuthMessage(`${personalAccessTokenLabel} の保存に失敗しました: ${toMessage(err)}`);
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
        isGitlabTokenFromEnvBlocked
          ? `保存済みPATを削除しました。${gitlabTokenFromEnvBlockedMessage}`
          : gitlabTokenFromEnv
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
      ignoredAssignedAlertsRef.current = new Map();
      ignoredAssignedAlertsUserIdRef.current = undefined;
      setAssignedAlertSnapshotEntries([]);
      setAssignedAlertSnapshotInitialized(false);
      setAssignedAlertSnapshotUserId(undefined);
      setIgnoredAssignedAlertEntries([]);
      setIgnoredAssignedAlertsUserId(undefined);
      setAssignedItems([]);
      setReviewRequestedItems([]);
      setLoading(false);
      setError(missingPatTokenMessage);
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
      const [rawAssignedSignals, reviewRequestedSignals] = await Promise.all([
        client.buildHealthSignals(mergeRequests.assigned, mergeRequests.currentUserId, {
          includeLatestCommitAt: true
        }),
        client.buildHealthSignals(mergeRequests.reviewRequested, mergeRequests.currentUserId, {
          includeReviewerChecks: true
        })
      ]);
      const sameIgnoredAssignedAlertsUser =
        ignoredAssignedAlertsUserIdRef.current != null && ignoredAssignedAlertsUserIdRef.current === mergeRequests.currentUserId;
      const previousIgnoredAssignedAlerts = sameIgnoredAssignedAlertsUser
        ? ignoredAssignedAlertsRef.current
        : new Map<number, IgnoredAssignedAlertState>();
      const appliedIgnoredAssignedAlerts = applyIgnoredAssignedAlertsUntilNewCommit(rawAssignedSignals, previousIgnoredAssignedAlerts);
      const ignoredAssignedMergeRequestIds = appliedIgnoredAssignedAlerts.ignoredMergeRequestIds;
      const actionableAssignedSignals = rawAssignedSignals.filter(
        (item) => !ignoredAssignedMergeRequestIds.has(item.mergeRequest.id)
      );
      const nextIgnoredAssignedAlerts = appliedIgnoredAssignedAlerts.nextState;

      ignoredAssignedAlertsRef.current = nextIgnoredAssignedAlerts;
      ignoredAssignedAlertsUserIdRef.current = mergeRequests.currentUserId;
      setIgnoredAssignedAlertEntries(serializeIgnoredAssignedAlerts(nextIgnoredAssignedAlerts));
      setIgnoredAssignedAlertsUserId(mergeRequests.currentUserId);

      const canCompareWithPreviousSnapshot =
        assignedAlertSnapshotInitializedRef.current && assignedAlertSnapshotUserIdRef.current === mergeRequests.currentUserId;
      const previousSnapshot = canCompareWithPreviousSnapshot ? assignedAlertSnapshotRef.current : new Map<number, AssignedAlertSnapshot>();
      const assignedAlertDiff = detectAssignedAlertDiff(previousSnapshot, actionableAssignedSignals);
      const nextAssignedAlertSnapshot = buildAssignedAlertSnapshot(actionableAssignedSignals);
      assignedAlertSnapshotRef.current = nextAssignedAlertSnapshot;
      assignedAlertSnapshotInitializedRef.current = true;
      assignedAlertSnapshotUserIdRef.current = mergeRequests.currentUserId;
      setAssignedAlertSnapshotEntries(serializeAssignedAlertSnapshotEntries(nextAssignedAlertSnapshot));
      setAssignedAlertSnapshotInitialized(true);
      setAssignedAlertSnapshotUserId(mergeRequests.currentUserId);
      if (canCompareWithPreviousSnapshot) {
        await notifyImmediateAssignedAlerts(assignedAlertDiff);
      }
      setAssignedItems(rawAssignedSignals);
      setReviewRequestedItems(reviewRequestedSignals);
      await updateTrayIndicator(summarizeTrayIndicator(actionableAssignedSignals, reviewRequestedSignals));

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
  }, [
    client,
    notifyImmediateAssignedAlerts,
    notifyReviewReminder,
    updateTrayIndicator
  ]);

  const ignoreAssignedMergeRequestUntilNewCommit = useCallback((mergeRequestId: number) => {
    const target = assignedItems.find((item) => item.mergeRequest.id === mergeRequestId);
    if (!target || (!target.hasConflicts && !target.hasFailedCi)) {
      return;
    }

    const nextIgnoredAssignedAlerts = new Map(ignoredAssignedAlertsRef.current);
    nextIgnoredAssignedAlerts.set(mergeRequestId, {
      commitSignature: toCommitSignature(target.latestCommitAt)
    });
    ignoredAssignedAlertsRef.current = nextIgnoredAssignedAlerts;
    setIgnoredAssignedAlertEntries(serializeIgnoredAssignedAlerts(nextIgnoredAssignedAlerts));

    const currentUserId = assignedAlertSnapshotUserIdRef.current;
    if (currentUserId != null) {
      ignoredAssignedAlertsUserIdRef.current = currentUserId;
      setIgnoredAssignedAlertsUserId(currentUserId);
    }

    const actionableAssignedItems = assignedItems.filter((item) => !nextIgnoredAssignedAlerts.has(item.mergeRequest.id));
    void updateTrayIndicator(summarizeTrayIndicator(actionableAssignedItems, reviewRequestedItems));
  }, [assignedItems, reviewRequestedItems, updateTrayIndicator]);

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
      assignedAlertSnapshotUserId,
      ignoredAssignedAlerts: ignoredAssignedAlertEntries,
      ignoredAssignedAlertsUserId
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
    ignoredAssignedAlertEntries,
    ignoredAssignedAlertsUserId,
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
            <Tabs value={activeMainTab} onValueChange={(value) => setActiveMainTab(value as 'radar' | 'settings')}>
              <TabsList className="grid w-full max-w-xs grid-cols-2">
                <TabsTrigger value="radar">Radar</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>

              <TabsContent value="radar">
                <MergeRequestList
                  assignedItems={assignedItems}
                  reviewRequestedItems={reviewRequestedItems}
                  ignoredAssignedMergeRequestIds={ignoredAssignedMergeRequestIds}
                  loading={loading}
                  error={error}
                  onOpenMergeRequest={openExternalUrl}
                  onIgnoreAssignedUntilNewCommit={ignoreAssignedMergeRequestUntilNewCommit}
                  tabNavigationRequest={tabNavigationRequest}
                />
              </TabsContent>

              <TabsContent value="settings" className="space-y-3">
                <section className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                  <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                    <div>
                      <p className="text-sm font-medium text-slate-700">GitLab Personal Access Token (PAT)</p>
                      <p className="text-xs text-slate-600">GitLab の Personal Access Token (PAT) を安全ストアに保存して利用します。</p>
                      <p className="text-xs text-slate-600">
                        必要最小権限: <span className="font-mono">{gitlabPatMinimumScope}</span>（API の読み取り専用）
                      </p>
                    </div>
                    <Button type="button" variant="outline" onClick={openPatIssuePage}>
                      Open PAT Page
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      type="password"
                      value={patInput}
                      onChange={(event) => setPatInput(event.target.value)}
                      placeholder="glpat-..."
                      aria-label="GitLab Personal Access Token (PAT)"
                      className="sm:flex-1"
                    />
                    <Button type="button" onClick={() => void savePatToken()} disabled={authLoading}>
                      Save Token (PAT)
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void clearSavedPatToken()}
                      disabled={authLoading || !hasSavedPatToken}
                    >
                      Clear saved token
                    </Button>
                  </div>
                  {authMessage && <p className="text-sm text-slate-600">{authMessage}</p>}
                  {hasSavedPatToken && <p className="text-sm text-slate-600">現在は安全ストアの Personal Access Token (PAT) を使用しています。</p>}
                  {!hasSavedPatToken && gitlabTokenFromEnv && (
                    <p className="text-sm text-slate-600">現在は環境変数の Personal Access Token (PAT) を使用しています。</p>
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
