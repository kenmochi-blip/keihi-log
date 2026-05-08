/**
 * ライセンス検証 API
 *
 * 受け取るのはライセンスキーのみ。
 * ユーザーの経費データ・個人情報は一切受け取らない。
 *
 * 環境変数（Vercelダッシュボードで設定）:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  - サービスアカウントの JSON キー（文字列）
 *   LICENSE_SHEET_ID             - ライセンス台帳スプレッドシートのID
 */

import { kv } from '@vercel/kv';
import { google } from 'googleapis';

const CACHE_TTL_VALID   = 60 * 60 * 6;  // 有効キー: 6時間キャッシュ
const CACHE_TTL_INVALID = 60 * 60 * 1;  // 無効キー: 1時間キャッシュ（連打対策）

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || key.length < 8) {
    return res.status(400).json({ valid: false, reason: 'invalid_key_format' });
  }

  const cacheKey = `license:${key}`;

  // L1: Vercel KV キャッシュ確認
  try {
    const cached = await kv.get(cacheKey);
    if (cached !== null) {
      return res.status(200).json(cached);
    }
  } catch (_) {
    // KVエラーは無視してフォールスルー
  }

  // L2: Googleスプレッドシート台帳を確認
  const result = await _checkLicenseInSheets(key);

  // キャッシュに保存
  try {
    const ttl = result.valid ? CACHE_TTL_VALID : CACHE_TTL_INVALID;
    await kv.set(cacheKey, result, { ex: ttl });
  } catch (_) { /* KVエラーは無視 */ }

  return res.status(200).json(result);
}

async function _checkLicenseInSheets(key) {
  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    const sheetId = process.env.LICENSE_SHEET_ID;

    if (!serviceAccount.client_email || !sheetId) {
      console.error('LICENSE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON not configured');
      return { valid: false, reason: 'server_config_error' };
    }

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'ライセンス台帳!A2:F',  // A:キー B:会社名 C:プラン D:有効期限 E:メモ F:停止フラグ
    });

    const rows = resp.data.values || [];
    const row  = rows.find(r => r[0] === key);

    if (!row) return { valid: false, reason: 'not_found' };

    const suspended  = (row[5] || '').toLowerCase() === 'true';
    if (suspended) return { valid: false, reason: 'suspended' };

    const expiresAt = row[3] ? new Date(row[3]) : null;
    if (expiresAt && expiresAt < new Date()) {
      return { valid: false, reason: 'expired', expiresAt: expiresAt.toISOString() };
    }

    return {
      valid: true,
      company: row[1] || '',
      plan: row[2] || 'standard',
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
  } catch (err) {
    console.error('License check error:', err);
    return { valid: false, reason: 'server_error' };
  }
}
