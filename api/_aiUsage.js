/**
 * Gemini API 利用量の計測（1枚あたりの実コストを確定させるための実測ツール）
 *
 * 目的: 「AI解析のAPIキーをBYOKから当方負担へ切り替えるか」の判断材料として、
 *   ・領収書1枚あたりの実トークン数（＝実コスト）
 *   ・チーム単位の利用分布（＝無料枠を何枚に設定すべきか）
 *   ・テール（極端に重いリクエスト）の頻度
 * を実データで押さえる。試算ではなく実測でしか決められないため。
 *
 * 設計方針:
 *   - 計測の失敗が本来の処理を止めては絶対にならない。全て try/catch で握り潰す。
 *   - 保存するのは集計値のみ。プロンプト・画像・解析結果は一切保存しない。
 *   - KVのハッシュに日次集約（1リクエストで数コマンド）。90日でTTL失効。
 */
import { kv } from '@vercel/kv';

const TTL_SEC = 90 * 24 * 3600;

/** JST基準の YYYY-MM-DD（運用者の感覚と日次グラフを合わせるため） */
export function jstDay(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export const usageKey = day => `ai:usage:${day}`;
export const teamKey  = day => `ai:team:${day}`;

/**
 * Geminiレスポンスの usageMetadata を日次集計へ加算する。
 * @param {object}  o
 * @param {string}  o.source   'web' | 'line' | 'demo'
 * @param {string}  o.sheetId  チーム識別（デモは 'demo'）。分布の把握のみに使う
 * @param {object}  o.data     Geminiのレスポンス全体（usageMetadata を含む）
 * @param {boolean} o.ok       upstreamが成功したか
 */
export async function recordAiUsage({ source = 'web', sheetId = '', data = null, ok = true } = {}) {
  try {
    const day = jstDay();
    const k = usageKey(day);

    if (!ok) {
      await kv.hincrby(k, 'err', 1);
      await kv.expire(k, TTL_SEC).catch(() => {});
      return;
    }

    const u = (data && data.usageMetadata) || {};
    const p = Number(u.promptTokenCount)     || 0;
    const c = Number(u.candidatesTokenCount) || 0;
    const t = Number(u.totalTokenCount)      || (p + c);

    // 1リクエストの総トークンを1,000刻みでバケット化する。
    // 平均だけではテール（複数枚添付・高解像度）が見えず、上限設計を誤るため。
    const bucket = Math.min(Math.floor(t / 1000), 30);

    await Promise.all([
      kv.hincrby(k, 'req', 1),
      kv.hincrby(k, 'ptok', p),
      kv.hincrby(k, 'ctok', c),
      kv.hincrby(k, 'ttok', t),
      kv.hincrby(k, `src:${source}:req`, 1),
      kv.hincrby(k, `src:${source}:ttok`, t),
      kv.hincrby(k, `bkt:${bucket}`, 1),
    ]);
    await kv.expire(k, TTL_SEC).catch(() => {});

    // チーム別の枚数分布（無料枠を月◯枚にすべきかの判断材料）
    const team = sheetId || 'unknown';
    const tk = teamKey(day);
    await kv.hincrby(tk, team, 1);
    await kv.expire(tk, TTL_SEC).catch(() => {});
  } catch (_) {
    // 計測は本処理に影響させない
  }
}
