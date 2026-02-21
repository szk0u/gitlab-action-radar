# AGENT.md

このファイルは、`gitlab-action-radar` で作業するエージェント向けの最小ガイドです。

## プロジェクト概要
- Tauri + React + TypeScript で構成された、メニューバー常駐型 GitLab MR レーダー。
- フロントエンドは Vite、テストは Vitest。

## 基本コマンド
- 依存関係インストール: `pnpm install`
- フロントエンド開発: `pnpm dev`
- Tauri 開発起動: `pnpm tauri dev`
- フロントエンドビルド: `pnpm build`
- Tauri 配布ビルド: `pnpm tauri build`
- テスト: `pnpm test`

## 環境変数
`.env.example` を参照:
- `VITE_GITLAB_BASE_URL`
- `VITE_GITLAB_TOKEN`（開発時のみ初期値として利用）
- `VITE_GITLAB_PAT_ISSUE_URL`

## 主要ディレクトリ
- `src/`: フロントエンド（React/TypeScript）
- `src-tauri/`: Tauri（Rust）側
- `__tests__/`: テスト
- `docs/`: 補足ドキュメント（例: `architecture.md`）

## 作業ルール
- 変更前後で最低限 `pnpm test` を実行し、必要に応じて `pnpm build` も確認する。
- 既存の設定・機能説明は `README.md` を正とする。
- 大きな仕様判断が必要な場合は、先にユーザーへ確認する。
