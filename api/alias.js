/**
 * スプレッドシートエイリアス API
 *
 * GET  /api/alias?code=abc1xyz8  → { sheetId: "..." }
 * POST /api/alias { code, sheetId, licenseKey } → { ok: true }
 *
 * KV キー: alias:{code} → sheetId
 * 逆引き:  alias_by_sheet:{sheetId} → code  （重複登録防止）
 */

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // GET: エイリアス解決
  if (req.method === 'GET') {
    const { code, setup } = req.query;

    // セットアップリンク解決（ライセンスキー自動入力用）
    if (setup) {
      if (setup.length < 6) return res.status(400).json({ error: 'invalid_code' });
      const licenseKey = await kv.get(`lic_ref:${setup}`).catch(() => null);
      if (!licenseKey) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ licenseKey });
    }

    if (!code || code.length < 6) {
      return res.status(400).json({ error: 'invalid_code' });
    }
    const sheetId = await kv.get(`alias:${code}`).catch(() => null);
    if (sheetId) return res.status(200).json({ sheetId });
    // シートエイリアスで見つからない場合はセットアップコードとして試みる
    const licenseKey = await kv.get(`lic_ref:${code}`).catch(() => null);
    if (licenseKey) return res.status(200).json({ licenseKey });
    return res.status(404).json({ error: 'not_found' });
  }

  // POST: エイリアス登録（有効なライセンスキー＋setupCode必須）
  if (req.method === 'POST') {
    const { code, sheetId, licenseKey, setupCode } = req.body || {};
    if (!code || !sheetId || !licenseKey) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    if (code.length < 6 || !/^[a-zA-Z0-9_-]+$/.test(code)) {
      return res.status(400).json({ error: 'invalid_code_format' });
    }

    // ライセンスキーの有効性確認
    const licData = await kv.get(`license:${licenseKey}`).catch(() => null);
    if (!licData || licData.suspended) {
      return res.status(403).json({ error: 'invalid_license' });
    }

    // setupCode の照合（手動発行ライセンスは license_ref が存在しないためスキップ）
    const boundSetupCode = await kv.get(`license_ref:${licenseKey}`).catch(() => null);
    if (boundSetupCode && setupCode !== boundSetupCode) {
      return res.status(403).json({ error: 'setup_code_mismatch' });
    }

    // 既存のエイリアスがあれば古いものを削除
    const existingCode = await kv.get(`alias_by_sheet:${sheetId}`).catch(() => null);
    if (existingCode && existingCode !== code) {
      await kv.del(`alias:${existingCode}`).catch(() => {});
    }

    await kv.set(`alias:${code}`, sheetId);
    await kv.set(`alias_by_sheet:${sheetId}`, code);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
