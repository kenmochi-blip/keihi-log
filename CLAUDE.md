# 経費ログ プロジェクトメモ

## LP 重要ポイント

### 価格プラン
- **ソロプラン**: 月額300円（税込）
- **チームプラン**: 月額750円（税込）
- 2週間無料トライアルあり

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
