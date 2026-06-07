/**
 * ライセンス検証 API
 *
 * 受け取るのはライセンスキーのみ。ユーザーデータは一切受け取らない。
 * ライセンスデータは Vercel KV に直接保存する（Google Sheets 不要）。
 *
 * KV のキー形式:
 *   license:{キー文字列}
 *   → { valid: true, company: "会社名", plan: "standard", expiresAt: "YYYY-MM-DD" }
 *
 * 環境変数（Vercelダッシュボードで自動設定される）:
 *   KV_REST_API_URL, KV_REST_API_TOKEN  ← Vercel KV接続後に自動追加
 */

import { kv } from '@vercel/kv';
import { rateLimit } from './_rateLimit.js';
import { captureException } from './_sentry.js';

export default async function handler(req, res) {
  // GET /api/license?session=cs_xxx → セッションIDからライセンスキーを返す（サンクスページ用）
  // ※ Hobbyプランの関数数上限のため旧 /api/get-license をここに統合
  if (req.method === 'GET') {
    const { session } = req.query;
    if (!session) return res.status(400).json({ error: 'session required' });
    try {
      const licenseKey = await kv.get(`session:${session}`);
      if (!licenseKey) return res.status(404).json({ error: 'not_found' });
      const data = await kv.get(`license:${licenseKey}`);
      if (!data) return res.status(404).json({ error: 'not_found' });
      const setupCode = await kv.get(`license_ref:${licenseKey}`).catch(() => null);
      return res.status(200).json({
        licenseKey,
        company:   data.company,
        expiresAt: data.expiresAt,
        email:     data.email,
        setupCode: setupCode || null,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'server_error' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { ok } = await rateLimit(req, { prefix: 'rl:license', limit: 20, window: 60 });
  if (!ok) return res.status(429).json({ valid: false, reason: 'too_many_requests' });

  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || key.length < 8) {
    return res.status(400).json({ valid: false, reason: 'invalid_key_format' });
  }
  // このシステムが発行するキーのみ受け付ける（旧システムのSS-プレフィックス等を排除）
  if (!key.startsWith('KL-')) {
    return res.status(200).json({ valid: false, reason: 'not_found' });
  }

  try {
    const data = await kv.get(`license:${key}`);

    if (!data) {
      return res.status(200).json({ valid: false, reason: 'not_found' });
    }

    // 停止フラグ確認
    if (data.suspended) {
      return res.status(200).json({ valid: false, reason: 'suspended' });
    }

    // 有効期限確認
    if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
      return res.status(200).json({
        valid: false, reason: 'expired', expiresAt: data.expiresAt,
        trial: data.trial === true, plan: data.plan || 'solo',
      });
    }

    return res.status(200).json({
      valid: true,
      company:      data.company      || '',
      customerName: data.customerName || '',
      plan:         data.plan         || 'standard',
      expiresAt:    data.expiresAt    || null,
      ownerEmail:   (data.email       || '').toLowerCase(),
      trial:        data.trial === true,
    });

  } catch (err) {
    console.error('License KV error:', err);
    captureException(err, { key });
    return res.status(200).json({ valid: false, reason: 'server_error' });
  }
}
