# GitLab Action Radar

Tauri + React + TypeScript で作るメニューバー常駐型の GitLab MR レーダーです。

## セットアップ (pnpm)
```bash
pnpm install
pnpm dev
```

Tauri 起動:
```bash
pnpm tauri dev
```

## テスト (Vitest)
```bash
pnpm test
```

## 収集対象MR
- 自分にアサインされている Open MR
- 自分が reviewer に設定されている Open MR

プロジェクトIDの指定は不要です。

## メニューバー表示
- トレイアイコンは 3 本バーで状態を色分け表示します。
  - 競合あり: オレンジ
  - CI失敗: 赤
  - 自分のレビュー待ち: 青
- 対応が必要な MR の合計件数をトレイタイトルに表示します（0件時は非表示）。
- Settings の `Auto polling` から定期更新を設定できます（既定 1 分、1〜60 分）。
- `Assigned` タブは `競合 / CI失敗 / 承認待ち / My MR` で絞り込みできます。
- `Assigned` の各MRにある `新しいコミットまで無視` で、選択したMRのみ同一コミット中は `Ignored until new commit` 表示になります。
- 自分にアサインされたMRで新規に `競合` または `CI失敗` が発生したとき、次回ポーリングで即時OS通知します（初回ロードは通知しません）。
- 即時通知の差分判定スナップショットは設定ストアに保存され、再起動後も引き継がれます。
- `Auto polling` / `Review reminder` と、無視対象MRの状態は `tauri-plugin-store`（`app-settings.json`）に保存され、再起動後も保持されます。

## 認証
- PAT のみ対応
- 画面の `Open PAT page` で GitLab の PAT 発行ページを開けます
- 画面の `Save PAT` で PAT を OS の安全ストア（macOS Keychain など）に保存し、次回起動時も利用できます
- `VITE_GITLAB_TOKEN` を設定しておくと初期値として利用されます
- `VITE_GITLAB_PAT_ISSUE_URL` で PAT 発行ページ URL を上書きできます

## アーキテクチャ
`docs/architecture.md` を参照。
