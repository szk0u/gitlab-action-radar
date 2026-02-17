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

## アーキテクチャ
`docs/architecture.md` を参照。
