/**
 * アプリ設定
 * GCPコンソールで発行したOAuth 2.0クライアントIDを設定してください
 */
window.APP_CONFIG = {
  // GCPコンソール → APIとサービス → 認証情報 で発行したOAuthクライアントID
  clientId: '508005503832-vum8q15vc95msuf1lbjnlfcl2as6nmhd.apps.googleusercontent.com',

  // ライセンス検証・サーバー時刻APIのベースURL
  // ローカル開発時: 'http://localhost:3000'
  // 本番: '' (同一オリジン)
  apiBase: '',

  // Stripe Payment Link
  stripe: {
    // 新規申込用（2週間トライアル付き）— LPの申込ボタンと同じリンク
    signupLinks: {
      solo: 'https://buy.stripe.com/test_00w5kDfxH53DaY3fgPc7u04',
      team: 'https://buy.stripe.com/test_28E7sL99j53Dgin7Onc7u05',
    },
    // トライアル → 有料へ切り替える用（★トライアル無し・即時課金の Payment Link）
    //   Stripe ダッシュボードで「無料トライアルなし」の Payment Link を作成し、ここに設定すること。
    //   未設定の場合は signupLinks にフォールバックするが、その場合トライアルが
    //   再付与され課金が始まらない点に注意（必ず無トライアルのリンクを設定）。
    upgradeLinks: {
      solo: '',
      team: '',
    },
  },
};
