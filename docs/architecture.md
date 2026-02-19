# GitLab Action Radar アーキテクチャ設計

## 1. ゴール
- Tauri + React + TypeScript でデスクトップ常駐アプリを構築する。
- GitLab API から MR 情報を取得し、以下のシグナルを可視化する。
  - CI failure
  - Conflicts
  - Pending Approvals
- メニューバー（システムトレイ）常駐で、クリック時にパネル表示する。
- 特定プロジェクト固定ではなく、ユーザーに紐づくMRを横断的に取得する。

## 2. 構成
- **Shell (Rust/Tauri)**
  - システムトレイ生成・クリックイベント・終了メニュー。
  - ウィンドウ表示/非表示制御（常駐UI）。
- **UI (React + Vite + TypeScript)**
  - MR一覧表示。
  - シグナルバッジ表示。
  - ローディング/エラー表示。
- **Data Layer (TypeScript)**
  - GitLab API クライアント。
  - `/api/v4/user` でユーザーIDを解決。
  - `/api/v4/merge_requests` を assignee/reviewer 条件で2系統取得し統合。
  - MRデータを `MergeRequestHealth` に変換。
  - PAT は Tauri コマンド経由で OS の安全ストアへ保存/取得。

## 3. データフロー
1. アプリ起動時に Tauri がバックグラウンド起動。
2. UI が `GitLabClient.getCurrentUser()` で自ユーザー情報を取得。
3. UI が `GitLabClient.listMyRelevantMergeRequests()` で以下を取得。
   - assignee_id = me
   - reviewer_id = me
4. クライアントで重複MRを除去し、health シグナルを算出。
5. `MergeRequestList` がシグナルを表示。
6. ユーザーはトレイアイコンでウィンドウを開閉。

## 4. 設定値
環境変数（Vite）:
- `VITE_GITLAB_BASE_URL`
- `VITE_GITLAB_TOKEN`
- `VITE_GITLAB_PAT_ISSUE_URL`

アプリ永続設定（`tauri-plugin-store`）:
- `reviewReminderEnabled`
- `reviewReminderTimes`
- `notifiedReviewReminderSlots`
- `autoPollingEnabled`
- `autoPollingIntervalMinutes`

## 5. 拡張案
- 定期ポーリング（例: 60秒）
- 新規アラート通知（担当MRで新規の競合 / CI失敗を検知した場合に通知）
- Approval API連携でより正確な pending approvals 判定
- セキュア保存（OS keychain）
