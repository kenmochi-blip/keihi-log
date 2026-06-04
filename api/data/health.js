/**
 * B' クリーンAPI ヘルスチェック
 * GET /api/data/health
 *
 * サービスアカウント（GOOGLE_SA_KEY）が設定され、実際に認証トークンを
 * 取得できるかを確認するための疎通エンドポイント。
 * Preview/本番デプロイ後に SA 設定が正しいかを素早く検証するために使う。
 * 機密値は返さない（鍵の有無・認証可否・SAのメールアドレスのみ）。
 */
import { getSaAuth, isSaConfigured } from '../_sa.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  if (!isSaConfigured()) {
    return res.status(200).json({ saConfigured: false, authenticated: false });
  }

  try {
    const auth = getSaAuth();
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return res.status(200).json({
      saConfigured: true,
      authenticated: !!token?.token,
      serviceAccountEmail: client.email || null,
    });
  } catch (e) {
    return res.status(200).json({
      saConfigured: true,
      authenticated: false,
      error: e.message || 'sa_auth_failed',
    });
  }
}
