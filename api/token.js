/**
 * Google OAuth トークン交換・リフレッシュ
 * POST /api/token
 *   action='exchange': 認証コード → アクセストークン + リフレッシュトークン
 *   action='refresh':  リフレッシュトークン → 新アクセストークン
 */
import { rateLimit } from './_rateLimit.js';

/**
 * redirect_uri が許可された値かを検証する。
 * - https://keihi-log.com/login（本番）
 * - https://*.vercel.app/...（Previewテスト環境。auth.js の _redirectUri と整合）
 * - http://localhost / 127.0.0.1（ローカル開発）
 */
function _isAllowedRedirect(uri) {
  if (!uri) return false;
  let u;
  try { u = new URL(uri); } catch (_) { return false; }
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  if (u.protocol !== 'https:') return false;
  if (u.hostname === 'keihi-log.com' || u.hostname === 'www.keihi-log.com') return true;
  if (u.hostname.endsWith('.vercel.app')) return true;
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // 公開された交換オラクルになるのを防ぐためレート制限（IPベース）
  const rl = await rateLimit(req, { prefix: 'rl:token', limit: 30, window: 60 });
  if (!rl.ok) return res.status(429).json({ error: 'rate_limited' });

  const { action, code, code_verifier, refresh_token, redirect_uri } = req.body || {};
  const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  let params;
  if (action === 'exchange' && code && code_verifier && redirect_uri) {
    if (!_isAllowedRedirect(redirect_uri)) {
      return res.status(400).json({ error: 'invalid_redirect_uri' });
    }
    params = {
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier,
      grant_type:    'authorization_code',
      redirect_uri,
    };
  } else if (action === 'refresh' && refresh_token) {
    params = {
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token,
      grant_type:    'refresh_token',
    };
  } else {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams(params),
  });
  const data = await resp.json();
  // 内部エラー詳細はクライアントに返さない（汎用化）
  if (!resp.ok) {
    return res.status(400).json({ error: data.error || 'token_error' });
  }
  return res.status(200).json(data);
}
