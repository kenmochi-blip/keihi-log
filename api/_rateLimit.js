/**
 * IPベースのレートリミット（固定ウィンドウ方式）
 * Vercel KV を使用。
 *
 * @param {object} req - Next.js/Vercel の request オブジェクト
 * @param {object} options
 * @param {string} options.prefix  - KVキーのプレフィックス（エンドポイントごとに分ける）
 * @param {number} options.limit   - ウィンドウ内の最大リクエスト数
 * @param {number} options.window  - ウィンドウ幅（秒）
 * @returns {{ ok: boolean, remaining: number }}
 */

import { kv } from '@vercel/kv';

export async function rateLimit(req, { prefix, limit, window }) {
  const forwarded = req.headers['x-forwarded-for'] || '';
  const ip = forwarded.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const key = `${prefix}:${ip}`;

  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, window);

  return { ok: count <= limit, remaining: Math.max(0, limit - count) };
}
