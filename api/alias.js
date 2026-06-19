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
import { rateLimit } from './_rateLimit.js';
import { sheetsClient } from './_sa.js';

/** シートの設定B2（会社名）をSAで直接読む。失敗時は空文字を返す。 */
async function _readCompanyNameFromSheet(sheetId) {
  try {
    const sheets = sheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId, range: '設定!B2',
    });
    return String(r.data.values?.[0]?.[0] || '');
  } catch (_) {
    return '';
  }
}

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
      let companyName = await kv.get(`alias_company:${code}`).catch(() => null);

      // alias_company が未設定の場合は SA でシートの B2 を直接読んでキャッシュ
      if (!companyName) {
        companyName = await _readCompanyNameFromSheet(sheetId);
        if (companyName) {
          // fire-and-forget: 次回以降は KV から高速返却
          kv.set(`alias_company:${code}`, companyName).catch(() => {});
          // 逆引きインデックスも補完
          kv.set(`alias_by_sheet:${sheetId}`, code).catch(() => {});
        }
      }

      return res.status(200).json({
        sheetId,
        ...(aliasLic    ? { licenseKey: aliasLic }     : {}),
        ...(companyName ? { companyName }               : {}),
      });
    }
    // シートエイリアスで見つからない場合はセットアップコードとして試みる
    const lk2 = await kv.get(`lic_ref:${code}`).catch(() => null);
    if (lk2) return res.status(200).json({ licenseKey: lk2 });
    return res.status(404).json({ error: 'not_found' });
  }

  // POST: エイリアス登録（有効なライセンスキー必須）
  if (req.method === 'POST') {
    // ライセンスキー総当たり・エイリアス量産を防ぐためレート制限
    const rl = await rateLimit(req, { prefix: 'rl:alias', limit: 10, window: 60 });
    if (!rl.ok) return res.status(429).json({ error: 'rate_limited' });

    const { code, sheetId, licenseKey, setupCode, companyName } = req.body || {};
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

    // setupCode の照合（手動発行ライセンスは license_ref が存在しないためスキップ）
    const boundSetupCode = await kv.get(`license_ref:${licenseKey}`).catch(() => null);
    if (boundSetupCode && setupCode !== boundSetupCode) {
      return res.status(403).json({ error: 'setup_code_mismatch' });
    }

    // 既存エイリアスを取得（独自URL登録時に旧ランダムURLを削除するため）
    const oldAlias = await kv.get(`license_alias:${licenseKey}`).catch(() => null);

    // コード→シートIDの衝突チェック（別ライセンスが同じコードを使っていないか）
    if (oldAlias !== code) {
      const existingSheet = await kv.get(`alias:${code}`).catch(() => null);
      if (existingSheet && existingSheet !== sheetId) {
        return res.status(409).json({ error: 'code_taken' });
      }
    }

    // 旧エイリアスを削除（独自URLへの切替時にランダムURLを無効化）
    if (oldAlias && oldAlias !== code) {
      await Promise.all([
        kv.del(`alias:${oldAlias}`),
        kv.del(`alias_lic:${oldAlias}`),
        kv.del(`alias_company:${oldAlias}`),
      ]).catch(() => {});
    }

    // 新エイリアスを登録・license_aliasを上書き更新
    await kv.set(`alias:${code}`, sheetId);
    await kv.set(`license_alias:${licenseKey}`, code);
    await kv.set(`alias_by_sheet:${sheetId}`, code);
    await kv.set(`alias_lic:${code}`, licenseKey);
    if (companyName) await kv.set(`alias_company:${code}`, companyName);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

