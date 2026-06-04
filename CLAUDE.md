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
- Vercel KV（ライセンス管理・URLエイリアス管理）
- 開発ブランチ: `claude/rebuild-receipt-app-Ft3lE`

### データアクセス方式（B' へ移行中）
- **旧方式**: 各ユーザーのOAuthトークンで Google Sheets / Drive API を直接呼ぶ。
  メンバーは `spreadsheets` スコープの追加認可が必要で、共有シートに直接アクセスしていた。
- **B'（新方式・移行中）**: Vercel Functions がサービスアカウント（SA）でシートを代理読み書きする
  プロキシ。メンバーはシートへの直接アクセス権・追加スコープ不要。
  - SA: `keihi-log-proxy@keihi-log.iam.gserviceaccount.com`（鍵は Vercel 環境変数 `GOOGLE_SA_KEY`）
  - エンドポイントは単一のキャッチオール関数 `api/data/[...path].js` に集約
    （Vercel Hobby の「関数12個」上限内に収めるため。B'のリソースを増やしてもここに足す）
  - 認可: クライアントは Google ID トークンを `Authorization: Bearer` で送り、サーバーが
    対象シートの「マスタ表」を SA で読んでメンバー判定（admin=全件 / 一般=自分の行のみ）
  - クライアント側はオプトイン（`localStorage.keihi_use_proxy === '1'`）で段階移行中。
    失敗時は従来の直接アクセスにフォールバック。
- SA を使うには各チームのスプレッドシート（および証票フォルダ）に SA をエディタ共有する必要がある。

### Vercel プラン注意
- 現在 Hobby（無料）。**Serverless Functions はデプロイあたり12個まで**。
  新エンドポイントは極力 `api/data/[...path].js` 内に足し、関数ファイルを増やさないこと。
- 商用利用は本来 Pro が必要（ToS）。切り替えは収益本格化のタイミングで（技術的には無料枠のまま拡張可能）。

## Git 運用ルール（重要）
- 本番URL（keihi-log.com）は `main` ブランチからデプロイされる
- **開発は `claude/rebuild-receipt-app-Ft3lE` で行い、デプロイ可能になったら `main` を
  そのコミットへ早送り（fast-forward）して揃える**。
  - 手順：①フィーチャーブランチにコミット＆プッシュ
         → ②`git branch -f main claude/rebuild-receipt-app-Ft3lE && git push origin main`
  - ❌ cherry-pick での個別同期は**禁止**。過去にこれで平行二重履歴と
    依存ファイル取りこぼし（`_sa.js` 欠落で本番ビルド失敗）が発生したため。
  - 大きな機能の移行中で main を一時的に揃えられない場合は、その旨をユーザーに伝えて判断を仰ぐ。
- リセット/force-push 前は必ず「main にしか無い実体変更が無いか」を `git diff` で確認すること。

## やることリスト

### 🔴 対応中

- [x] **Google OAuth スコープ審査の動画再提出** → 提出済み、審査結果待ち

### 🟡 スコープ審査完了後にやること

- [ ] **OAuthサポートメールを変更**（GCPコンソール → OAuth同意画面 → サポートメール）
  - 個人メール（kenmochi@smartandsmooth.com）をドメインメール等に変更
  - 審査中に変更すると審査リセットの恐れあるため審査完了まで待つ

### 🟢 B'（SAプロキシ）実装の進捗

- [x] B'サーバー基盤（`_sa.js` / `_verifyToken.js` / `api/data/[...path].js` ルーター）
- [x] `/api/data/health` 疎通確認（SA認証OK・共有シート読み取りOK）
- [x] `GET /api/data/expenses`（SA読み取り + マスタ表によるメンバー認可 + 60秒KVキャッシュ）
- [x] クライアント `readExpenses` をプロキシ経由に配線（オプトイン・フォールバック付き）
- [ ] 残りの読み取り（masters / settings）をプロキシ化
- [ ] 書き込み（append / update / delete / settle）をプロキシ化
- [ ] 領収書アップロードを SA 経由化（証票フォルダにも SA をエディタ共有が必要）
- [ ] Gemini をサーバープロキシ化（APIキーをブラウザに出さない）
- [ ] メンバーのシートアクセスをプロキシ完全移行（`keihi_use_proxy` のデフォルトON化）
- 運用中の本番シート（2チーム）には SA をエディタ共有済み

### 🔧 技術的負債

- [ ] **マスタ管理タブ（admin.js）を廃止して設定タブに一本化**
  - settings.js が admin.js の上位互換になっており、メンバーフォームが2箇所に存在するのが同期バグの根本原因
  - 急ぎではないが、落ち着いたタイミングで対応する

- [x] **`js/picker.js` を削除** → 完了（コミット 4e11c56）
