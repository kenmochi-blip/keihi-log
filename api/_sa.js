/**
 * サービスアカウント（SA）認証ヘルパー（B'案 / クリーンAPIプロキシ用）
 *
 * 環境変数 GOOGLE_SA_KEY にサービスアカウントのJSON鍵（文字列）を格納しておくこと。
 * SA はメンバーが直接アクセスできない共有スプレッドシートに対し、
 * エディタとして共有されている前提で読み書きを代行する。
 *
 * 鍵はコードに書かず Vercel 環境変数のみに保管する。
 */
import { google } from 'googleapis';

let _auth = null;

function _credentials() {
  const raw = process.env.GOOGLE_SA_KEY;
  if (!raw) throw new Error('GOOGLE_SA_KEY が未設定です');
  let creds;
  try {
    creds = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    throw new Error('GOOGLE_SA_KEY のJSONパースに失敗しました');
  }
  return creds;
}

/** GoogleAuth クライアントを返す（ウォームインスタンスをキャッシュ）。 */
export function getSaAuth() {
  if (_auth) return _auth;
  _auth = new google.auth.GoogleAuth({
    credentials: _credentials(),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  return _auth;
}

/** Sheets API v4 クライアント */
export function sheetsClient() {
  return google.sheets({ version: 'v4', auth: getSaAuth() });
}

/** Drive API v3 クライアント */
export function driveClient() {
  return google.drive({ version: 'v3', auth: getSaAuth() });
}

/** SA が設定されているか（GOOGLE_SA_KEY の有無）を返す。 */
export function isSaConfigured() {
  return !!process.env.GOOGLE_SA_KEY;
}

let _gaAuth = null;

/** GA4 Data API 読み取り用 GoogleAuth（analytics.readonly スコープ・別インスタンス）。 */
export function getAnalyticsAuth() {
  if (_gaAuth) return _gaAuth;
  _gaAuth = new google.auth.GoogleAuth({
    credentials: _credentials(),
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  return _gaAuth;
}

/** GA4 Analytics Data API v1beta クライアント */
export function analyticsDataClient() {
  return google.analyticsdata({ version: 'v1beta', auth: getAnalyticsAuth() });
}
