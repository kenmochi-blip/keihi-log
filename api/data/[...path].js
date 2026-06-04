/**
 * B' クリーンAPI キャッチオール・ルーター
 *
 * /api/data/* への全リクエストを単一のサーバーレス関数で処理する。
 * Vercel Hobby プランの「1デプロイあたり関数12個」上限内に収めるため、
 * B' の各エンドポイント（health / expenses / masters / settings / receipt / gemini）
 * を個別ファイルにせず、このルーターの中で内部分岐する。
 *
 * URL 構造はそのまま綺麗に保たれる:
 *   GET  /api/data/health
 *   GET  /api/data/expenses
 *   ...
 *
 * Vercel の動的ルート規約により req.query.path に配列でパスセグメントが入る。
 *   /api/data/health        → path = ['health']
 *   /api/data/expenses/123  → path = ['expenses', '123']
 */
import { getSaAuth, isSaConfigured } from '../_sa.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // req.query.path (Vercel dynamic route injection) が空の場合もあるため
  // req.url から直接パスを解析する（確実な方法）
  const urlPath = req.url ? req.url.split('?')[0] : '';
  const segs = urlPath.split('/').filter(Boolean);
  // segs例: ['api', 'data', 'health'] → resource = 'health'
  const resource = segs[2] || segs[segs.length - 1] || '';

  switch (resource) {
    case 'health':
      return health(req, res);
    default:
      return res.status(404).json({ error: 'not_found', resource });
  }
}

/**
 * GET /api/data/health
 * サービスアカウント（GOOGLE_SA_KEY）が設定され、実際に認証トークンを
 * 取得できるかを確認する疎通エンドポイント。機密値は返さない。
 */
async function health(req, res) {
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
