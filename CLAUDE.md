# 経費ログ プロジェクトメモ

## LP 重要ポイント

### 価格プラン
- **ソロプラン**: 月額330円（税込）／年額3,300円（税込）
- **チームプラン**: 月額825円（税込）／年額8,250円（税込）
- 2週間無料トライアルあり（クレカ登録後）

### BYOKの説明（低価格の理由）
- AI領収書解析はBYOK（Bring Your Own Key）方式
- お客様自身のGoogle AI Studio APIキーを設定して使用
- **無料アカウント**: 1日あたり1,500リクエスト/日まで無料
  - 10名規模のチームでも1日数十件程度 → ほぼ全ての中小企業は無料枠で収まる
- **有料アカウント（1,500件超の場合）**: 約0.003円/枚（Gemini 1.5 Flash）
- この仕組みにより低価格を実現

## アーキテクチャメモ
- Vanilla JS SPA + Bootstrap 5
- Vercel ホスティング（静的サイト + Serverless Functions）
- Google Sheets / Drive API（ユーザーのOAuthトークンで直接アクセス）
- Vercel KV（ライセンス管理・URLエイリアス管理）
- 開発ブランチ: `claude/rebuild-receipt-app-Ft3lE`

## Git 運用ルール（重要）
- 本番URL（keihi-log.com）は `main` ブランチからデプロイされる
- 修正を加えたら **必ず `main` と `claude/rebuild-receipt-app-Ft3lE` の両方にプッシュ**すること
- 手順：①フィーチャーブランチにコミット＆プッシュ → ②`git checkout main && git cherry-pick <hash> && git push origin main`
- `main` だけに反映されていないと、ユーザーが本番で「まだ直っていない」と報告することになる

## やることリスト

### 🔴 対応中

- [x] **Google OAuth スコープ審査の動画再提出** → 提出済み、審査結果待ち

### 🟡 スコープ審査完了後にやること

- [ ] **OAuthサポートメールを変更**（GCPコンソール → OAuth同意画面 → サポートメール）
  - 個人メール（kenmochi@smartandsmooth.com）をドメインメール等に変更
  - 審査中に変更すると審査リセットの恐れあるため審査完了まで待つ

### 🔧 技術的負債

- [ ] **マスタ管理タブ（admin.js）を廃止して設定タブに一本化**
  - settings.js が admin.js の上位互換になっており、メンバーフォームが2箇所に存在するのが同期バグの根本原因
  - 急ぎではないが、落ち着いたタイミングで対応する

- [ ] **`js/picker.js` を削除**
  - drive.file + Picker 実装を試みた際に作成したが、`spreadsheets` スコープに戻した際に削除し忘れた孤立ファイル
  - `app.html` や他のJSから一切参照されていない
