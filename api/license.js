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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || key.length < 8) {
    return res.status(400).json({ valid: false, reason: 'invalid_key_format' });
  }
  // このシステムが発行するキーのみ受け付ける（旧システムのSS-プレフィックス等を排除）
  if (!key.startsWith('KL-') && !key.startsWith('TR-')) {
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
      return res.status(200).json({ valid: false, reason: 'expired', expiresAt: data.expiresAt });
    }

    return res.status(200).json({
      valid: true,
      company:   data.company   || '',
      plan:      data.plan      || 'standard',
      expiresAt: data.expiresAt || null,
      ownerEmail: (data.email   || '').toLowerCase(),
    });

  } catch (err) {
    console.error('License KV error:', err);
    return res.status(200).json({ valid: false, reason: 'server_error' });
  }
}
