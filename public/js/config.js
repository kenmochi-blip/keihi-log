/**
 * アプリ設定
 * GCPコンソールで発行したOAuth 2.0クライアントIDを設定してください
 */
window.APP_CONFIG = {
  // GCPコンソール → APIとサービス → 認証情報 で発行したOAuthクライアントID
  clientId: '508005503832-vum8q15vc95msuf1lbjnlfcl2as6nmhd.apps.googleusercontent.com',

  // Google Picker API 用ブラウザキー
  // GCPコンソール → 認証情報 → 「APIキーを作成」→ Google Picker API のみ許可 → keihi-log.com/* に制限
  pickerApiKey: 'AIzaSyBcbA7bIvdTIrKkt_1X0C4ZUyFtRNUm504',

  // ライセンス検証・サーバー時刻APIのベースURL
  // ローカル開発時: 'http://localhost:3000'
  // 本番: '' (同一オリジン)
  apiBase: '',
};
