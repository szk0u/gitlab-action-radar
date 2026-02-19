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
- Settings の `Auto polling` から定期更新を設定できます（既定 5 分、3〜60 分）。

## 認証
- PAT のみ対応
- 画面の `Open PAT page` で GitLab の PAT 発行ページを開けます
- 画面の `Save PAT` で PAT を OS の安全ストア（macOS Keychain など）に保存し、次回起動時も利用できます
- `VITE_GITLAB_TOKEN` を設定しておくと初期値として利用されます
- `VITE_GITLAB_PAT_ISSUE_URL` で PAT 発行ページ URL を上書きできます

## アーキテクチャ
`docs/architecture.md` を参照。
