# AGENT.md

このファイルは、`gitlab-action-radar` で作業するエージェント向けの最小ガイドです。

## プロジェクト概要

- Tauri + Preact + TypeScript で構成された、メニューバー常駐型 GitLab MR レーダー。
- フロントエンドは Vite、テストは Vitest。

## 基本コマンド

- Bun セットアップ: `mise install`
- 依存関係インストール: `bun install`
- フロントエンド開発: `bun run dev`
- Tauri 開発起動: `bun run tauri dev`
- フロントエンドビルド: `bun run build`
- Tauri 配布ビルド: `bun run tauri build`
- テスト: `bun run test`

## 環境変数

`.env.example` を参照:

- `VITE_GITLAB_BASE_URL`
- `VITE_GITLAB_TOKEN`（開発時のみ初期値として利用）
- `VITE_GITLAB_PAT_ISSUE_URL`

## 主要ディレクトリ

- `src/`: フロントエンド（Preact/TypeScript）
- `src-tauri/`: Tauri（Rust）側
- `__tests__/`: テスト
- `docs/`: 補足ドキュメント（例: `architecture.md`）

## 作業ルール

- 変更前後で最低限 `bun run test` を実行し、必要に応じて `bun run build` も確認する。
- 既存の設定・機能説明は `README.md` を正とする。
- 大きな仕様判断が必要な場合は、先にユーザーへ確認する。
