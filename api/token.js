/**
 * Google OAuth トークン交換・リフレッシュ
 * POST /api/token
 *   action='exchange': 認証コード → アクセストークン + リフレッシュトークン
 *   action='refresh':  リフレッシュトークン → 新アクセストークン
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { action, code, code_verifier, refresh_token, redirect_uri } = req.body || {};
  const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'server_misconfigured',
      error_description: 'GOOGLE_CLIENT_ID または GOOGLE_CLIENT_SECRET が未設定です' });
  }

  let params;
  if (action === 'exchange' && code && code_verifier && redirect_uri) {
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
  return res.status(resp.ok ? 200 : 400).json(data);
}
