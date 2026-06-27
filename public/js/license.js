/**
 * ライセンス検証クライアント
 * /api/license に問い合わせる。結果をlocalStorageに短時間キャッシュする。
 */
const License = (() => {

  const CACHE_KEY = 'keihi_license_cache_v2';
  const CACHE_TTL = 60 * 60 * 1000; // 1時間（ms）
  // トライアル中は短命キャッシュにする。これがないと有料転換後もリロードで
  // 古い trial:true を最大1時間返し続け、トライアルバナーが消えない。
  const TRIAL_CACHE_TTL = 30 * 1000; // 30秒（ms）

  async function verify(key) {
    if (!key) return { valid: false, reason: 'no_key' };

    // localStorage キャッシュ確認（ownerEmailがない古いキャッシュは無効化）
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && cached.key === key && Date.now() < cached.expiry && cached.result?.ownerEmail && 'trial' in (cached.result || {})) {
        return cached.result;
      }
    } catch (_) {}

    // API呼び出し（10秒タイムアウト）
    const base = window.APP_CONFIG?.apiBase || '';
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try {
      resp = await fetch(`${base}/api/license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
        signal: ctrl.signal,
      });
    } catch (_) {
      // タイムアウト・ネットワークエラー：既存キャッシュで続行、なければ invalid
      try {
        const stale = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (stale?.key === key && stale.result?.valid) return stale.result;
      } catch (_e) {}
      return { valid: false, reason: 'network_error' };
    } finally {
      clearTimeout(tid);
    }

    if (!resp.ok) {
      // サーバーエラーの場合は既存キャッシュがあれば許可（可用性優先）
      try {
        const stale = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (stale?.key === key && stale.result?.valid) return stale.result;
      } catch (_) {}
      return { valid: false, reason: 'server_error' };
    }

    const result = await resp.json();

    // キャッシュ保存
    try {
      const ttl = result.valid
        ? (result.trial ? TRIAL_CACHE_TTL : CACHE_TTL) // 有料転換を素早く反映するため trial は短命
        : 60 * 60 * 1000;
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        key,
        result,
        expiry: Date.now() + ttl,
      }));
    } catch (_) {}

    return result;
  }

  function clearCache() {
    localStorage.removeItem(CACHE_KEY);
  }

  return { verify, clearCache };
})();
