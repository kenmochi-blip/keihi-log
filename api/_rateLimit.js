/**
 * レートリミット（固定ウィンドウ方式）
 * Vercel KV を使用。
 *
 * 設計上の安全策:
 *  - incr と ttl をパイプラインで実行し、TTL未設定なら expire を張り直す
 *    → クラッシュで expire が漏れた場合に「TTLなしキーで恒久ロック」になる不具合を治癒。
 *  - KV障害時はフェイルオープン（制限せず通す）。データ本体の認証・認可は別レイヤーが担保するため、
 *    レート制限が一時的に無効化されても安全側に倒す。
 *
 * @param {object} req - Vercel の request オブジェクト
 * @param {object} options
 * @param {string} options.prefix  - KVキーのプレフィックス（エンドポイントごとに分ける）
 * @param {number} options.limit   - ウィンドウ内の最大リクエスト数
 * @param {number} options.window  - ウィンドウ幅（秒）
 * @param {string} [options.id]    - 制限の単位。指定時はこの値（例: ユーザーのemail）でキーを作る。
 *                                    未指定時はIPアドレスを使う。
 * @returns {{ ok: boolean, remaining: number }}
 */

import { kv } from '@vercel/kv';

function _clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'] || '';
  // Vercel は信頼できるプロキシとして先頭に実クライアントIPを付与する
  return forwarded.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

export async function rateLimit(req, { prefix, limit, window, id }) {
  const unit = id ? `u:${String(id).toLowerCase()}` : `ip:${_clientIp(req)}`;
  const key = `${prefix}:${unit}`;

  try {
    // incr と ttl を1往復で取得
    const pipe = kv.pipeline();
    pipe.incr(key);
    pipe.ttl(key);
    const [count, ttl] = await pipe.exec();

    // ttl: -1 = キーは存在するがTTLなし / -2 = キーなし（通常ここには来ない）
    // TTLが張られていなければ張り直す（恒久ロック防止）
    if (ttl == null || ttl < 0) {
      await kv.expire(key, window);
    }

    return { ok: count <= limit, remaining: Math.max(0, limit - count) };
  } catch (_) {
    // KV障害時はフェイルオープン
    return { ok: true, remaining: limit };
  }
}
