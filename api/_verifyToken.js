/**
 * Google ID トークン検証ヘルパー（B'案 / クリーンAPIプロキシ用）
 *
 * クライアントは Authorization: Bearer <Google ID token> でリクエストする。
 * Google の公開鍵でローカルに署名検証し、aud が自分の CLIENT_ID であることを確認する。
 * （外部APIへ問い合わせないため高速・高可用・スケールする＝判断項目5でローカル検証を採用）
 *
 * 新規依存を増やさないため googleapis 同梱の google.auth.OAuth2 の verifyIdToken を使う。
 */
import { google } from 'googleapis';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// OAuth2 クライアント（公開鍵キャッシュのためインスタンスを使い回す）
let _client = null;
function _verifier() {
  if (!_client) _client = new google.auth.OAuth2(CLIENT_ID);
  return _client;
}

/**
 * リクエストの Authorization ヘッダから ID トークンを取り出して検証する。
 * @param {object} req
 * @returns {Promise<{ email: string, name: string, sub: string } | null>}
 *   検証成功なら本人情報、失敗なら null。
 */
export async function verifyIdToken(req) {
  if (!CLIENT_ID) return null;
  const authz = req.headers?.authorization || req.headers?.Authorization || '';
  const m = String(authz).match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  try {
    const ticket = await _verifier().verifyIdToken({ idToken: m[1], audience: CLIENT_ID });
    const p = ticket.getPayload();
    if (!p || !p.email || p.email_verified === false) return null;
    return { email: String(p.email).toLowerCase(), name: p.name || '', sub: p.sub || '' };
  } catch (_) {
    return null;
  }
}
