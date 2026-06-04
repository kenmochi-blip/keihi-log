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

### 🔴 未着手・要対応

- [ ] **Google OAuth スコープ審査の申請**
  - 現在未着手。審査通過まで外部ユーザーへの公開は制限付き

### 🟡 OAuth 審査完了後にやること

- [ ] **OAuthサポートメールを変更**（GCPコンソール → OAuth同意画面 → サポートメール）
  - 個人メール（kenmochi@smartandsmooth.com）をドメインメール等に変更

### 🟢 B'（SAプロキシ）実装の進捗

- [x] B'サーバー基盤（`_sa.js` / `_verifyToken.js` / `api/data/[...path].js` ルーター）
- [x] `/api/data/health` 疎通確認（SA認証OK・共有シート読み取りOK）
- [x] `GET /api/data/expenses`（SA読み取り + マスタ表によるメンバー認可 + 60秒KVキャッシュ）
- [x] クライアント `readExpenses` をプロキシ経由に配線（オプトイン・フォールバック付き）
- [x] 残りの読み取り（masters / settings）をプロキシ化
- [x] 経費の書き込み（append / edit / delete / approve / settle / unsettle）をプロキシ化
  - 精算済（実精算）は編集・削除不可（電帳法）。誤精算の訂正用に admin 限定の unsettle を用意
- [x] 設定シート書き込み（B2-B7）をプロキシ化（`PUT /api/data/settings`・admin専用・セルホワイトリスト）
  - セットアップ直後（SA共有前）の書き込みは作成者トークンで直接 update のまま
- [x] 領収書アップロードを SA 経由化（`POST /api/data/receipt`・設定B4のフォルダへSA保存）
  - 閲覧は読み取り時にサーバーが Drive URL → HMAC署名付きプロキシURL（`GET /api/data/receipt`・24hTTL・
    `immutable`キャッシュ）へ書き換え。署名は閲覧権のある経費にのみ発行。
  - 書き込み時はサーバーが署名URL→永続Drive URLへ逆変換（`_normalizeImageLinks`）し正準URLを保存。
  - ⚠️ 前提: 各チームの**証票フォルダにも SA をエディタ共有**が必要（共有前は upload/閲覧が失敗）。
    署名URLの秘密鍵は `GOOGLE_SA_KEY` から導出（新規環境変数なし）。
- [x] Gemini をサーバープロキシ化（`POST /api/data/gemini`・設定B5をSAで読み代理呼び出し）
  - APIキーはブラウザに一切返さない。Geminiの生JSONのみ透過。プロキシOFF時は従来の直接呼び出し。
- [x] メンバーのシートアクセスをプロキシ完全移行（デフォルトON化）
  - `keihi_use_proxy !== '0'` でデフォルトON（緊急時は '0' でOFF）。
- 運用中の本番シート（2チーム）には SA をエディタ共有済み

### 🔧 技術的負債

- [x] **マスタ管理タブ（admin.js）を廃止して設定タブに一本化** → 完了
  - admin.js は settings.js の完全上位互換だったため削除。nav ボタンも元々なし。

- [x] **`js/picker.js` を削除** → 完了（コミット 4e11c56）
