/**
 * スプレッドシートエイリアス API
 *
 * GET  /api/alias?code=abc1xyz8     → { sheetId: "..." }
 * GET  /api/alias?licenseKey=KL-... → { alias: "..." }  ← セットアップ済み確認用
 * POST /api/alias { code, sheetId, licenseKey } → { ok: true }
 *
 * KV キー: alias:{code} → sheetId
 * 逆引き:  alias_by_sheet:{sheetId} → code
 * ライセンス逆引き: license_alias:{licenseKey} → code  （重複セットアップ防止）
 */

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // GET: エイリアス解決
  if (req.method === 'GET') {
    const { code, setup, licenseKey } = req.query;

    // ライセンスキーからセットアップ済みエイリアスを確認
    if (licenseKey) {
      const alias = await kv.get(`license_alias:${licenseKey}`).catch(() => null);
      if (!alias) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ alias });
    }

    // セットアップリンク解決（ライセンスキー自動入力用）
    if (setup) {
      if (setup.length < 6) return res.status(400).json({ error: 'invalid_code' });
      const lk = await kv.get(`lic_ref:${setup}`).catch(() => null);
      if (!lk) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ licenseKey: lk });
    }

    if (!code || code.length < 3) {
      return res.status(400).json({ error: 'invalid_code' });
    }
    const sheetId = await kv.get(`alias:${code}`).catch(() => null);
    if (sheetId) {
      const aliasLic = await kv.get(`alias_lic:${code}`).catch(() => null);
      return res.status(200).json({ sheetId, ...(aliasLic ? { licenseKey: aliasLic } : {}) });
    }
    // シートエイリアスで見つからない場合はセットアップコードとして試みる
    const lk2 = await kv.get(`lic_ref:${code}`).catch(() => null);
    if (lk2) return res.status(200).json({ licenseKey: lk2 });
    return res.status(404).json({ error: 'not_found' });
  }

  // POST: エイリアス登録（有効なライセンスキー必須）
  if (req.method === 'POST') {
    const { code, sheetId, licenseKey, setupCode } = req.body || {};
    if (!code || !sheetId || !licenseKey) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    if (code.length < 3 || !/^[a-zA-Z0-9_-]+$/.test(code)) {
      return res.status(400).json({ error: 'invalid_code_format' });
    }

    // ライセンスキーの有効性確認
    const licData = await kv.get(`license:${licenseKey}`).catch(() => null);
    if (!licData || licData.suspended) {
      return res.status(403).json({ error: 'invalid_license' });
    }

    // 同一ライセンスキーで既にセットアップ済みか確認
    const existingAlias = await kv.get(`license_alias:${licenseKey}`).catch(() => null);
    if (existingAlias && existingAlias !== code) {
      return res.status(409).json({ error: 'already_setup', alias: existingAlias });
    }

    // setupCode の照合（手動発行ライセンスは license_ref が存在しないためスキップ）
    const boundSetupCode = await kv.get(`license_ref:${licenseKey}`).catch(() => null);
    if (boundSetupCode && setupCode !== boundSetupCode) {
      return res.status(403).json({ error: 'setup_code_mismatch' });
    }

    // 一度登録したエイリアスは変更不可
    const existingCode = await kv.get(`alias_by_sheet:${sheetId}`).catch(() => null);
    if (existingCode && existingCode !== code) {
      return res.status(409).json({ error: 'alias_already_set', alias: existingCode });
    }

    // 指定コードが別のシートで使われていないか確認
    const existingSheet = await kv.get(`alias:${code}`).catch(() => null);
    if (existingSheet && existingSheet !== sheetId) {
      return res.status(409).json({ error: 'code_taken' });
    }

    await kv.set(`alias:${code}`, sheetId);
    await kv.set(`alias_by_sheet:${sheetId}`, code);
    await kv.set(`license_alias:${licenseKey}`, code);
    await kv.set(`alias_lic:${code}`, licenseKey);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

