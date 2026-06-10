# 経費ログ プロジェクトメモ

## LP 重要ポイント

### 価格プラン
- **ソロプラン**: 月額330円（税込）／年額3,300円（税込）
- **チームプラン**: 月額825円（税込）／年額8,250円（税込）
- 2週間無料トライアルあり（**クレカ登録不要**）
  - トライアル終了後は自動課金されない。ユーザーが自発的に有料プランへ切り替える必要がある。
  - 切替フロー: アプリ設定画面の「有料プランへ切り替える」ボタン → `upgradeLinks`（トライアルなし即時課金）へ遷移
  - `client_reference_id` に既存ライセンスキーを付与 → webhook が同じキーを延長（新キー発行なし）

### BYOKの説明（低価格の理由）
- AI領収書解析はBYOK（Bring Your Own Key）方式
- お客様自身のGoogle AI Studio APIキーを設定して使用
- **使用モデル**: `gemini-3.1-flash-lite`（無料枠 500リクエスト/日・2026-06にCloud Consoleで実測確認）
  - ⚠️ 旧 `gemini-2.5-flash` は2025年12月の無料枠削減で 20 RPD になったため乗り換えた
  - 無料枠はGoogle都合で変動するため、LP等の数値を更新する際はCloud Console
    （Generative Language API →割り当て→「Request limit per model per day ... free tier」）で要確認
- 有料化はしない前提（ユーザー負荷が高いため）。無料アカウントのままなら超過しても課金されない
  （その日の解析が止まるだけ）── LPもこの訴求で統一
- この仕組みにより低価格を実現

### Geminiクォータアラート対応手順

GCPコンソールのクォータアラートポリシーでメール通知を設定済み。
アラートメールが届いたら以下の手順で対応する。

#### 1. 現状確認（5分）

```
Cloud Console → APIとサービス → Generative Language API
→ 割り当てとシステム上限 → フィルタ: "Request limit per model per day"
```

「free tier」行の各モデルの「値」列を確認し、現在のモデル（`gemini-3.1-flash-lite`）の
RPDと、より大きい値を持つモデルを探す。

#### 2. 乗り換え先の選定基準

- free tier RPDが**現在値より大きい**（最低でも100以上を目安）
- モデル名に `lite` または `flash` を含む軽量系（領収書OCRにはProは不要）
- `experimental` は本番には使わない（廃止リスクが高い）
- `tts`・`image`・`embedding` は用途が違うので対象外

#### 3. 変更箇所（3ファイル・計3行）

```
public/js/gemini.js          : const MODEL = '...'
api/data/[...path].js        : const MODEL = '...'  （handleGemini関数内）
api/gemini-proxy.js          : const MODEL = '...'  （デモ用）
```

#### 4. 文言の更新箇所

RPD値が変わった場合は以下を一括修正する（数値は実測値に合わせる）：

```
public/index.html   : 「無料枠は1日XXXリクエスト」（BYOK説明セクション・FAQ3）
public/faq.html     : 「1日XXX件」（q402・q402b の2箇所）
public/setup.html   : 「1日あたりXXXリクエストまで無料」
api/_faq-data.js    : 上記faqと同じ内容のプレーンテキスト版
CLAUDE.md           : 本セクションの「実測確認」の値と日付
```

#### 5. バージョンバンプ・コミット・プッシュ

```bash
# app.html のバージョンクエリを更新（キャッシュ無効化）
# 例: gemini.js?v=YYYYMMDD

git add -A
git commit -m "Geminiモデルを XXX に変更（無料枠YYY RPD・YYYY-MM確認）"
git branch -f main claude/rebuild-receipt-app-Ft3lE
git push origin main
git push origin claude/rebuild-receipt-app-Ft3lE
```

#### 6. 動作確認

デプロイ後、デモモードで領収書を1枚読み取って正常に解析されることを確認する。

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
  - **原則：フィーチャーブランチへのコミット・プッシュと同時に常に main も更新する。**
    「まだ本番にしないで」と明示された場合のみ main 更新を保留する。
  - 手順：①フィーチャーブランチにコミット＆プッシュ
         → ②`git branch -f main claude/rebuild-receipt-app-Ft3lE && git push origin main`
  - ❌ cherry-pick での個別同期は**禁止**。過去にこれで平行二重履歴と
    依存ファイル取りこぼし（`_sa.js` 欠落で本番ビルド失敗）が発生したため。
  - 大きな機能の移行中で main を一時的に揃えられない場合は、その旨をユーザーに伝えて判断を仰ぐ。
- リセット/force-push 前は必ず「main にしか無い実体変更が無いか」を `git diff` で確認すること。

## やることリスト

### 🟢 OAuth スコープ審査について

- **審査不要**（確認済み）
  - 現在のスコープ（`drive.file` / `userinfo.email` / `openid` / `email` / `profile`）はすべてGCPコンソールで「非機密」に分類されており、Googleの検証作業は不要
- [ ] **OAuthサポートメールを変更**（任意・低優先度）
  - GCPコンソール → OAuth同意画面 → サポートメールを個人メール（kenmochi@smartandsmooth.com）から変更

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

### 📋 今後のやること

- [ ] **ブログ累計PVを `/licenses` に直接表示**（GA4 Data API をサーバー側から呼んで数値を取得・表示）
