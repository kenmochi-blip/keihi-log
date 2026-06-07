/**
 * 一時的な修正用エンドポイント — 使用後すぐに削除すること
 * 古いトライアルライセンス（trial フィールドなし）に trial:true を書き込む
 */
import { kv } from '@vercel/kv';

const TARGET_KEY = 'KL-799E28013D38477C00630BBF';

export default async function handler(req, res) {
  const data = await kv.get(`license:${TARGET_KEY}`).catch(() => null);
  if (!data) return res.status(404).json({ error: 'not_found' });

  const updated = { ...data, trial: true };
  await kv.set(`license:${TARGET_KEY}`, updated);

  return res.status(200).json({ ok: true, key: TARGET_KEY, trial: updated.trial, expiresAt: updated.expiresAt });
}
