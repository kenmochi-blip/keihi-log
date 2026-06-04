/**
 * 発行済みライセンス一覧 API（管理者専用）
 * GET    /api/admin-licenses?secret=ADMIN_SECRET                          一覧取得
 * GET    /api/admin-licenses?secret=ADMIN_SECRET&sentry_path=/...         Sentryプロキシ
 * GET    /api/admin-licenses?secret=ADMIN_SECRET&sentry_notes=get&issue_id=xxx
 * POST   /api/admin-licenses?secret=ADMIN_SECRET&sentry_notes=add&issue_id=xxx
 * POST   /api/admin-licenses?secret=ADMIN_SECRET&sentry_notes=del&issue_id=xxx&note_idx=N
 * POST   /api/admin-licenses?secret=ADMIN_SECRET&sentry_analyze=1         AI解析→ノート保存
 * POST   /api/admin-licenses?secret=ADMIN_SECRET                          手動発行
 * PATCH  /api/admin-licenses?secret=ADMIN_SECRET                          手動アップグレード
 * DELETE /api/admin-licenses?secret=ADMIN_SECRET&key=KL-                  削除
 */

import { kv } from '@vercel/kv';
import crypto from 'crypto';
import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  const { ok } = await rateLimit(req, { prefix: 'rl:admin', limit: 120, window: 60 });
  if (!ok) return res.status(429).json({ error: 'too_many_requests' });

  if (req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 通知登録者一覧
  if (req.query.notify_list) {
    const keys = [];
    let cursor = 0;
    do {
      const [next, batch] = await kv.scan(cursor, { match: 'notify:*', count: 100 });
      keys.push(...batch);
      cursor = Number(next);
    } while (cursor !== 0);
    const entries = await Promise.all(keys.map(k => kv.get(k)));
    entries.sort((a, b) => (a?.registeredAt || '').localeCompare(b?.registeredAt || ''));
    return res.status(200).json({ total: entries.length, entries });
  }

  // 紹介者マスタ管理
  if (req.query.referrers != null) {
    if (req.method === 'GET') {
      const list = await kv.get('referrer_master').catch(() => null) || [];
      return res.status(200).json({ referrers: list });
    }
    if (req.method === 'POST') {
      const { code, name, email, note } = req.body || {};
      if (!code || !name) return res.status(400).json({ error: 'code_and_name_required' });
      if (!/^[a-z0-9_]{2,30}$/.test(code)) return res.status(400).json({ error: 'invalid_code_format' });
      const list = await kv.get('referrer_master').catch(() => null) || [];
      if (list.find(r => r.code === code)) return res.status(409).json({ error: 'code_exists' });
      list.push({ code, name, email: email || '', note: note || '', addedAt: new Date().toISOString() });
      await kv.set('referrer_master', list);
      return res.status(200).json({ referrers: list });
    }
    if (req.method === 'DELETE') {
      const { code } = req.query;
      if (!code) return res.status(400).json({ error: 'code_required' });
      let list = await kv.get('referrer_master').catch(() => null) || [];
      list = list.filter(r => r.code !== code);
      await kv.set('referrer_master', list);
      return res.status(200).json({ referrers: list });
    }
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // 紹介者別支払いサマリー
  if (req.query.payout) {
    const month = /^\d{4}-\d{2}$/.test(req.query.payout)
      ? req.query.payout
      : new Date().toISOString().slice(0, 7);
    const startOfMonth = new Date(`${month}-01T00:00:00Z`);
    const endOfMonth   = new Date(startOfMonth);
    endOfMonth.setMonth(endOfMonth.getMonth() + 1);

    const keys = [];
    let cursor = 0;
    do {
      const [nextCursor, batch] = await kv.scan(cursor, { match: 'license:*', count: 100 });
      keys.push(...batch);
      cursor = Number(nextCursor);
    } while (cursor !== 0);

    const [licenseList, referrers] = await Promise.all([
      Promise.all(keys.map(k => kv.get(k))),
      kv.get('referrer_master').catch(() => null),
    ]);

    const refMaster = referrers || [];
    const payoutByCode = {};
    licenseList.forEach(lic => {
      if (!lic || !lic.referrer || lic.suspended) return;
      const created = lic.createdAt ? new Date(lic.createdAt) : null;
      const expires = lic.expiresAt ? new Date(`${lic.expiresAt}T23:59:59Z`) : null;
      if (created && created >= endOfMonth) return;
      if (expires && expires < startOfMonth) return;
      payoutByCode[lic.referrer] = (payoutByCode[lic.referrer] || 0) + 1;
    });

    const payout = refMaster.map(r => ({
      code:        r.code,
      name:        r.name,
      email:       r.email || '',
      activeCount: payoutByCode[r.code] || 0,
      amount:      (payoutByCode[r.code] || 0) * 200,
    }));
    const totalAmount = payout.reduce((s, r) => s + r.amount, 0);
    const totalActive = payout.reduce((s, r) => s + r.activeCount, 0);
    return res.status(200).json({ month, payout, totalAmount, totalActive });
  }

  // Sentryプロキシ
  if (req.query.sentry_path) {
    const sentryPath = req.query.sentry_path;
    if (!sentryPath.startsWith('/')) return res.status(400).json({ error: 'invalid path' });
    const token = process.env.SENTRY_AUTH_TOKEN;
    if (!token) return res.status(503).json({ error: 'SENTRY_AUTH_TOKEN not configured' });
    try {
      const resp = await fetch(`https://us.sentry.io/api/0${sentryPath}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      const hits = resp.headers.get('X-Hits');
      if (hits) res.setHeader('X-Hits', hits);
      return res.status(resp.status).json(data);
    } catch (err) {
      await _logToKV('sentry_proxy', 'error', err.message);
      return res.status(502).json({ error: err.message });
    }
  }

  // Sentryイシュー解決済みマーク
  if (req.query.sentry_resolve) {
    const issueId = req.query.issue_id;
    if (!issueId) return res.status(400).json({ error: 'issue_id required' });
    const token = process.env.SENTRY_AUTH_TOKEN;
    if (!token) return res.status(503).json({ error: 'SENTRY_AUTH_TOKEN not configured' });
    try {
      const resp = await fetch(`https://us.sentry.io/api/0/issues/${issueId}/`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const detail = data?.detail || data?.status || JSON.stringify(data);
        await _logToKV('sentry_resolve', 'error', `Sentry ${resp.status}: ${detail}`, { issueId });
        return res.status(resp.status).json({ error: `Sentry ${resp.status}: ${detail}` });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      await _logToKV('sentry_resolve', 'error', err.message, { issueId });
      return res.status(502).json({ error: err.message });
    }
  }

  // Sentryノート管理
  if (req.query.sentry_notes) {
    const action  = req.query.sentry_notes;
    const issueId = req.query.issue_id;
    if (!issueId) return res.status(400).json({ error: 'issue_id required' });
    const kvKey = `sentry_notes:${issueId}`;

    if (action === 'get') {
      const notes = await kv.get(kvKey).catch(() => null);
      return res.status(200).json({ notes: notes || [] });
    }
    if (action === 'add') {
      const { text } = req.body || {};
      if (!text?.trim()) return res.status(400).json({ error: 'text required' });
      const notes = await kv.get(kvKey).catch(() => null) || [];
      notes.push({ text: text.trim(), at: new Date().toISOString() });
      await kv.set(kvKey, notes);
      return res.status(200).json({ notes });
    }
    if (action === 'del') {
      const idx = parseInt(req.query.note_idx, 10);
      const notes = await kv.get(kvKey).catch(() => null) || [];
      if (!isNaN(idx) && idx >= 0 && idx < notes.length) notes.splice(idx, 1);
      await kv.set(kvKey, notes);
      return res.status(200).json({ notes });
    }
    return res.status(400).json({ error: 'unknown action' });
  }

  // SentryイシューのAI解析（Claude Haiku）→ノートとして保存
  if (req.query.sentry_analyze) {
    const { issueId, title, errorValue, culprit, level, count, userCount, lastSeen } = req.body || {};
    if (!issueId || !title) return res.status(400).json({ error: 'issueId and title required' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const prompt = `以下のSentryエラーについて、Webアプリ開発者向けに日本語で解析してください。

エラータイトル: ${title}
エラー詳細: ${errorValue || 'なし'}
発生箇所: ${culprit || 'なし'}
レベル: ${level || 'error'}
発生回数: ${count || '不明'}件
影響ユーザー数: ${userCount || '不明'}人
最終発生: ${lastSeen || '不明'}

以下の形式で簡潔に回答してください：

【推定原因】
（技術的な原因を2〜3文で）

【確認ポイント】
・（確認すべき点を箇条書きで）

【推奨対応】
（具体的な修正方針）

【優先度】高・中・低（一言で理由）`;

    try {
      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages:   [{ role: 'user', content: prompt }],
        }),
      });
      const claudeData = await claudeResp.json();
      const analysis = claudeData.content?.[0]?.text;
      if (!analysis) {
        const errMsg = claudeData.error?.message || JSON.stringify(claudeData);
        await _logToKV('sentry_analyze', 'error', `Claude API error: ${errMsg}`, { issueId });
        return res.status(502).json({ error: `Claude API error: ${errMsg}` });
      }

      const kvKey = `sentry_notes:${issueId}`;
      const notes = await kv.get(kvKey).catch(() => null) || [];
      notes.push({ text: analysis.trim(), at: new Date().toISOString(), ai: true });
      await kv.set(kvKey, notes);

      return res.status(200).json({ notes });
    } catch (err) {
      await _logToKV('sentry_analyze', 'error', err.message, { issueId });
      return res.status(502).json({ error: err.message });
    }
  }

  // Cloudflare Analytics
  if (req.query.cloudflare) {
    const token  = process.env.CLOUDFLARE_API_TOKEN;
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    if (!token || !zoneId) return res.status(503).json({ error: 'CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID not configured' });

    const days = Math.min(parseInt(req.query.days || '7', 10), 30);
    const end   = new Date(); end.setDate(end.getDate() - 1);
    const start = new Date(end); start.setDate(start.getDate() - (days - 1));
    const fmt   = d => d.toISOString().split('T')[0];

    const query = `{
      viewer {
        zones(filter: {zoneTag: "${zoneId}"}) {
          httpRequests1dGroups(
            limit: ${days}
            filter: {date_geq: "${fmt(start)}", date_leq: "${fmt(end)}"}
            orderBy: [date_DESC]
          ) {
            dimensions { date }
            sum {
              requests
              pageViews
              cachedRequests
              threats
              responseStatusMap { edgeResponseStatus requests }
            }
            uniq { uniques }
          }
        }
      }
    }`;

    try {
      const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = await resp.json();
      if (data.errors) return res.status(502).json({ error: data.errors[0]?.message || 'GraphQL error' });
      const groups = data.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
      return res.status(200).json({ groups });
    } catch (err) {
      await _logToKV('cloudflare', 'error', err.message);
      return res.status(502).json({ error: err.message });
    }
  }

  // アプリログ管理
  if (req.query.app_logs) {
    const action = req.query.app_logs;

    if (action === 'get') {
      const [logs, analysis] = await Promise.all([
        kv.lrange('app_log_list', 0, 49).catch(() => []),
        kv.get('app_log_analysis').catch(() => null),
      ]);
      return res.status(200).json({ logs, analysis });
    }

    if (action === 'clear' && req.method === 'POST') {
      await Promise.all([
        kv.del('app_log_list').catch(() => {}),
        kv.del('app_log_analysis').catch(() => {}),
      ]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'analyze' && req.method === 'POST') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

      const logs = await kv.lrange('app_log_list', 0, 19).catch(() => []);
      const errorLogs = logs.filter(l => l.level === 'error' || l.level === 'warn');
      if (errorLogs.length === 0) return res.status(200).json({ analysis: null, skipped: true });

      const logText = errorLogs.map(l =>
        `[${l.at}] ${l.level.toUpperCase()} [${l.handler}] ${l.message}${l.details ? ' / ' + JSON.stringify(l.details) : ''}`
      ).join('\n');

      const prompt = `以下は経費ログWebアプリ（Vercel Serverless Functions）のエラーログです。開発者向けに日本語で解析してください。

${logText}

以下の形式で簡潔に回答してください：

【ログ概要】
（何が起きているかを2〜3文で）

【主な問題】
・（問題点を箇条書きで）

【推奨対応】
（具体的な確認・修正事項）

【優先度】高・中・低（一言で理由）`;

      try {
        const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
            'content-type':      'application/json',
          },
          body: JSON.stringify({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            messages:   [{ role: 'user', content: prompt }],
          }),
        });
        const claudeData = await claudeResp.json();
        const text = claudeData.content?.[0]?.text;
        if (!text) return res.status(502).json({ error: claudeData.error?.message || 'Claude API error' });
        const analysis = { text: text.trim(), at: new Date().toISOString(), count: errorLogs.length };
        await kv.set('app_log_analysis', analysis);
        return res.status(200).json({ analysis });
      } catch (err) {
        return res.status(502).json({ error: err.message });
      }
    }

    return res.status(400).json({ error: 'unknown action' });
  }

  // DELETE: ライセンス削除
  if (req.method === 'DELETE') {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key required' });
    const data = await kv.get(`license:${key}`).catch(() => null);
    await kv.del(`license:${key}`);
    if (data?.email) {
      const arr = await _getEmailLicenses(kv, data.email);
      const updated = arr.filter(k => k !== key);
      if (updated.length > 0) {
        await kv.set(`email_licenses:${data.email}`, updated);
        await kv.set(`email_to_license:${data.email}`, updated[0]);
      } else {
        await kv.del(`email_licenses:${data.email}`).catch(() => {});
        await kv.del(`email_to_license:${data.email}`).catch(() => {});
      }
    }
    if (data?.stripeSessionId) await kv.del(`session:${data.stripeSessionId}`).catch(() => {});
    console.log(`License deleted: ${key}`);
    return res.status(200).json({ deleted: true });
  }

  // PATCH: 手動アップグレード
  if (req.method === 'PATCH') {
    const { key, action } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    const data = await kv.get(`license:${key}`).catch(() => null);
    if (!data) return res.status(404).json({ error: 'not found' });

    if (action === 'set_referrer') {
      const { referrer } = req.body;
      const updated = { ...data };
      if (referrer) updated.referrer = referrer;
      else delete updated.referrer;
      await kv.set(`license:${key}`, updated);
      return res.status(200).json({ ok: true, ...updated });
    }

    if (action === 'upgrade') {
      const { plan: newPlan, expiresAt: customExpiry } = req.body;
      const expiresAt = customExpiry ? new Date(customExpiry) : new Date();
      if (!customExpiry) expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      // プラン変更のみ（有料転換なし）の場合は planChangedAt を記録
      const isPlanOnly = !!newPlan && newPlan !== data.plan && !!data.upgradedAt;
      const updated = {
        ...data,
        ...(isPlanOnly ? { planChangedAt: new Date().toISOString(), prevPlan: data.plan } : { upgradedAt: new Date().toISOString() }),
        expiresAt:  expiresAt.toISOString().split('T')[0],
        note:       (data.note ? data.note + ' ' : '') + (isPlanOnly ? `→プラン変更（${newPlan}）` : '→有料転換（手動）'),
        ...(newPlan ? { plan: newPlan } : {}),
      };
      await kv.set(`license:${key}`, updated);
      console.log(`License manually ${isPlanOnly ? 'plan-changed' : 'upgraded'}: ${key}`);
      return res.status(200).json({ ok: true, ...updated });
    }

    return res.status(400).json({ error: 'unknown action' });
  }

  // POST: 手動発行
  if (req.method === 'POST') {
    const { company, email, plan, expiresAt, note } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    // 同一メールの既存ライセンス確認（最大3つまで）
    const existingKeys = await _getEmailLicenses(kv, email);
    const existingDatas = await Promise.all(existingKeys.map(k => kv.get(`license:${k}`).catch(() => null)));
    const activeCount = existingDatas.filter(d => d && !d.suspended).length;
    if (activeCount >= 3) {
      return res.status(409).json({ error: 'max_licenses_reached', existingKeys, activeCount });
    }

    const licenseKey = `KL-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
    const defaultExpiry = new Date();
    defaultExpiry.setFullYear(defaultExpiry.getFullYear() + 1);

    const licenseData = {
      company:   company || email,
      plan:      plan || 'standard',
      expiresAt: expiresAt || defaultExpiry.toISOString().split('T')[0],
      email,
      note:      note || '手動発行',
      createdAt: new Date().toISOString(),
      suspended: false,
    };

    await kv.set(`license:${licenseKey}`, licenseData);
    await _addEmailLicense(kv, email, licenseKey);
    console.log(`License manually issued: ${licenseKey} for ${email}`);

    if (process.env.RESEND_API_KEY) {
      const from     = process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com');
      const setupUrl = 'https://keihi-log.com/setup';

      await _sendEmail(from, email, '【経費ログ】ライセンスキーのご案内', `
<p>${licenseData.company} 様</p>
<p>経費ログのライセンスキーをお送りします。</p>
<p style="font-size:1.2em;font-family:monospace;background:#f5f5f5;padding:12px 16px;border-radius:6px;letter-spacing:1px;">
  <strong>${licenseKey}</strong>
</p>
<ul>
  <li>有効期限：${licenseData.expiresAt}</li>
</ul>
<p>下記のボタンからセットアップを開始してください。スプレッドシートの自動作成とライセンスキーの登録ができます。</p>
<p>
  <a href="${setupUrl}" style="display:inline-block;background:#0d6efd;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-size:1rem;font-weight:600;">経費ログのセットアップを開始する</a>
</p>
<p style="color:#666;font-size:0.9em;">ボタンが押せない場合は <a href="${setupUrl}">${setupUrl}</a> を開いてください。</p>
<p>ご不明な点はお気軽にお問い合わせください。</p>
      `.trim());

      if (process.env.ADMIN_NOTIFY_EMAIL) {
        await _sendEmail(from, process.env.ADMIN_NOTIFY_EMAIL, `【経費ログ】手動ライセンス発行 — ${licenseData.company}`, `
<p>手動でライセンスを発行しました。</p>
<table style="border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:4px 12px 4px 0;color:#666;">会社名・氏名</td><td>${licenseData.company}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">メールアドレス</td><td>${email}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">ライセンスキー</td><td style="font-family:monospace;">${licenseKey}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">プラン</td><td>${licenseData.plan}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">有効期限</td><td>${licenseData.expiresAt}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">備考</td><td>${licenseData.note}</td></tr>
</table>
        `.trim());
      }
    }

    return res.status(200).json({ key: licenseKey, ...licenseData });
  }

  // GET: 一覧取得
  try {
    const keys = [];
    let cursor = 0;
    do {
      const [nextCursor, batch] = await kv.scan(cursor, { match: 'license:*', count: 100 });
      keys.push(...batch);
      cursor = Number(nextCursor);
    } while (cursor !== 0);

    const thisYM = new Date().toISOString().slice(0, 7);
    const lastYM = (() => {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();

    const licenses = await Promise.all(
      keys.map(async key => {
        const licKey = key.replace('license:', '');
        const [data, usageThis, usageLast] = await Promise.all([
          kv.get(key),
          kv.get(`usage:${licKey}:${thisYM}`),
          kv.get(`usage:${licKey}:${lastYM}`),
        ]);
        return { key: licKey, ...data, usageThis: usageThis || 0, usageLast: usageLast || 0 };
      })
    );

    licenses.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const referrers = await kv.get('referrer_master').catch(() => null) || [];
    return res.status(200).json({
      total: licenses.length,
      licenses,
      referrers,
      sentryToken:  process.env.SENTRY_AUTH_TOKEN  || null,
      hasClaudeKey:  !!process.env.ANTHROPIC_API_KEY,
      hasCfKey:      !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID),
    });
  } catch (err) {
    console.error(err);
    await _logToKV('license_get', 'error', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

async function _getEmailLicenses(kv, email) {
  const arr = await kv.get(`email_licenses:${email}`).catch(() => null);
  if (Array.isArray(arr)) return arr;
  const single = await kv.get(`email_to_license:${email}`).catch(() => null);
  return single ? [single] : [];
}

async function _addEmailLicense(kv, email, licenseKey) {
  const existing = await _getEmailLicenses(kv, email);
  const updated = [...new Set([...existing, licenseKey])];
  await kv.set(`email_licenses:${email}`, updated);
  await kv.set(`email_to_license:${email}`, updated[0]);
}

async function _logToKV(handler, level, message, details = null) {
  try {
    const entry = { at: new Date().toISOString(), level, handler, message };
    if (details) entry.details = details;
    await kv.lpush('app_log_list', entry);
    await kv.ltrim('app_log_list', 0, 99);
  } catch (_) {}
}

async function _sendEmail(from, to, subject, html) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!resp.ok) console.error('Resend error:', await resp.text());
}
