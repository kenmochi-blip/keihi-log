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
  //   方針：トライアルは1本（全機能=チーム機能まで解放）。課金に進む時にソロ/チームを選ぶ。
  //         ライセンスキーは終始不変で、プランは同じキーに付け替わる（webhookが更新）。
  stripe: {
    // 新規申込用（2週間トライアル付き）。トライアル中は plan に関わらず全機能解放。
    //   両リンクともチームプラン相当の全機能トライアル。有料切替時にソロ/チームを選ぶ。
    signupLinks: {
      solo: 'https://buy.stripe.com/dRmeVddyaeWVcZ92ag9oc00',
      team: 'https://buy.stripe.com/dRmeVddyaeWVcZ92ag9oc00',
    },
    // トライアル → 有料へ切り替える用（★トライアル無し・即時課金の Payment Link）。
    //   有料登録画面でソロ/チームの2ボタンとして表示される。client_reference_id に
    //   既存ライセンスキーが自動付与され、webhook が新キーを発行せず同じキーを延長する。
    //   ★Stripeダッシュボードで「無料トライアルなし」のリンクをソロ/チーム分作成して設定すること。
    //   未設定だと signupLinks（トライアル付き）にフォールバックし課金が始まらない点に注意。
    upgradeLinks: {
      solo: 'https://buy.stripe.com/dRm8wP1Ps7ut2kv8yE9oc06',
      team: 'https://buy.stripe.com/5kQ9AT51E8yxgbldSY9oc07',
    },
  },
};
