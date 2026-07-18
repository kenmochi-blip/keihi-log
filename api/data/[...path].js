/**
 * B' クリーンAPI キャッチオール・ルーター
 *
 * /api/data/* への全リクエストを単一のサーバーレス関数で処理する。
 * Vercel Hobby プランの「1デプロイあたり関数12個」上限内に収めるため、
 * B' の各エンドポイント（health / expenses / masters / settings / receipt / gemini）
 * を個別ファイルにせず、このルーターの中で内部分岐する。
 *
 * URL 構造はそのまま綺麗に保たれる:
 *   GET  /api/data/health
 *   GET  /api/data/expenses
 *   ...
 *
 * 認可モデル（B'の核心）:
 *   クライアントは Authorization: Bearer <Google ID token> で本人(email)を証明する。
 *   サーバーは SA で対象シートの「マスタ表」を読み、その email がメンバーか確認する。
 *   メンバーのみデータを返す。admin は全件、一般メンバーは自分の行のみ（サーバー側フィルタ）。
 */
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { kv } from '@vercel/kv';
import { sheetsClient, driveClient, isSaConfigured } from '../_sa.js';
import { getSaAuth } from '../_sa.js';
import { verifyIdToken } from '../_verifyToken.js';
import { rateLimit } from '../_rateLimit.js';
import { FAQ_TEXT } from '../_faq-data.js';
import { RICHMENU_PNG_BASE64, RICHMENU_LINK_PNG_BASE64 } from '../_richmenuImage.js';

// bodyParser を無効化し、ボディは手動で読む（_readRaw）。
// 理由: LINE Webhook の署名検証(HMAC-SHA256)には「生ボディの厳密なバイト列」が必要で、
//       Vercel の bodyParser を通すと生ボディが失われるため。関数12個制限内に収めるため
//       LINE Webhook を別ファイルにせずこのキャッチオールに同居させる（設計 §4）。
//       生ボディは _readRaw で1度だけ読み req にキャッシュ、JSON化は _body が担う。
export const config = { api: { bodyParser: false } };

// in-processキャッシュ（ウォームインスタンス内でのKV往復を排除する）
// Vercelのサーバーレス関数はウォームインスタンスを再利用するため、モジュール変数がリクエスト間で共有される。
// 外部KVへのネットワーク往復（~50-100ms）をゼロにできる。
const _inProc = new Map(); // key → { value, expiresAt }
function _inProcGet(key) {
  const e = _inProc.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _inProc.delete(key); return null; }
  return e.value;
}
function _inProcSet(key, value, ttlMs) {
  _inProc.set(key, { value, expiresAt: Date.now() + ttlMs });
  // マップが肥大化しないよう上限を設ける
  if (_inProc.size > 200) {
    const now = Date.now();
    for (const [k, v] of _inProc) { if (now > v.expiresAt) _inProc.delete(k); }
  }
}
function _inProcDel(key) { _inProc.delete(key); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // req.query.path (Vercel dynamic route injection) が空の場合もあるため
  // req.url から直接パスを解析する（確実な方法）
  const urlPath = req.url ? req.url.split('?')[0] : '';
  const segs = urlPath.split('/').filter(Boolean);
  // segs例: ['api', 'data', 'health'] → resource = 'health'
  const resource = segs[2] || segs[segs.length - 1] || '';

  try {
    switch (resource) {
      case 'health':
        return await health(req, res);
      case 'expenses':
        return await expenses(req, res);
      case 'approve':
        return await expensesApprove(req, res);
      case 'settle':
        return await expensesSettle(req, res);
      case 'unsettle':
        return await expensesUnsettle(req, res);
      case 'masters':
        return await masters(req, res);
      case 'settings':
        return await settings(req, res);
      case 'receipt':
        return await receipt(req, res);
      case 'gemini':
        return await gemini(req, res);
      case 'accountant':
        return await accountantRouter(req, res);
      case 'chat':
        return await chat(req, res);
      // LINE 連携（Vercelのこの構成では2階層パス /api/data/line/* が関数に届かないため、
      // 動作実績のある1階層リソース名で登録する）
      case 'linewebhook':
        return await lineWebhook(req, res);
      case 'linecode':
        return await lineCodeIssue(req, res);
      case 'lineunlink':
        return await lineUnlink(req, res);
      case 'linedrivetoken':
        return await lineDriveToken(req, res);
      case 'linerichmenu':
        return await lineRichMenu(req, res);
      case 'linelinks':
        return await lineLinks(req, res);
      case 'setupdone':
        return await setupDoneEmail(req, res);
      default:
        return res.status(404).json({ error: 'not_found', resource });
    }
  } catch (e) {
    console.error('data router error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}

/**
 * セットアップ完了メールを送る（POST /api/data/setupdone）。
 * 乱用防止のため、送信先は Google ID トークンで認証されたユーザー本人のメールのみ。
 * body: { url, companyName }。url は keihi-log.com のチームURLに限定。
 */
async function setupDoneEmail(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const me = await verifyIdToken(req);
  if (!me || !me.email) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.RESEND_API_KEY) return res.status(200).json({ ok: false, skipped: 'no_mailer' });

  let body = {};
  try { body = (await _body(req)) || {}; } catch (_) {}
  const url = String(body.url || '').trim().slice(0, 300);
  const company = String(body.companyName || '').trim().slice(0, 100);
  if (!/^https:\/\/keihi-log\.com\/[A-Za-z0-9_-]+/.test(url)) {
    return res.status(400).json({ error: 'invalid_url' });
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const teamName = company ? `${esc(company)} の経費ログ` : '経費ログ';
  const safeUrl = esc(url);
  const html = `<!DOCTYPE html><html lang="ja"><body style="margin:0;background:#f4f6f9;font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;color:#2b3a4d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 0;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
  <tr><td style="background:linear-gradient(135deg,#0d6efd,#0a52c9);padding:28px 32px;color:#fff;">
    <div style="font-size:20px;font-weight:800;">経費ログ</div>
    <div style="font-size:22px;font-weight:800;margin-top:10px;">セットアップが完了しました 🎉</div>
  </td></tr>
  <tr><td style="padding:28px 32px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;"><strong>${teamName}</strong> の初期設定が完了しました。<br>このメールは管理者ご自身用の控えです。下記URLをブックマークし、メンバーへ共有してください。</p>

    <p style="margin:0 0 8px;font-size:13px;color:#6c757d;">▼ チーム専用URL（このURLからログインします）</p>
    <p style="margin:0 0 20px;"><a href="${safeUrl}" style="font-size:16px;font-weight:700;color:#0d6efd;word-break:break-all;">${safeUrl}</a></p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 26px;"><tr><td style="border-radius:8px;background:#0d6efd;">
      <a href="${safeUrl}" style="display:inline-block;padding:12px 28px;color:#fff;font-weight:700;font-size:15px;text-decoration:none;border-radius:8px;">アプリを開く</a>
    </td></tr></table>

    <div style="border-top:1px solid #eef1f5;padding-top:20px;">
      <p style="margin:0 0 10px;font-size:15px;font-weight:700;">メンバーの始め方</p>
      <ol style="margin:0 0 20px;padding-left:20px;font-size:14px;line-height:1.8;color:#42506a;">
        <li>上のチーム専用URLをメンバーに共有</li>
        <li>メンバーが「Googleでログイン」→ すぐに申請できます</li>
        <li>（チームプラン）LINE連携なら、GoogleアカウントがなくてもLINEで申請できます</li>
      </ol>

      <p style="margin:0 0 10px;font-size:15px;font-weight:700;">メンバーを追加するには</p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.8;color:#42506a;">アプリの <strong>設定タブ → メンバー管理</strong> から、メンバーのメールアドレスを登録します（管理者・閲覧者・一般の3段階で権限を設定できます）。LINE専用メンバーはメール欄を空欄にして追加できます。</p>

      <p style="margin:0 0 8px;font-size:14px;line-height:1.8;">
        📘 <a href="https://keihi-log.com/faq" style="color:#0d6efd;">よくある質問（FAQ）</a><br>
        📗 <a href="https://keihi-log.com/guide" style="color:#0d6efd;">メンバー向け 使い方ガイド</a>
      </p>
    </div>
  </td></tr>
  <tr><td style="background:#f8f9fa;padding:18px 32px;font-size:12px;color:#8a97a8;line-height:1.7;">
    お困りのことがあれば <a href="mailto:support@keihi-log.com" style="color:#0d6efd;">support@keihi-log.com</a> までお気軽にご連絡ください。<br>経費ログ
  </td></tr>
</table></td></tr></table></body></html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || 'support@keihi-log.com',
        to: [me.email],
        subject: '【経費ログ】セットアップが完了しました',
        html,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('setupdone mail failed:', r.status, t.slice(0, 200));
      return res.status(200).json({ ok: false });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('setupdone mail error:', e?.message || e);
    return res.status(200).json({ ok: false });
  }
}

/**
 * 共通認可: ID トークンで本人(email)を確認し、対象シートのメンバーか判定する。
 * 成功時は { me, isAdmin, master } を返す。失敗時は res にエラーを書いて null を返す。
 */
async function _authorize(req, res) {
  const me = await verifyIdToken(req);
  if (!me) { res.status(401).json({ error: 'unauthorized' }); return null; }

  const sheetId = _query(req).get('sheetId');
  if (!sheetId || !_validSheetId(sheetId)) {
    res.status(400).json({ error: 'invalid_sheet_id' }); return null;
  }

  let master;
  try {
    master = await readMasterCached(sheetId);
  } catch (e) {
    // SA がシートにアクセスできない場合（共有未設定など）は 503 を返す（500 ではなくプロキシ失敗と明示）
    res.status(503).json({ error: 'sa_sheet_access_failed', message: e.message || 'SA cannot read sheet' });
    return null;
  }
  // admin = D列='admin' または ライセンスオーナー（購入メール＝ログインメール）。
  // オーナーは D列が空欄/未登録なら常に管理者（ロックアウト防止）。ただし D列に明示的に
  // 'viewer' / 'member' と記入された場合はその降格を尊重する（クライアントの _computeRole と一致）。
  // NOTE: 購入メールとGoogleログインメールが異なる場合はオーナー昇格が効かないため D列='admin' が必要（仕様）。
  const ownerEmail = await resolveOwnerEmail(sheetId).catch(() => '');
  const isOwner = !!ownerEmail && me.email === ownerEmail;
  const ownerRow = master.members.find(m => m.email === me.email);
  const ownerDemoted = ['viewer', 'member'].includes((ownerRow?.role || '').toLowerCase());
  const isAdmin = master.admins.includes(me.email) || (isOwner && !ownerDemoted);
  const isViewer = master.viewers?.includes(me.email);
  const isMember = isAdmin || isViewer || master.members.some(m => m.email === me.email);
  if (!isMember) { res.status(403).json({ error: 'not_a_member' }); return null; }

  // ソロプラン（有料・非トライアル）はオーナー1名のみ利用可。
  // トライアル中はチーム扱いで自由に使えるが、ソロで有料転換すると、トライアル中に追加した
  // 余剰メンバー（オーナー／管理者以外）はここで拒否される（LINE と同様の実行時ガード）。
  // ※ オーナー・管理者は常に許可（購入メールとログインメールが異なるケースでのロックアウト防止）。
  if (!isAdmin && !isOwner) {
    const { active, isTrial, plan } = await _readPlanInfo(sheetId);
    if (active && !isTrial && plan === 'solo') {
      res.status(403).json({ error: 'solo_owner_only',
        message: 'このアカウントはソロプランのため、オーナー以外のメンバーはご利用いただけません。メンバーで使うにはチームプランへの変更が必要です。' });
      return null;
    }
  }

  return { me, isAdmin, isViewer, master, sheetId, ownerEmail };
}

/**
 * 会計事務所認可: ID トークンを検証し、referrer_master に登録されたメールアドレスか確認する。
 * 成功時は { me, referrer } を返す。失敗時は res にエラーを書いて null を返す。
 */
async function _authorizeAccountant(req, res) {
  const me = await verifyIdToken(req);
  if (!me) { res.status(401).json({ error: 'unauthorized' }); return null; }
  const referrers = await kv.get('referrer_master').catch(() => null) || [];
  const referrer = referrers.find(r => (r.email || '').toLowerCase() === me.email);
  if (!referrer) { res.status(403).json({ error: 'not_an_accountant' }); return null; }
  return { me, referrer };
}

/* ───────────────────────── エンドポイント ───────────────────────── */

/**
 * GET /api/data/health
 *   SA が認証トークンを取得できるかの疎通確認（機密値は返さない）。
 *
 * GET /api/data/health?sheetId=XXX
 *   【一時的・共有検証用】SA が対象シートにアクセスできるかを確認する。
 *   行データ・氏名・メール等のPIIは返さず、タブ構成と行数のみを返す。
 *   expenses 配線・検証が済んだら削除してよい。
 */
async function health(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  if (!isSaConfigured()) {
    return res.status(200).json({ saConfigured: false, authenticated: false });
  }

  // 注: 以前はここで ?sheetId= を無認証で受け、対象シートの会社名・タブ構成・
  //     メンバー数・経費行数（PII/メタ情報）を返していたが、認可なしの情報漏洩に
  //     なるため撤去した。SA の疎通確認のみを返す。
  try {
    const auth = getSaAuth();
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return res.status(200).json({
      saConfigured: true,
      authenticated: !!token?.token,
      serviceAccountEmail: client.email || null,
    });
  } catch (e) {
    return res.status(200).json({
      saConfigured: true,
      authenticated: false,
      error: e.message || 'sa_auth_failed',
    });
  }
}

/**
 * GET /api/data/expenses?sheetId=XXX[&refresh=1]
 *   経費一覧を SA 経由で取得する。
 *   - 要 ID トークン（本人=email）。
 *   - 対象シートのマスタ表に登録されたメンバーのみ許可。
 *   - admin は全件、一般メンバーは自分の行のみ。
 *   - 60秒 KV キャッシュ（refresh=1 でバイパス）。キャッシュは全件を保持し、
 *     メンバーごとのフィルタはレスポンス時に行う（キャッシュ汚染を避ける）。
 */
async function expenses(req, res) {
  const sub = _pathSegs(req)[3] || '';
  if (sub === 'approve')  return expensesApprove(req, res);
  if (sub === 'settle')   return expensesSettle(req, res);
  if (sub === 'unsettle') return expensesUnsettle(req, res);
  if (req.method === 'GET')    return expensesGet(req, res);
  if (req.method === 'POST')   return expensesCreate(req, res);
  if (req.method === 'PUT')    return expensesEdit(req, res);
  if (req.method === 'DELETE') return expensesDelete(req, res);
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function expensesGet(req, res) {
  const authz = await _authorize(req, res);
  if (!authz) return;
  const { me, isAdmin, isViewer, sheetId } = authz;
  const refresh = _query(req).get('refresh') === '1';

  // キャッシュ（全件）→ レスポンス時にロール別フィルタ
  // 1st: in-process / 2nd: KV / 3rd: Sheets
  const cacheKey = `data:exp:${sheetId}`;
  let all = null;
  if (!refresh) {
    all = _inProcGet(cacheKey);
    if (!all) {
      all = await kv.get(cacheKey).catch(() => null);
      if (all) _inProcSet(cacheKey, all, 55_000);
    }
  }
  let cached = !!all;
  if (!all) {
    all = await readExpensesViaSA(sheetId);
    _inProcSet(cacheKey, all, 55_000);
    kv.set(cacheKey, all, { ex: 60 }).catch(() => {}); // fire-and-forget
    cached = false;
  }

  const canViewAll = isAdmin || isViewer;
  const rows = canViewAll ? all : all.filter(e => (e.email || '').toLowerCase() === me.email);
  // 証票リンク（Drive URL）を署名付きプロキシURLへ書き換える。
  // 署名は「このメンバーが閲覧できる経費」にのみ発行されるため、他人の証票URLは取得できない。
  // キャッシュ済みオブジェクトは変更せずシャローコピーで返す（署名はリクエスト毎に再発行）。
  const signed = rows.map(e => e.imageLinks ? { ...e, imageLinks: _signImageLinks(e.imageLinks) } : e);
  return res.status(200).json({
    expenses: signed,
    role: isAdmin ? 'admin' : isViewer ? 'viewer' : 'member',
    cached,
  });
}

/**
 * POST /api/data/expenses  body: { row: [21列の経費行] }
 *   新規申請を SA 経由で経費一覧の先頭に追記する。
 *   セキュリティ上、サーバーが以下を強制する（クライアント値を信用しない）:
 *   - P列(email) = トークンの本人メール（なりすまし防止）
 *   - J列(confirmed=承認) = admin のときのみ true 許可（一般メンバーの自己承認防止）
 *   - Q列(id) = 未指定なら採番
 */
/**
 * 同一シートへの経費書き込み（新規追加・編集・削除）を直列化するアドバイザリロック（KV NX）。
 * これらは「行を特定/挿入 → その行へ書き込み/削除」の複数ステップで、この間に別の
 * 書き込みが割り込むと行番号がずれ、申請の消失・隣の行の誤上書き/誤削除が起きる。
 * 書き込みの間だけ相互排他をかけてこれを防ぐ。
 *  - 取得できなければ短時間スピン（最大 ~5s）で待機。
 *  - 待っても取れない場合はロックなしで続行（フェイルオープン：ロック無しの現状挙動に劣化するだけ）。
 *  - KV障害（set が例外）時はスピンせず即続行（障害時に無駄な数秒待ちを生まない）。
 *  - TTL付きなのでクラッシュ時も最大 LOCK_TTL 秒で自動解放。
 */
async function _withSheetWriteLock(sheetId, fn) {
  const lockKey = `wlock:${sheetId}`;
  const LOCK_TTL = 15;                       // 秒（異常時の自動解放）
  const MAX_WAIT_MS = 5000, STEP_MS = 100;
  let held = false;
  for (let waited = 0; waited <= MAX_WAIT_MS; waited += STEP_MS) {
    let acquired;
    try {
      acquired = await kv.set(lockKey, '1', { nx: true, ex: LOCK_TTL });
    } catch (_) {
      break;   // KV障害：スピンせず即座にロック無しで続行
    }
    if (acquired) { held = true; break; }     // 取得成功
    await new Promise(r => setTimeout(r, STEP_MS));  // 他が保持中：少し待って再試行
  }
  try {
    return await fn();
  } finally {
    if (held) await kv.del(lockKey).catch(() => {});
  }
}

async function expensesCreate(req, res) {
  const authz = await _authorize(req, res);
  if (!authz) return;
  const { me, isAdmin, sheetId } = authz;

  const body = await _body(req);
  const row = body?.row;
  if (!Array.isArray(row) || row.length < 17) {
    return res.status(400).json({ error: 'invalid_row' });
  }
  // 21列に正規化
  const r = row.slice(0, 21);
  while (r.length < 21) r.push('');

  // ── サーバー強制フィールド ──
  r[15] = me.email;                       // P: email（本人に強制）
  r[9]  = isAdmin ? (r[9] === true || r[9] === 'TRUE') : false; // J: 承認は admin のみ
  if (!r[16]) r[16] = _uuid();            // Q: id
  r[8]  = _normalizeImageLinks(r[8]);     // I: 署名付きプロキシURL→永続Drive URLへ戻す

  // insert→write→format を直列化し、同時追加による行ズレ・申請消失を防ぐ
  await _withSheetWriteLock(sheetId, () => prependExpenseRowViaSA(sheetId, r));
  _inProcDel(`data:exp:${sheetId}`); await kv.del(`data:exp:${sheetId}`).catch(() => {}); // 一覧キャッシュ無効化

  return res.status(200).json({ ok: true, id: r[16] });
}

/**
 * PUT /api/data/expenses  body: { id, row }
 *   既存申請を編集する。旧データを「修正履歴」に残してから経費一覧を更新（電帳法）。
 *   認可: admin、または「申請済（未承認・未精算）かつ本人」のみ。
 */
async function expensesEdit(req, res) {
  const authz = await _authorize(req, res);
  if (!authz) return;
  const { me, isAdmin, sheetId } = authz;

  const body = await _body(req);
  const id = body?.id;
  const row = body?.row;
  if (!id || !Array.isArray(row) || row.length < 17) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  // 行の特定→書き込みを直列化（他の追加/削除による行ズレで隣の行を誤上書きしないため）
  return _withSheetWriteLock(sheetId, async () => {
    const found = await _getExpenseByIdViaSA(sheetId, id);
    if (!found) return res.status(404).json({ error: 'not_found' });
    // 精算済（実精算）は誰でも編集不可（電帳法）。誤精算の訂正は admin 限定の unsettle 経由で行う。
    if (_isRealSettled(found.raw)) return res.status(403).json({ error: 'settled_locked' });
    if (!_canModify(me, isAdmin, found.raw)) return res.status(403).json({ error: 'forbidden' });

    const r = row.slice(0, 21);
    while (r.length < 21) r.push('');
    // 整合性: 所有者(P)は元のまま維持（編集者で上書きしない）、承認(J)は admin のみ true 可
    r[15] = found.raw[15] || me.email;
    r[9]  = isAdmin ? (r[9] === true || r[9] === 'TRUE') : false;
    r[16] = id;
    r[8]  = _normalizeImageLinks(r[8]);     // I: 署名付きプロキシURL→永続Drive URLへ戻す

    // 修正履歴に変更前/変更後を2行で残す（変更セルを色付き）
    await _writeEditHistory(sheetId, _nowJst(), me.email, found.raw, r);
    await updateRangeViaSA(sheetId, `経費一覧!A${found.rowNum}:U${found.rowNum}`, [r]);
    _inProcDel(`data:exp:${sheetId}`); await kv.del(`data:exp:${sheetId}`).catch(() => {});

    return res.status(200).json({ ok: true, id });
  });
}

/**
 * DELETE /api/data/expenses?id=XXX  （または body { id }）
 *   申請を削除する。削除前に「削除一覧」へ退避（電帳法）。
 *   認可: admin、または「申請済かつ本人」。精算済（実精算）は誰でも削除不可。
 */
async function expensesDelete(req, res) {
  const authz = await _authorize(req, res);
  if (!authz) return;
  const { me, isAdmin, sheetId } = authz;

  const id = _query(req).get('id') || (await _body(req))?.id;
  if (!id) return res.status(400).json({ error: 'invalid_request' });

  // 行の特定→退避→削除を直列化（他の追加/削除による行ズレで隣の行を誤削除しないため）
  return _withSheetWriteLock(sheetId, async () => {
    const found = await _getExpenseByIdViaSA(sheetId, id);
    if (!found) return res.status(404).json({ error: 'not_found' });

    // 精算済（実精算＝会社払いマーカー以外の精算日）は削除禁止（電帳法）
    if (_isRealSettled(found.raw)) return res.status(403).json({ error: 'settled_locked' });
    if (!_canModify(me, isAdmin, found.raw)) return res.status(403).json({ error: 'forbidden' });

    const raw21 = found.raw.slice(0, 21);
    while (raw21.length < 21) raw21.push('');
    await prependRowViaSA(sheetId, '削除一覧', [_nowJst(), me.email, ...raw21]);
    await deleteRowViaSA(sheetId, '経費一覧', found.rowNum);
    _inProcDel(`data:exp:${sheetId}`); await kv.del(`data:exp:${sheetId}`).catch(() => {});

    return res.status(200).json({ ok: true, id });
  });
}

/**
 * POST /api/data/expenses/approve  body: { ids: [...] }
 *   申請を「登録済」にする（J列=true）。admin 専用。
 */
async function expensesApprove(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const authz = await _authorize(req, res);
  if (!authz) return;
  if (!authz.isAdmin) return res.status(403).json({ error: 'admin_only' });

  const ids = (await _body(req))?.ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'invalid_request' });

  let rowNums, data;
  try {
    rowNums = await _rowNumsByIds(authz.sheetId, ids);
    data = rowNums.map(n => ({ range: `経費一覧!J${n}`, values: [[true]] }));
    if (data.length) await batchUpdateValuesViaSA(authz.sheetId, data);
  } catch (e) {
    console.error('expensesApprove sheet error:', e.message, { sheetId: authz.sheetId, ids });
    return res.status(500).json({ error: 'sheet_write_failed', message: e.message });
  }
  _inProcDel(`data:exp:${authz.sheetId}`); await kv.del(`data:exp:${authz.sheetId}`).catch(() => {});

  return res.status(200).json({ ok: true, updated: data.length });
}

/**
 * POST /api/data/expenses/settle  body: { ids: [...], date: 'YYYY-MM-DD' }
 *   申請を精算済にする（L列=精算日）。admin 専用。
 */
async function expensesSettle(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const authz = await _authorize(req, res);
  if (!authz) return;
  if (!authz.isAdmin) return res.status(403).json({ error: 'admin_only' });

  const body = await _body(req);
  const ids = body?.ids;
  const date = body?.date;
  if (!Array.isArray(ids) || !ids.length || !date) return res.status(400).json({ error: 'invalid_request' });

  let rowNums, data;
  try {
    rowNums = await _rowNumsByIds(authz.sheetId, ids);
    data = rowNums.map(n => ({ range: `経費一覧!L${n}`, values: [[String(date)]] }));
    if (data.length) await batchUpdateValuesViaSA(authz.sheetId, data);
  } catch (e) {
    console.error('expensesSettle sheet error:', e.message, { sheetId: authz.sheetId, ids });
    return res.status(500).json({ error: 'sheet_write_failed', message: e.message });
  }
  _inProcDel(`data:exp:${authz.sheetId}`); await kv.del(`data:exp:${authz.sheetId}`).catch(() => {});

  return res.status(200).json({ ok: true, updated: data.length });
}

/**
 * POST /api/data/expenses/unsettle  body: { ids: [...] }
 *   精算済（L列=精算日）を解除して登録済に戻す。admin 専用。
 *   電帳法上、レコードの削除は不可だが、精算ステータスの訂正（戻し）は
 *   修正履歴で追える操作として許容する。会社払いマーカーは対象外（実精算のみ解除）。
 */
async function expensesUnsettle(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const authz = await _authorize(req, res);
  if (!authz) return;
  if (!authz.isAdmin) return res.status(403).json({ error: 'admin_only' });

  const body = await _body(req);
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'invalid_request' });

  // 実精算（会社払いマーカー以外の精算日）のみ解除対象とする
  const rowNums = [];
  for (const id of ids) {
    const found = await _getExpenseByIdViaSA(authz.sheetId, id);
    if (found && _isRealSettled(found.raw)) rowNums.push(found.rowNum);
  }
  const data = rowNums.map(n => ({ range: `経費一覧!L${n}`, values: [['']] }));
  if (data.length) await batchUpdateValuesViaSA(authz.sheetId, data);
  _inProcDel(`data:exp:${authz.sheetId}`); await kv.del(`data:exp:${authz.sheetId}`).catch(() => {});

  return res.status(200).json({ ok: true, updated: data.length });
}

/**
 * GET  /api/data/masters?sheetId=XXX  マスタ取得（メンバー共通）
 * PUT  /api/data/masters?sheetId=XXX  マスタ表を SA で一括上書き（admin専用）
 *   body: { rows: [[...], ...] }  — A2:H の全行データ。余剰行クリア込みで渡すこと。
 */
async function masters(req, res) {
  if (req.method === 'PUT') return mastersWrite(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const authz = await _authorize(req, res);
  if (!authz) return;
  // _authorize が読んだマスタをそのまま返す（追加のAPIコールを避ける）
  return res.status(200).json({ master: authz.master });
}

async function mastersWrite(req, res) {
  const authz = await _authorize(req, res);
  if (!authz) return;
  if (!authz.isAdmin) return res.status(403).json({ error: 'admin_only' });

  const { rows } = (await _body(req)) || {};
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows_required' });

  const sheetId = authz.sheetId;

  // 逆引きインデックス更新のため変更前のメール一覧を取得（KVキャッシュから、なければ空）
  const oldMaster = await kv.get(`acct:master:${sheetId}`).catch(() => null);
  const oldEmails = (oldMaster?.members || []).map(m => m.email).filter(Boolean);
  const newEmails = rows.map(r => (r[1] || '').toLowerCase().trim()).filter(Boolean);

  // 既存データを全消去してから書き込む（削除時の残留行を防ぐ）
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: 'マスタ表!A2:H' });
  if (rows.length > 0) {
    await updateRangeViaSA(sheetId, `マスタ表!A2:H${rows.length + 1}`, rows);
  }

  // キャッシュ即時無効化 + 逆引きインデックス更新を並列実行
  _inProcDel(`acct:master:${sheetId}`);
  await Promise.all([
    kv.del(`acct:master:${sheetId}`).catch(() => {}),
    kv.del(`acct:all:${sheetId}`).catch(() => {}),
    _updateClientIndex(sheetId, oldEmails, newEmails),
  ]);
  return res.status(200).json({ ok: true });
}

/**
 * acct:clients:{email} = [sheetId, ...] という逆引きインデックスを差分更新する。
 * mastersWrite のたびに呼ばれ、メンバー削除は即時反映される。
 */
async function _updateClientIndex(sheetId, oldEmails, newEmails) {
  const oldSet = new Set(oldEmails);
  const newSet = new Set(newEmails);
  const added   = [...newSet].filter(e => !oldSet.has(e));
  const removed = [...oldSet].filter(e => !newSet.has(e));
  await Promise.all([
    ...added.map(async email => {
      const key = `acct:clients:${email}`;
      const cur = await kv.get(key).catch(() => null) || [];
      if (!cur.includes(sheetId)) await kv.set(key, [...cur, sheetId]).catch(() => {});
    }),
    ...removed.map(async email => {
      const key = `acct:clients:${email}`;
      const cur = await kv.get(key).catch(() => null) || [];
      const upd = cur.filter(id => id !== sheetId);
      if (upd.length > 0) await kv.set(key, upd).catch(() => {});
      else await kv.del(key).catch(() => {});
    }),
  ]);
}

/**
 * GET /api/data/settings?sheetId=XXX
 *   設定シートを SA 経由で取得する。
 *   ★ B5（Gemini APIキー）はブラウザに返さない（B'の趣旨：鍵はサーバー側に留める）。
 *     管理者の鍵設定/更新や Gemini 実行は別エンドポイントで扱う（後続実装）。
 *   返却: B2会社名 / B3ライセンス / B4フォルダID / B6 / B7、および hasGeminiKey。
 */
async function settings(req, res) {
  if (req.method === 'PUT' || req.method === 'POST') return settingsWrite(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const authz = await _authorize(req, res);
  if (!authz) return;

  const settCacheKey = `cfg:settings:${authz.sheetId}`;
  let cached = _inProcGet(settCacheKey);
  if (!cached) {
    cached = await kv.get(settCacheKey).catch(() => null);
    if (cached) _inProcSet(settCacheKey, cached, 55_000);
  }
  if (cached) return res.status(200).json(cached);

  const sheets = sheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: authz.sheetId, range: '設定!B2:B7',
  });
  const rows = resp.data.values || [];
  const cell = i => rows?.[i]?.[0] ?? '';
  const payload = {
    settings: {
      B2: cell(0), B3: cell(1), B4: cell(2),
      B5: '',      B6: cell(4), B7: cell(5),
    },
    hasGeminiKey: !!cell(3),
  };
  _inProcSet(settCacheKey, payload, 55_000);
  kv.set(settCacheKey, payload, { ex: 60 }).catch(() => {}); // fire-and-forget
  return res.status(200).json(payload);
}

/**
 * PUT /api/data/settings?sheetId=XXX  body: { cell: 'B2', value: '...' }
 *   設定シートの単一セルを SA 経由で書き込む。admin 専用。
 *   書き込み可能セルは B2〜B7 のみにホワイトリスト制限（任意セル書き換えを防ぐ）。
 *   B5（Gemini APIキー）も書き込みは許可（鍵はサーバー側に留めたまま設定/更新できる）。
 */
async function settingsWrite(req, res) {
  const authz = await _authorize(req, res);
  if (!authz) return;
  if (!authz.isAdmin) return res.status(403).json({ error: 'admin_only' });

  const body = await _body(req);
  const cell = String(body?.cell || '');
  if (!/^B[2-7]$/.test(cell)) return res.status(400).json({ error: 'invalid_cell' });
  const value = body?.value;

  await updateRangeViaSA(authz.sheetId, `設定!${cell}`, [[value == null ? '' : value]]);
  // 設定キャッシュを即削除（書き込み後に古い値が返され続けるのを防ぐ）
  _inProcDel(`cfg:settings:${authz.sheetId}`);
  kv.del(`cfg:settings:${authz.sheetId}`).catch(() => {});
  // Geminiキー（B5）更新時はキーキャッシュも即削除
  if (cell === 'B5') {
    _inProcDel(`gemini:key:${authz.sheetId}`);
    kv.del(`gemini:key:${authz.sheetId}`).catch(() => {});
  }
  // 会社名（B2）更新時は OGP 用の alias_company も KV に同期
  if (cell === 'B2' && value) {
    (async () => {
      let code = await kv.get(`alias_by_sheet:${authz.sheetId}`).catch(() => null);
      if (!code) {
        // alias_by_sheet が未設定の場合はライセンスキー経由で逆引き
        const settKey = `cfg:settings:${authz.sheetId}`;
        const sett = _inProcGet(settKey) || await kv.get(settKey).catch(() => null);
        const licKey = sett?.settings?.B3;
        if (licKey) code = await kv.get(`license_alias:${licKey}`).catch(() => null);
        if (code) kv.set(`alias_by_sheet:${authz.sheetId}`, code).catch(() => {}); // インデックス補完
      }
      if (code) kv.set(`alias_company:${code}`, String(value)).catch(() => {});
    })().catch(() => {});
  }
  return res.status(200).json({ ok: true });
}

/* ───────────────────────── 証票（領収書）プロキシ ───────────────────────── */

/**
 * 証票アップロード/閲覧プロキシ。
 *   POST /api/data/receipt?sheetId=XXX  body: { base64, mimeType, filename }
 *     → メンバー認可後、設定B4の証票フォルダへ SA でアップロードし webViewLink を返す。
 *   GET  /api/data/receipt?fileId=YYY&exp=...&sig=...
 *     → HMAC署名付きURLを検証し、SA で画像本体をストリーム配信（強キャッシュ）。
 *        署名は expenses 読み取り時に「閲覧権のある経費」にのみ発行される。
 */
async function receipt(req, res) {
  if (req.method === 'POST') return receiptUpload(req, res);
  if (req.method === 'GET')  return receiptGet(req, res);
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function receiptUpload(req, res) {
  const authz = await _authorize(req, res);
  if (!authz) return;

  const body = await _body(req);
  const base64   = String(body?.base64 || '');
  const mimeType = String(body?.mimeType || 'application/octet-stream');
  const filename = String(body?.filename || 'receipt');
  if (!base64) return res.status(400).json({ error: 'no_file' });

  try {
    // 証票フォルダID（設定!B4）を SA で取得
    const sheets = sheetsClient();
    const cfg = await sheets.spreadsheets.values.get({
      spreadsheetId: authz.sheetId, range: '設定!B4',
    });
    const folderId = cfg.data.values?.[0]?.[0] || '';
    if (!folderId) return res.status(500).json({ error: 'no_folder_id', message: '設定シートB4にフォルダIDが設定されていません' });

    const clean = base64.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(clean, 'base64');
    const drive = driveClient();
    const created = await drive.files.create({
      requestBody: { name: filename, mimeType, parents: [folderId] },
      media: { mimeType, body: bufferToStream(buf) },
      fields: 'id, webViewLink',
    });

    return res.status(200).json({ id: created.data.id, webViewLink: created.data.webViewLink });
  } catch (e) {
    console.error('receiptUpload error:', e?.message || e, e?.response?.data || '');
    return res.status(500).json({ error: 'upload_failed', message: e?.message || 'unknown' });
  }
}

async function receiptGet(req, res) {
  const q = _query(req);
  const fileId = q.get('fileId') || '';
  const exp = Number(q.get('exp') || 0);
  const sig = q.get('sig') || '';
  if (!fileId || !exp || !sig) return res.status(400).json({ error: 'bad_request' });
  if (Date.now() > exp) return res.status(403).json({ error: 'expired' });
  if (!_verifyReceiptSig(fileId, exp, sig)) return res.status(403).json({ error: 'bad_signature' });

  try {
    const drive = driveClient();
    const meta = await drive.files.get({ fileId, fields: 'mimeType' });
    const mime = meta.data.mimeType || 'application/octet-stream';
    const stream = await drive.files.get(
      { fileId, alt: 'media' }, { responseType: 'stream' }
    );
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline');
    // 証票は不変なのでブラウザ内に長期キャッシュ（署名TTL内のみ有効）
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    await new Promise((resolve, reject) => {
      stream.data.on('end', resolve).on('error', reject).pipe(res);
    });
  } catch (e) {
    console.error('receiptGet error:', e?.message || e);
    return res.status(404).json({ error: 'not_found' });
  }
}

/** Buffer を Readable ストリームへ（googleapis の media.body 用）。 */
function bufferToStream(buf) {
  return Readable.from(buf);
}

/** 証票署名の秘密鍵（GOOGLE_SA_KEY から導出。新規環境変数を増やさない）。 */
function _receiptSecret() {
  return crypto.createHash('sha256').update(process.env.GOOGLE_SA_KEY || '').digest();
}
function _signReceipt(fileId, exp) {
  return crypto.createHmac('sha256', _receiptSecret()).update(`${fileId}:${exp}`).digest('hex');
}
function _verifyReceiptSig(fileId, exp, sig) {
  const expected = _signReceipt(fileId, exp);
  const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Drive URL から fileId を抽出。 */
function _driveFileId(url) {
  const s = String(url || '');
  const m = s.match(/\/d\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}
/** 書き込み時の逆変換：署名付きプロキシURLを永続的な Drive URL に戻す。
 *  =HYPERLINK("...") ラップやカンマ結合を壊さないよう、URL部分のみを置換する。
 *  （クライアントが読み取り時の署名URLをそのまま書き戻しても、シートには正準URLを保存する） */
function _normalizeImageLinks(links) {
  const s = String(links || '');
  if (!s || !s.includes('/api/data/receipt')) return s;
  return s.replace(/\/api\/data\/receipt\?[^"',\s]*/g, (m) => {
    const id = m.match(/[?&]fileId=([a-zA-Z0-9_-]+)/)?.[1] || '';
    return id ? `https://drive.google.com/file/d/${id}/view` : m;
  });
}

/* ───────────────────────── Gemini プロキシ ───────────────────────── */

/**
 * POST /api/data/gemini?sheetId=XXX  body: { contents, generationConfig }
 *   設定B5（Gemini APIキー）を SA で読み、Gemini API を代理呼び出しする。
 *   ★ APIキーはブラウザに一切返さない（B'の趣旨：BYOK鍵をサーバー側に留める）。
 *   レスポンスは Gemini の生JSONをそのまま透過（クライアントの既存パースに合わせる）。
 */
async function gemini(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const authz = await _authorize(req, res);
  if (!authz) return;

  // キーは5分キャッシュ（in-process優先→KV→Sheets。B5更新時は両キャッシュを即削除）
  const keyCacheKey = `gemini:key:${authz.sheetId}`;
  let apiKey = _inProcGet(keyCacheKey);
  if (!apiKey) {
    apiKey = await kv.get(keyCacheKey).catch(() => null);
    if (apiKey) _inProcSet(keyCacheKey, apiKey, 290_000);
  }
  if (!apiKey) {
    const sheets = sheetsClient();
    const cfg = await sheets.spreadsheets.values.get({
      spreadsheetId: authz.sheetId, range: '設定!B5',
    });
    apiKey = cfg.data.values?.[0]?.[0] || '';
    if (apiKey) {
      _inProcSet(keyCacheKey, apiKey, 290_000);
      kv.set(keyCacheKey, apiKey, { ex: 300 }).catch(() => {}); // fire-and-forget
    }
  }
  if (!apiKey) return res.status(400).json({ error: 'no_gemini_key' });

  const body = await _body(req);
  if (!body?.contents) return res.status(400).json({ error: 'invalid_request' });

  // gemini-2.5-flash は無料枠が20 RPD/日に削減されたため、500 RPD の flash-lite を使用（2026-06確認）
  const MODEL = 'gemini-3.1-flash-lite';
  // キーはURLに含めずヘッダーで送る（アクセスログへの漏洩防止）
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(55000),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return res.status(504).json({ error: 'gemini_error', message: 'Gemini APIがタイムアウトしました（55秒超）。画像を小さくするか、時間をおいて再試行してください。' });
    }
    throw e;
  }
  const data = await upstream.json().catch(() => ({}));
  // 鍵が含まれ得るエラー詳細はそのまま返さず、ステータスのみ透過
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: 'gemini_error', message: data?.error?.message || '' });
  }
  return res.status(200).json(data);
}

/** カンマ区切りの証票URL群を署名付きプロキシURLへ書き換える。抽出不能URLは原文維持。 */
function _signImageLinks(links) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  return String(links).split(',').map(s => s.trim()).filter(Boolean).map(url => {
    const id = _driveFileId(url);
    if (!id) return url;
    return `/api/data/receipt?fileId=${encodeURIComponent(id)}&exp=${exp}&sig=${_signReceipt(id, exp)}`;
  }).join(',');
}

/* ───────────────────────── 会計事務所ダッシュボード ─────────────────────── */

/**
 * GET    /api/data/accountant                  プロファイル（顧問先リスト）取得
 * POST   /api/data/accountant                  顧問先追加 { sheetId, name }
 * DELETE /api/data/accountant?sheetId=XXX      顧問先削除
 * GET    /api/data/accountant/summary?month=YYYY-MM  月次集計（証票URL署名付き）
 */
async function accountantRouter(req, res) {
  const sub = _pathSegs(req)[3] || '';
  if (sub === 'summary') return accountantSummary(req, res);
  if (req.method === 'GET')    return accountantProfile(req, res);
  if (req.method === 'POST')   return accountantAddClient(req, res);
  if (req.method === 'DELETE') return accountantRemoveClient(req, res);
  return res.status(405).json({ error: 'method_not_allowed' });
}

/** KV の特定パターンに一致する全キーをスキャンして返す */
async function _kvScanAll(pattern) {
  const keys = [];
  let cur = 0;
  do {
    const [next, batch] = await kv.scan(cur, { match: pattern, count: 100 });
    keys.push(...batch);
    cur = Number(next);
  } while (cur !== 0);
  return keys;
}

/** alias:* + license_alias:* から sheetId → 会社名 の解決マップを構築する（Sheets API不要） */
async function _buildNameMap() {
  const [aliasKeys, laKeys] = await Promise.all([_kvScanAll('alias:*'), _kvScanAll('license_alias:*')]);
  const [aliasValues, laValues] = await Promise.all([
    Promise.all(aliasKeys.map(k => kv.get(k))),
    Promise.all(laKeys.map(k => kv.get(k))),
  ]);
  const codeToLicKey = new Map();
  laKeys.forEach((k, i) => { if (laValues[i]) codeToLicKey.set(laValues[i], k.replace('license_alias:', '')); });

  const idToCode = new Map();
  aliasKeys.forEach((k, i) => { if (aliasValues[i]) idToCode.set(aliasValues[i], k.replace('alias:', '')); });

  return { idToCode, codeToLicKey };
}

/**
 * 会計事務所メールアドレスに紐づく顧問先一覧を返す。
 *
 * 高速パス: acct:clients:{email} の逆引きインデックスが存在すればそれを使用。
 *   Sheets API 呼び出しゼロ。顧問先数が増えても O(1)。
 * フォールバック: インデックス未構築（旧シートなど）の場合は alias:* フルスキャン
 *   + 各マスタ表チェックを行い、同時にインデックスを構築する。
 */
async function _getAllClientsForAccountant(accountantEmail, refresh = false) {
  const lcEmail = (accountantEmail || '').toLowerCase();
  const indexKey = `acct:clients:${lcEmail}`;

  // ── 高速パス ──────────────────────────────────────────────────────────
  const indexedIds = !refresh ? await kv.get(indexKey).catch(() => null) : null;
  if (indexedIds !== null) {
    if (!indexedIds.length) return [];
    const { idToCode, codeToLicKey } = await _buildNameMap();
    const clients = await Promise.all(indexedIds.filter(_validSheetId).map(async sheetId => {
      const code   = idToCode.get(sheetId);
      const licKey = code ? codeToLicKey.get(code) : null;
      const lic    = licKey ? await kv.get(`license:${licKey}`).catch(() => null) : null;
      return { sheetId, name: lic?.company || '（社名未設定）' };
    }));
    return clients;
  }

  // ── フォールバック: フルスキャン（インデックス未構築時） ──────────────
  const { idToCode, codeToLicKey } = await _buildNameMap();
  if (!idToCode.size) return [];

  const clients = [];
  await Promise.all([...idToCode.entries()].map(async ([sheetId, code]) => {
    if (!_validSheetId(sheetId)) return;

    const masterCacheKey = `acct:master:${sheetId}`;
    let master = await kv.get(masterCacheKey).catch(() => null);
    if (!master) {
      master = await readMaster(sheetId).catch(() => null);
      if (master) await kv.set(masterCacheKey, master, { ex: 300 }).catch(() => {});
    }
    if (!master || !master.members.some(m => m.email === lcEmail)) return;

    // このシートのインデックスをついでに構築（次回以降は高速パスを通る）
    const cur = await kv.get(indexKey).catch(() => null) || [];
    if (!cur.includes(sheetId)) await kv.set(indexKey, [...cur, sheetId]).catch(() => {});

    const licKey = codeToLicKey.get(code);
    const lic    = licKey ? await kv.get(`license:${licKey}`).catch(() => null) : null;
    clients.push({ sheetId, name: lic?.company || '（社名未設定）' });
  }));
  return clients;
}

async function accountantProfile(req, res) {
  const authz = await _authorizeAccountant(req, res);
  if (!authz) return;

  // マスタ表への登録でオプトインした顧問先を自動解決
  const autoClients = await _getAllClientsForAccountant(authz.me.email);

  // 手動追加分（後方互換として残す）
  const manual = await kv.get(`acct:${authz.me.email}`).catch(() => null) || { sheets: [] };
  const autoIds = new Set(autoClients.map(c => c.sheetId));
  const manualOnly = (manual.sheets || []).filter(s => !autoIds.has(s.sheetId));

  const clients = [...autoClients, ...manualOnly];
  return res.status(200).json({ referrer: authz.referrer, clients });
}

async function accountantAddClient(req, res) {
  const authz = await _authorizeAccountant(req, res);
  if (!authz) return;

  const body    = await _body(req);
  const sheetId = String(body?.sheetId || '');
  const name    = String(body?.name    || '').trim();
  if (!_validSheetId(sheetId) || !name) return res.status(400).json({ error: 'invalid_request' });

  const key     = `acct:${authz.me.email}`;
  const profile = await kv.get(key).catch(() => null) || { sheets: [] };

  const autoClients = await _getAllClientsForAccountant(authz.me.email);
  if (autoClients.some(c => c.sheetId === sheetId) || profile.sheets.some(s => s.sheetId === sheetId)) {
    return res.status(409).json({ error: 'already_registered' });
  }

  try {
    const sheets = sheetsClient();
    await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'properties.title' });
  } catch {
    return res.status(503).json({ error: 'sa_sheet_access_failed' });
  }

  profile.sheets.push({ sheetId, name, addedAt: new Date().toISOString(), auto: false });
  await kv.set(key, profile);

  const autoIds = new Set(autoClients.map(c => c.sheetId));
  const clients = [...autoClients, ...profile.sheets.filter(s => !autoIds.has(s.sheetId))];
  return res.status(200).json({ ok: true, clients });
}

async function accountantRemoveClient(req, res) {
  const authz = await _authorizeAccountant(req, res);
  if (!authz) return;

  const sheetId = _query(req).get('sheetId') || '';
  if (!sheetId) return res.status(400).json({ error: 'invalid_request' });

  const autoClients = await _getAllClientsForAccountant(authz.me.email);
  if (autoClients.some(c => c.sheetId === sheetId)) {
    return res.status(403).json({ error: 'auto_client_cannot_be_removed' });
  }

  const key     = `acct:${authz.me.email}`;
  const profile = await kv.get(key).catch(() => null) || { sheets: [] };
  profile.sheets = profile.sheets.filter(s => s.sheetId !== sheetId);
  await kv.set(key, profile);

  const autoIds = new Set(autoClients.map(c => c.sheetId));
  const clients = [...autoClients, ...profile.sheets.filter(s => !autoIds.has(s.sheetId))];
  return res.status(200).json({ ok: true, clients });
}

async function accountantSummary(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const authz = await _authorizeAccountant(req, res);
  if (!authz) return;

  const q = _query(req);
  const monthsCount = Math.min(12, Math.max(1, parseInt(q.get('months') || '6', 10) || 6));
  const refresh = q.get('refresh') === '1';

  // 今月を含む過去 N ヶ月のリストを生成
  const now = new Date();
  const monthList = [];
  for (let i = monthsCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthList.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  // 全顧問先（自動連携 + 手動追加）
  const autoClients = await _getAllClientsForAccountant(authz.me.email, refresh);
  const manual = await kv.get(`acct:${authz.me.email}`).catch(() => null) || { sheets: [] };
  const autoIds = new Set(autoClients.map(c => c.sheetId));
  const allClients = [...autoClients, ...(manual.sheets || []).filter(s => !autoIds.has(s.sheetId))];

  const results = await Promise.allSettled(allClients.map(async client => {
    // 全経費を1回取得してキャッシュし、月別にフィルタリングする
    const allCacheKey = `acct:all:${client.sheetId}`;
    let all = !refresh ? await kv.get(allCacheKey).catch(() => null) : null;
    if (!all) {
      all = await readExpensesViaSA(client.sheetId);
      await kv.set(allCacheKey, all, { ex: 300 }).catch(() => {});
    }

    const byMonth = {};
    for (const month of monthList) {
      const expenses = all.filter(e => e.date && String(e.date).startsWith(month));
      const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);
      const byCategory = {};
      expenses.forEach(e => { if (e.category) byCategory[e.category] = (byCategory[e.category] || 0) + (e.amount || 0); });
      const signedExpenses = expenses.map(e =>
        e.imageLinks ? { ...e, imageLinks: _signImageLinks(e.imageLinks) } : e
      );
      byMonth[month] = { total, count: expenses.length, byCategory, expenses: signedExpenses };
    }

    return { sheetId: client.sheetId, name: client.name, byMonth };
  }));

  const summaries = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { sheetId: allClients[i].sheetId, name: allClients[i].name, error: true, message: r.reason?.message || 'データ取得失敗' }
  );

  return res.status(200).json({ months: monthList, summaries });
}

/* ───────────────────────── SA データアクセス ───────────────────────── */

/** マスタ表 A2:H を SA で読み、クライアントの readMaster と同一形のオブジェクトを返す。
 *  A:氏名 B:メール C:所属 D:権限 E:備考 F:会社払い支払元 G:勘定科目 H:カスタムフラグ */
/** マスタ表をキャッシュ付きで読む。
 *  1st: in-processキャッシュ（ウォームインスタンス内、ネットワーク往復なし）
 *  2nd: Vercel KV（別インスタンスとの共有、~20-50ms）
 *  3rd: Sheets API（フォールバック、~200ms）
 *  アプリ経由のマスタ書き込み（mastersWrite）は両キャッシュを即削除するため遅延なし。 */
/**
 * シートのライセンスオーナーメール（小文字）を返す。
 * 設定B3 → license:{key}.email の順で解決し、in-proc(55s)+KV(60s)キャッシュで往復を抑える。
 * 解決できない場合は空文字を返す（失敗は auth 拒否ではなく admin 昇格スキップ）。
 */
async function resolveOwnerEmail(sheetId) {
  const cacheKey = `acct:owner:${sheetId}`;
  const inProc = _inProcGet(cacheKey);
  if (inProc !== null) return inProc; // '' も有効キャッシュとして扱う

  const fromKv = await kv.get(cacheKey).catch(() => undefined);
  if (fromKv !== undefined && fromKv !== null) {
    _inProcSet(cacheKey, fromKv, 55_000);
    return fromKv;
  }

  // settings キャッシュから B3（ライセンスキー）を取得
  const settKey = `cfg:settings:${sheetId}`;
  let licKey = (_inProcGet(settKey) || await kv.get(settKey).catch(() => null))?.settings?.B3 || '';
  if (!licKey) {
    // KV未キャッシュ時は SA でシートを直読み（設定エンドポイントと同様）
    try {
      const sheets = sheetsClient();
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: '設定!B3' });
      licKey = r.data.values?.[0]?.[0] || '';
    } catch (_) {}
  }

  const ownerEmail = licKey
    ? ((await kv.get(`license:${licKey}`).catch(() => null))?.email || '').toLowerCase()
    : '';

  _inProcSet(cacheKey, ownerEmail, 55_000);
  kv.set(cacheKey, ownerEmail, { ex: 60 }).catch(() => {});
  return ownerEmail;
}

async function readMasterCached(sheetId) {
  const key = `acct:master:${sheetId}`;
  // 1st: in-process
  const inProc = _inProcGet(key);
  if (inProc?.members) return inProc;
  // 2nd: KV
  const fromKv = await kv.get(key).catch(() => null);
  if (fromKv?.members) { _inProcSet(key, fromKv, 55_000); return fromKv; }
  // 3rd: Sheets
  const master = await readMaster(sheetId);
  _inProcSet(key, master, 55_000);
  kv.set(key, master, { ex: 60 }).catch(() => {}); // fire-and-forget
  return master;
}

async function readMaster(sheetId) {
  const sheets = sheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId, range: 'マスタ表!A2:H',
  });
  const rows = resp.data.values || [];
  const members = [], categories = [], paySources = [], customFlags = [], admins = [], viewers = [];
  rows.forEach(r => {
    const email = (r[1] || '').toLowerCase();
    if (r[0] || r[1]) members.push({ name: r[0] || '', email, dept: r[2] || '', role: r[3] || '' });
    if (r[5]) paySources.push(r[5]);
    if (r[6]) categories.push(r[6]);
    if (r[7]) customFlags.push(r[7]);
    const role = (r[3] || '').toLowerCase();
    if (role === 'admin'  && email) admins.push(email);
    if (role === 'viewer' && email) viewers.push(email);
  });
  return {
    members,
    categories:  [...new Set(categories)],
    paySources:  [...new Set(paySources)],
    customFlags: [...new Set(customFlags)],
    admins,
    viewers,
  };
}

/** 経費一覧のヘッダー直下（2行目）に1行挿入して書き込み、書式を整える（SA経由）。
 *  クライアント sheets.js の prependExpense + formatExpenseRow と等価。 */
async function prependExpenseRowViaSA(sheetId, row) {
  const sheets = sheetsClient();
  const gid = await _sheetGid(sheets, sheetId, '経費一覧');
  if (gid === null) throw new Error('経費一覧シートが見つかりません');

  // ヘッダー行(index 0)の直下に書式非継承の空行を挿入
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{
      insertDimension: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
        inheritFromBefore: false,
      },
    }] },
  });

  // 挿入行に値を書き込み（=HYPERLINK 等を活かすため USER_ENTERED）
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: '経費一覧!A2:U2',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });

  // 書式：行全体リセット + 金額列(F,N)カンマ右寄せ + 日付列(A日時,D日付)
  const rowRange = { sheetId: gid, startRowIndex: 1, endRowIndex: 2 };
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [
      { repeatCell: { range: rowRange, cell: { userEnteredFormat: {} }, fields: 'userEnteredFormat' } },
      ...[5, 13].map(col => ({
        repeatCell: {
          range: { ...rowRange, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' }, horizontalAlignment: 'RIGHT' } },
          fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
        },
      })),
      ...[{ col: 0, pattern: 'yyyy-mm-dd hh:mm:ss' }, { col: 3, pattern: 'yyyy-mm-dd' }].map(({ col, pattern }) => ({
        repeatCell: {
          range: { ...rowRange, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern } } },
          fields: 'userEnteredFormat(numberFormat)',
        },
      })),
    ] },
  });
}

/** シート名 → 数値 sheetId（gid）。見つからなければ null。 */
async function _sheetGid(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
  const s = (meta.data.sheets || []).find(x => x.properties.title === title);
  return s ? s.properties.sheetId : null;
}

/** UUID(Q列)で経費行を検索。{ rowNum(1始まり), raw(値配列) } または null。 */
async function _getExpenseByIdViaSA(sheetId, id) {
  const sheets = sheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId, range: '経費一覧!A2:U',
  });
  const rows = resp.data.values || [];
  const idx = rows.findIndex(r => (r[16] || '') === id);
  if (idx === -1) return null;
  return { rowNum: idx + 2, raw: rows[idx] };
}

/** 複数 UUID → 行番号(1始まり)配列（見つかったものだけ）。 */
async function _rowNumsByIds(sheetId, ids) {
  const sheets = sheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId, range: '経費一覧!Q2:Q',
  });
  const col = resp.data.values || [];
  const idSet = new Set(ids);
  const nums = [];
  col.forEach((r, i) => { if (idSet.has(r[0])) nums.push(i + 2); });
  return nums;
}

/**
 * 修正履歴シートに変更前/変更後を2行セットで書き込む。
 * 変更されたセルだけ色付き（変更前=ピンク、変更後=薄緑）。
 */
async function _writeEditHistory(sheetId, timestamp, editor, oldRow, newRow) {
  const sheets = sheetsClient();
  const gid = await _sheetGid(sheets, sheetId, '修正履歴');
  if (gid === null) throw new Error('修正履歴シートが見つかりません');

  const old21 = oldRow.slice(0, 21); while (old21.length < 21) old21.push('');
  const new21 = newRow.slice(0, 21); while (new21.length < 21) new21.push('');

  // 2行挿入
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ insertDimension: {
      range: { sheetId: gid, dimension: 'ROWS', startIndex: 1, endIndex: 3 },
      inheritFromBefore: false,
    } }] },
  });

  // データ書き込み（prefix3列 + 経費一覧21列 = 24列）
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: '修正履歴!A2:X3',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [
      [timestamp, editor, '変更前', ...old21],
      [timestamp, editor, '変更後', ...new21],
    ] },
  });

  // 変更されたセル列を特定（経費一覧インデックス → 修正履歴列インデックス = +3）
  // Sheets API は TRUE/FALSE を文字列で返すが、クライアントは boolean で送るため正規化して比較
  const _norm = v => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return String(v);
    const s = String(v).trim();
    if (s.toUpperCase() === 'TRUE') return 'true';
    if (s.toUpperCase() === 'FALSE') return 'false';
    // カンマ区切り数値を正規化（例: "30,576" → "30576"）
    const num = Number(s.replace(/,/g, ''));
    if (s !== '' && !isNaN(num)) return String(num);
    return s;
  };
  const changedCols = [];
  for (let i = 0; i < 21; i++) {
    if (_norm(old21[i]) !== _norm(new21[i])) changedCols.push(i + 3);
  }
  if (changedCols.length === 0) return;

  // 色付きリクエスト：変更前=ピンク(row 1)、変更後=薄緑(row 2)
  const colorRequests = [];
  changedCols.forEach(col => {
    colorRequests.push({ repeatCell: {
      range: { sheetId: gid, startRowIndex: 1, endRowIndex: 2, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { backgroundColor: { red: 1.0, green: 0.84, blue: 0.84 } } },
      fields: 'userEnteredFormat.backgroundColor',
    } });
    colorRequests.push({ repeatCell: {
      range: { sheetId: gid, startRowIndex: 2, endRowIndex: 3, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { backgroundColor: { red: 0.84, green: 1.0, blue: 0.84 } } },
      fields: 'userEnteredFormat.backgroundColor',
    } });
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: colorRequests },
  });
}

/** 指定シートのヘッダー直下(2行目)に1行挿入して書き込む（SA経由・書式非継承）。 */
async function prependRowViaSA(sheetId, sheetName, values) {
  const sheets = sheetsClient();
  const gid = await _sheetGid(sheets, sheetId, sheetName);
  if (gid === null) throw new Error(`${sheetName}シートが見つかりません`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{
      insertDimension: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
        inheritFromBefore: false,
      },
    }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${sheetName}!A2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

/** 範囲を上書き（SA経由）。 */
async function updateRangeViaSA(sheetId, range, values) {
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId, range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

/** 複数範囲を一括上書き（SA経由）。 */
async function batchUpdateValuesViaSA(sheetId, data) {
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

/** 行(1始まり)を削除（SA経由）。 */
async function deleteRowViaSA(sheetId, sheetName, rowNum) {
  const sheets = sheetsClient();
  const gid = await _sheetGid(sheets, sheetId, sheetName);
  if (gid === null) throw new Error(`${sheetName}シートが見つかりません`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{
      deleteDimension: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
      },
    }] },
  });
}

/** 経費一覧 A2:U を SA で読み、経費オブジェクト配列に変換する（クライアントの readExpenses と整合）。
 *  spreadsheets.get + hyperlink フィールドで I列のハイパーリンクURLも取得する。 */
async function readExpensesViaSA(sheetId) {
  const sheets = sheetsClient();
  const resp = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    ranges: ['経費一覧!A2:U'],
    fields: 'sheets.data.rowData.values(effectiveValue,hyperlink)',
  });
  const rowDataList = resp.data.sheets?.[0]?.data?.[0]?.rowData || [];
  return rowDataList.map(rd => {
    const cells = rd.values || [];
    const row = cells.map((cell, i) => {
      if (i === 8 && cell?.hyperlink) return cell.hyperlink; // I列：証票リンク
      const ev = cell?.effectiveValue;
      if (!ev) return '';
      if ('boolValue'   in ev) return ev.boolValue;
      if ('numberValue' in ev) return ev.numberValue;
      if ('stringValue' in ev) return ev.stringValue;
      return '';
    });
    return rowToExpense(row);
  }).filter(e => e.id);
}

/** 行配列 → 経費オブジェクト（クライアント sheets.js の _rowToExpense と同一マッピング）。 */
function rowToExpense(row) {
  return {
    appliedAt:      row[0]  || '',
    name:           row[1]  || '',
    type:           row[2]  || '',
    date:           parseSheetDate(row[3]),
    place:          row[4]  || '',
    amount:         Number(row[5]) || 0,
    category:       row[6]  || '',
    note:           row[7]  || '',
    imageLinks:     extractUrl(row[8] || ''),
    confirmed:      row[9]  === true || row[9] === 'TRUE',
    aiAudit:        row[10] || '',
    settlementDate: parseSheetDate(row[11]),  // シリアル値なら YYYY-MM-DD、会社払い等の文字列はそのまま
    invoice:        row[12] || '',
    aiAmount:       Number(row[13]) || 0,
    imageHash:      row[14] || '',
    email:          row[15] || '',
    id:             row[16] || '',
    device:         row[17] || '',
    taxRate:        row[18] || '',
    withholding:    Number(row[19]) || 0,
    customFlag:     row[20] || '',
  };
}

function extractUrl(val) {
  if (!val) return '';
  const s = String(val);
  const m = s.match(/^=HYPERLINK\(["']([^"']+)["']/i);
  return m ? m[1] : s;
}

function parseSheetDate(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') {
    const d = new Date(Math.round((val - 25569) * 86400000));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return String(val);
}

/* ───────────────────────── ユーティリティ ───────────────────────── */

function _query(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

/** URL のパスセグメント配列（例: /api/data/expenses/approve → ['api','data','expenses','approve']）。 */
function _pathSegs(req) {
  const p = req.url ? req.url.split('?')[0] : '';
  return p.split('/').filter(Boolean);
}

function _validSheetId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{20,}$/.test(id);
}

/** クライアント /api/time の jst と同形式のサーバー時刻文字列。 */
function _nowJst() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

/* ── 経費の状態判定・編集可否（クライアント list.js と同一ルール） ── */
function _statusOf(raw) {
  const settlement = raw[11];                       // L列：精算日
  if (settlement != null && String(settlement).trim() !== '') return '精算済';
  if (raw[9] === true || raw[9] === 'TRUE') return '登録済';  // J列：承認
  return '申請済';
}

/** 実精算（会社払いマーカーでない精算日）か。電帳法上の削除禁止判定に使う。 */
function _isRealSettled(raw) {
  const s = String(raw[11] ?? '').trim();
  return s !== '' && !s.startsWith('会社払い');
}

/** 編集・削除を許可するか：admin、または「申請済かつ本人」。 */
function _canModify(me, isAdmin, raw) {
  if (isAdmin) return true;
  return _statusOf(raw) === '申請済' && String(raw[15] || '').toLowerCase() === me.email;
}

/**
 * リクエストの生ボディ(Buffer)を1度だけ読み、req にキャッシュして返す。
 * bodyParser を無効化しているため、全ボディはここを通る。
 * ストリームは1度しか読めないので、複数ハンドラ/署名検証+JSON化の両方に耐えるよう
 * req._rawBody にキャッシュする。上限は12MB相当（レシートBase64のため）。
 */
async function _readRaw(req) {
  if (req._rawBody !== undefined) return req._rawBody;
  const MAX = 12 * 1024 * 1024;
  const chunks = [];
  let size = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX) { req._rawBody = null; return null; } // 過大なボディは拒否
      chunks.push(c);
    }
    req._rawBody = Buffer.concat(chunks);
  } catch (_) {
    req._rawBody = null;
  }
  return req._rawBody;
}

/** リクエストボディを JSON として取得する（bodyParser無効・生ボディから手動パース）。 */
async function _body(req) {
  // Vercel が何らかの理由で既にパース済みの場合はそれを尊重（保険）
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return null; } }
  const raw = await _readRaw(req);
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString('utf8') || '{}');
  } catch (_) { return null; }
}

// ── チャットサポート ──────────────────────────────────────────────
async function chat(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { message, history = [] } = (await _body(req)) || {};
  if (!message || typeof message !== 'string' || message.length > 500)
    return res.status(400).json({ error: 'invalid_message' });

  // IPベースのレート制限: 1時間に20回まで
  const rl = await rateLimit(req, { prefix: 'chat', limit: 20, window: 3600 });
  if (!rl.ok) return res.status(429).json({ error: 'rate_limited', message: '利用制限に達しました。1時間後に再試行してください。' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'not_configured' });

  const systemPrompt = `あなたは「経費ログ」というWebアプリのサポートAIです。
以下のFAQ内容だけを根拠として、日本語で簡潔に回答してください。
FAQに答えがない場合は「FAQに該当する情報がありません。support@keihi-log.com までお問い合わせください。」と答えてください。
HTMLタグや長い箇条書きは使わず、2〜4文で端的に答えてください。
関連するFAQがある場合は回答末尾に「詳細: /faq#qXXX」の形式で1件だけ示してください。

--- FAQ ---
${FAQ_TEXT}`;

  // 会話履歴（最大5往復）
  const messages = [
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Anthropic API error:', err);
    return res.status(502).json({ error: 'upstream_error' });
  }

  const data = await resp.json();
  const reply = data.content?.[0]?.text || '';
  return res.status(200).json({ reply });
}

function _uuid() {
  try { return crypto.randomUUID(); } catch (_) {}
  // フォールバック（古いランタイム用）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/* ═══════════════════════════ LINE 連携 ═══════════════════════════
 *
 * LINE公式アカウントに領収書画像を送ると送信者の経費ログに登録される。
 * 設計: docs/line-integration-design.md
 *
 * 方針:
 *   - 全応答は Reply API のみ（Push/Multicast等は使わない＝無料枠を消費しない）
 *   - チームプラン限定（連携コード発行時＋Webhook受信時に都度検証）
 *   - LINEの用途は「①画像送信 ②登録前の確認/修正/やめる ③未精算一覧の閲覧」に限定
 *   - 承認・精算・削除・編集はWeb側のみ
 *
 * エンドポイント（このキャッチオール内）:
 *   POST /api/data/linewebhook   LINE署名検証（生ボディ必須。bodyParser無効化済み）
 *   POST /api/data/linecode      連携コード発行（admin・設定タブから）
 *   POST /api/data/lineunlink    連携解除（admin・メンバー削除連動）
 *   ※ このVercel構成ではキャッチオール関数に2階層パス（/api/data/line/*）が届かないため、
 *     動作実績のある1階層リソース名（linewebhook / linecode / lineunlink）で登録している。
 */

const LINE_API      = 'https://api.line.me/v2/bot';
const LINE_API_DATA = 'https://api-data.line.me/v2/bot';

function _lineEnabled() { return process.env.LINE_ENABLED === '1'; }
function _lineToken()   { return process.env.LINE_CHANNEL_ACCESS_TOKEN || ''; }
function _lineSecret()  { return process.env.LINE_CHANNEL_SECRET || ''; }

/** メールを持たないLINE専用メンバーの合成ID（生userIdはシートに書かない）。 */
function _lineSynthId(userId) {
  return 'line:' + crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12);
}

/* ── 署名検証・Reply API・コンテンツ取得 ── */

/** x-line-signature を CHANNEL_SECRET でHMAC-SHA256検証（生ボディ必須）。 */
function _verifyLineSignature(rawBuf, signature) {
  const secret = _lineSecret();
  if (!secret || !signature || !rawBuf) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBuf).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Reply API（無料・通数カウント外）。失敗しても致命でないため握りつぶしてログのみ。 */
async function _lineReply(replyToken, messages) {
  if (!replyToken || !_lineToken()) return;
  try {
    const resp = await fetch(`${LINE_API}/message/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_lineToken()}` },
      body: JSON.stringify({ replyToken, messages: Array.isArray(messages) ? messages : [messages] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) console.error('line reply failed:', resp.status, await resp.text().catch(() => ''));
  } catch (e) {
    console.error('line reply error:', e?.message || e);
  }
}

/** テキスト＋クイックリプライ（postbackアクション）を1メッセージに組む。 */
function _lineText(text, quickItems) {
  const msg = { type: 'text', text: String(text).slice(0, 4900) };
  if (quickItems && quickItems.length) {
    msg.quickReply = { items: quickItems.slice(0, 13) };
  }
  return msg;
}
function _qpPostback(label, data) {
  return { type: 'action', action: { type: 'postback', label: String(label).slice(0, 20), data, displayText: label } };
}
function _qpMessage(label, text) {
  return { type: 'action', action: { type: 'message', label: String(label).slice(0, 20), text } };
}

/** 登録前の確認ボタン群（登録する/修正する/やめる）。 */
function _confirmQuick() {
  return [
    _qpPostback('登録する', 'action=register'),
    _qpPostback('修正する', 'action=edit'),
    _qpPostback('やめる',   'action=cancel'),
  ];
}

/**
 * 登録前の確認メッセージ（Flex）。クイックリプライだと小さく目立たないため、
 * メッセージ内に大きめの色付きボタン（登録する=緑/修正する/やめる）を出す。
 */
function _lineConfirmMessage(summaryText) {
  return {
    type: 'flex',
    altText: '内容を確認して登録してください',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg',
        contents: [{ type: 'text', text: String(summaryText), wrap: true, size: 'sm', color: '#333333' }],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
        contents: [
          { type: 'button', style: 'primary', color: '#17a55b', height: 'md',
            action: { type: 'postback', label: '✅ 登録する', data: 'action=register', displayText: '登録する' } },
          { type: 'button', style: 'primary', color: '#0d6efd', height: 'md',
            action: { type: 'postback', label: '✏️ 修正する', data: 'action=edit', displayText: '修正する' } },
          { type: 'button', style: 'link', height: 'sm', color: '#999999',
            action: { type: 'postback', label: 'やめる', data: 'action=cancel', displayText: 'やめる' } },
        ],
      },
    },
  };
}

/**
 * 登録先の経費ログ選択メッセージ（Flex）。クイックリプライは小さく目立たないため、
 * メッセージ内に大きめの色付きボタンを組織ごとに出す（複数経費ログ連携時）。
 * choices: [{ sheetId, label }]
 */
function _lineOrgPickerMessage(choices) {
  const palette = ['#17a55b', '#0d6efd', '#8a4bd6', '#e0781a', '#0da5a5', '#c0392b'];
  const buttons = choices.slice(0, 10).map((o, i) => ({
    type: 'button', style: 'primary', color: palette[i % palette.length], height: 'md',
    action: {
      type: 'postback',
      label: String(o.label).slice(0, 20),
      data: `action=pickorg&s=${encodeURIComponent(o.sheetId)}`,
      displayText: o.label,
    },
  }));
  return {
    type: 'flex',
    altText: 'どの経費ログに登録しますか？',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg',
        contents: [{ type: 'text', text: 'どの経費ログに登録しますか？', wrap: true, weight: 'bold', size: 'md', color: '#333333' }],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
        contents: buttons,
      },
    },
  };
}

/** LINEコンテンツAPIで画像バイト列を取得。 */
async function _lineFetchContent(messageId) {
  const resp = await fetch(`${LINE_API_DATA}/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${_lineToken()}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`content fetch ${resp.status}`);
  const mime = resp.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await resp.arrayBuffer());
  return { buf, mime };
}

/* ── Webhook 本体 ── */

async function lineWebhook(req, res) {
  // キルスイッチ: OFFなら常に200を返す（no-op）
  if (!_lineEnabled()) return res.status(200).json({ ok: true, disabled: true });

  const raw = await _readRaw(req);
  const sig = req.headers['x-line-signature'] || req.headers['X-Line-Signature'] || '';
  if (!_verifyLineSignature(raw, sig)) {
    return res.status(401).json({ error: 'bad_signature' });
  }

  let payload;
  try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch (_) { payload = {}; }
  const events = Array.isArray(payload.events) ? payload.events : [];

  // リッチメニューが未設定なら自動設定（bot単位・1回のみ・管理者操作不要）
  await _ensureRichMenu().catch(() => {});

  // LINEはタイムアウト時に再送する。各イベントは冪等化しつつ順に処理し、必ず200で返す。
  for (const ev of events) {
    try { await _handleLineEvent(ev); }
    catch (e) { console.error('line event error:', e?.message || e); }
  }
  return res.status(200).json({ ok: true });
}

/** イベント1件を処理。冪等化（webhookEventId）→種別ごとに分岐。 */
async function _handleLineEvent(ev) {
  // 冪等化: 同一イベントの再送を1hブロック
  const eid = ev.webhookEventId;
  if (eid) {
    const fresh = await kv.set(`line:evt:${eid}`, '1', { nx: true, ex: 3600 }).catch(() => 'OK');
    if (fresh === null) return; // 既に処理済み
  }

  const userId = ev.source?.userId;
  const replyToken = ev.replyToken;

  if (ev.type === 'follow') {
    // 未連携は既定の「認証コードを入力」メニュー（折りたたみ＝入力欄が見える）のまま。
    // 既に連携済みのユーザーが再追加した場合だけ MAIN（4ボタン）へ割り当てる。
    if (userId) {
      const _l = await _lineLink(userId).catch(() => null);
      if (_l) _lineEnsureUserMenu(userId).catch(() => {});
    }
    return _lineReply(replyToken, _lineText(
      '経費ログbotへようこそ。\nまず、管理者から届いた6桁の認証コードを、この下の入力欄に入力して送信してください。\n連携後は、下のメニューや画像送信で経費を登録できます。'
    ));
  }

  if (!userId) return;

  // メニュー再生成（バージョンバンプ）後も、連携済みユーザーにはMAINメニューを確実に割当。
  // fire-and-forgetだとVercelが200返却後に凍結して割当POSTが完了しないため await する。
  await _lineEnsureUserMenu(userId).catch(() => {});

  if (ev.type === 'postback') {
    return _handleLinePostback(userId, replyToken, ev.postback?.data || '');
  }

  if (ev.type === 'message') {
    const m = ev.message || {};
    if (m.type === 'image') return _handleLineImage(userId, replyToken, m.id);
    // ファイル送信（PNG/JPEG/PDF等）も証票として受け付ける
    if (m.type === 'file')  return _handleLineImage(userId, replyToken, m.id);
    if (m.type === 'text')  return _handleLineText(userId, replyToken, String(m.text || '').trim());
    // その他（スタンプ・動画等）は案内のみ
    return _lineReply(replyToken, _lineText('領収書の画像またはPDFファイルを送ってください。'));
  }
}

/* ── リンク解決・プラン/メンバー検証 ── */

/**
 * userId → 紐付け配列 [{ sheetId, identity, name }]。
 * 保存形式は { links: [...] }。将来の複数経費ログ対応のため配列で持つ。
 * （旧・単一オブジェクト形式で保存された値も後方互換で配列化して返す）
 */
async function _lineLinks(userId) {
  const v = await kv.get(`line:link:${userId}`).catch(() => null);
  if (!v) return [];
  if (Array.isArray(v.links)) return v.links.filter(l => l && l.sheetId);
  if (v.sheetId) return [{ sheetId: v.sheetId, identity: v.identity, name: v.name || '' }]; // 旧形式
  return [];
}

/**
 * 写真登録・未精算照会などで使う「対象の紐付け」を1件解決する単一窓口。
 *
 * 現状は1対1（連携コード入力のたびに置換）なので links は最大1件 → その1件を返す。
 *
 * ── 将来: 1人が複数経費ログを併用する対応 ──
 *   links.length > 1 のユーザーは、画像受信時に送信先の組織を選ばせる想定
 *   （_handleLineImage の「複数経費ログ対応」TODO を参照）。
 *   その際は本関数を「アクティブな1件（選択中/直近）を返す」ロジックに拡張する。
 *   ここを単一窓口にしておくことで、呼び出し側（画像・登録・未精算）は変更不要にできる。
 */
async function _lineLink(userId) {
  const links = await _lineLinks(userId);
  return links[0] || null;
}

/**
 * 確認中の経費データ（pending）に紐づく「登録先の経費ログ」を解決する。
 * pending.sheetId が指す連携があればそれを、無ければ先頭を返す（旧pending後方互換）。
 */
async function _pendingLink(userId, pending) {
  const links = await _lineLinks(userId);
  if (pending?.sheetId) {
    const hit = links.find(l => l.sheetId === pending.sheetId);
    if (hit) return hit;
  }
  return links[0] || null;
}

/** 組織選択・見出し用の経費ログ表示名。設定B2会社名 → ライセンス社名 → シートID断片。 */
async function _lineOrgLabel(sheetId) {
  const settKey = `cfg:settings:${sheetId}`;
  const cached = (_inProcGet(settKey) || await kv.get(settKey).catch(() => null))?.settings || null;
  let name = cached?.B2 || '';
  let licKey = cached?.B3 || '';
  if (!name) {
    if (!licKey) {
      try {
        const sheets = sheetsClient();
        const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: '設定!B2:B3' });
        name = r.data.values?.[0]?.[0] || '';
        licKey = r.data.values?.[1]?.[0] || '';
      } catch (_) {}
    }
    if (!name && licKey) {
      name = (await kv.get(`license:${licKey}`).catch(() => null))?.company || '';
    }
  }
  name = String(name || '').trim() || `経費ログ(${String(sheetId).slice(0, 6)})`;
  return name.slice(0, 20); // クイックリプライのラベル上限
}

/**
 * sheetId からそのチームのWebアプリURL（keihi-log.com/{エイリアス}）を返す。
 * エイリアス未設定時はライセンスキー経由で逆引きし、それも無ければ /{sheetId} を返す
 * （キャッチオールが /{sheetId} を app に流すため、どちらでも開ける）。
 */
async function _lineTeamUrl(sheetId) {
  let code = await kv.get(`alias_by_sheet:${sheetId}`).catch(() => null);
  if (!code) {
    const settKey = `cfg:settings:${sheetId}`;
    const licKey = (_inProcGet(settKey) || await kv.get(settKey).catch(() => null))?.settings?.B3 || '';
    if (licKey) code = await kv.get(`license_alias:${licKey}`).catch(() => null);
  }
  return `https://keihi-log.com/${code || sheetId}`;
}

/** ライセンスのプラン情報を返す。{active, isTrial, plan}（license.js と同じ判定）。
 *  ライセンスが読めない/失効/停止の場合は active:false を返す（＝制限を掛けずアクセスは通すフェイルオープン）。 */
async function _readPlanInfo(sheetId) {
  // B3 ライセンスキーを取得（resolveOwnerEmail と同じ経路）
  const settKey = `cfg:settings:${sheetId}`;
  let licKey = (_inProcGet(settKey) || await kv.get(settKey).catch(() => null))?.settings?.B3 || '';
  if (!licKey) {
    try {
      const sheets = sheetsClient();
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: '設定!B3' });
      licKey = r.data.values?.[0]?.[0] || '';
    } catch (_) {}
  }
  if (!licKey) return { active: false, isTrial: false, plan: 'solo' };
  const data = await kv.get(`license:${licKey}`).catch(() => null);
  if (!data || data.suspended) return { active: false, isTrial: false, plan: 'solo' };
  if (data.expiresAt && new Date(data.expiresAt) < new Date()) return { active: false, isTrial: false, plan: 'solo' };
  const isTrial = data.trial === true ||
    (!('trial' in data) && data.stripeSessionId && data.createdAt && data.expiresAt &&
      (new Date(data.expiresAt) - new Date(data.createdAt)) / 86400000 <= 35);
  const plan = isTrial ? 'team' : (data.plan || 'solo');
  return { active: true, isTrial, plan };
}

/** チームプランかつ有効なライセンスか（license.js と同じ判定）。 */
async function _isTeamPlanActive(sheetId) {
  const { active, plan } = await _readPlanInfo(sheetId);
  return active && plan === 'team';
}

/** identity（メール or 合成ID）が現在もマスタ表のメンバーか再検証し、名前を返す。 */
async function _lineMemberName(sheetId, identity) {
  const master = await readMasterCached(sheetId).catch(() => null);
  if (!master?.members) return null;
  const idLower = String(identity).toLowerCase();
  const hit = master.members.find(m => String(m.email).toLowerCase() === idLower);
  return hit ? (hit.name || '') : null;
}

/** LINE専用の簡易レート制限（userId単位・KV）。ok:false で拒否。 */
async function _lineRateOk(userId, { limit = 8, window = 60 } = {}) {
  const key = `line:rl:${userId}`;
  try {
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, window);
    return n <= limit;
  } catch (_) { return true; } // KV障害時はフェイルオープン
}

/* ── テキスト受信（連携コード / 修正値入力 / 未精算キーワード） ── */

async function _handleLineText(userId, replyToken, text) {
  // 修正フロー: 値入力待ちなら最優先で処理
  const pending = await kv.get(`line:pending:${userId}`).catch(() => null);
  if (pending && pending.step === 'awaiting_value' && pending.editField) {
    return _applyLineEdit(userId, replyToken, pending, text);
  }
  // 電車代フロー: 出発駅・到着駅の入力待ち
  if (pending && (pending.step === 'transit_from' || pending.step === 'transit_to')) {
    return _handleLineTransitText(userId, replyToken, pending, text);
  }

  // 6桁数字 → 連携コード
  if (/^\d{6}$/.test(text)) {
    return _handleLineCode(userId, replyToken, text);
  }

  // 電車代キーワード
  if (/電車|でんしゃ|交通費/.test(text)) {
    return _beginLineTransit(userId, replyToken);
  }

  // 未精算キーワード
  if (/未精算|未清算|残/.test(text)) {
    return _handleLineUnsettled(userId, replyToken);
  }
  // 履歴キーワード
  if (/履歴|申請|一覧|確認/.test(text)) {
    return _handleLineHistory(userId, replyToken);
  }

  // 連携済みなら使い方案内、未連携なら連携案内
  const link = await _lineLink(userId);
  if (link) {
    return _lineReply(replyToken, _lineText(
      '領収書の画像を送ると経費を登録できます。\n「未精算」で未精算一覧、「履歴」で直近の申請を表示します。'
    ));
  }
  return _lineReply(replyToken, _lineText(
    '未連携です。管理者から受け取った6桁の連携コードを送信してください。'
  ));
}

/** 連携コードによる紐付け。総当たり対策として userId 単位の失敗回数を制限。 */
async function _handleLineCode(userId, replyToken, code) {
  // 失敗回数制限（1時間に10回まで）
  const failKey = `line:codefail:${userId}`;
  const fails = Number(await kv.get(failKey).catch(() => 0)) || 0;
  if (fails >= 10) {
    return _lineReply(replyToken, _lineText('試行回数が上限に達しました。しばらくしてからお試しください。'));
  }

  const info = await kv.get(`line:code:${code}`).catch(() => null);
  if (!info || !info.sheetId || !info.identity) {
    const n = await kv.incr(failKey).catch(() => 1);
    if (n === 1) await kv.expire(failKey, 3600).catch(() => {});
    return _lineReply(replyToken, _lineText('連携コードが無効か、期限切れです。管理者に再発行を依頼してください。'));
  }

  // コードは使い捨て。紐付けを作成し、逆引きセットにも登録。
  const newLink = { sheetId: info.sheetId, identity: info.identity, name: info.name || '' };

  // ── 紐付けの更新ルール（複数経費ログ対応） ──
  //   同じ経費ログの旧エントリは置換し、別の経費ログは追記する（1人=複数経費ログ可）。
  //   複数連携中のユーザーは画像送信時に登録先の組織を選ぶ（_handleLineImage 参照）。
  const prev = await _lineLinks(userId);
  const merged = [...prev.filter(l => l.sheetId !== newLink.sheetId), newLink];
  await kv.set(`line:link:${userId}`, { links: merged }).catch(() => {});
  await kv.sadd(`line:link_by_sheet:${info.sheetId}`, userId).catch(() => {});
  await kv.del(`line:code:${code}`).catch(() => {});
  await kv.del(failKey).catch(() => {});

  // 連携完了したので、このユーザーにだけリッチメニューを表示する
  await _lineEnsureUserMenu(userId).catch(() => {});

  const others = merged.filter(l => l.sheetId !== newLink.sheetId).length;
  const extra = others > 0
    ? `\n※あなたは複数の経費ログに連携中です。画像を送ると、どの経費ログに登録するか選べます。`
    : '';
  return _lineReply(replyToken, _lineText(
    `連携しました。「${info.name || 'メンバー'}」として登録されます。\n下のメニューまたは画像送信で経費を登録できます。${extra}`
  ));
}

/* ── 画像受信 → 解析 → 確認 ── */

async function _handleLineImage(userId, replyToken, messageId) {
  const links = await _lineLinks(userId);
  if (!links.length) {
    return _lineReply(replyToken, _lineText('未連携です。まず管理者から受け取った6桁の連携コードを送信してください。'));
  }
  _lineEnsureUserMenu(userId).catch(() => {}); // 連携済みならメニュー割当（既存ユーザー救済・冪等）

  // ── 複数経費ログ対応 ──
  //   2つ以上の経費ログに連携中のユーザーは、解析前に登録先の組織を選ばせる。
  //   messageId だけ pending(step:'awaiting_org') に退避し、
  //   postback(action=pickorg&s=sheetId) で選択後に _processLineImage を続行する。
  if (links.length > 1) {
    await kv.set(`line:pending:${userId}`, { step: 'awaiting_org', messageId }, { ex: 600 }).catch(() => {});
    const choices = await Promise.all(links.map(async l => ({
      sheetId: l.sheetId,
      label: await _lineOrgLabel(l.sheetId).catch(() => '経費ログ'),
    })));
    return _lineReply(replyToken, _lineOrgPickerMessage(choices));
  }

  return _processLineImage(userId, replyToken, messageId, links[0]);
}

/** 画像の解析→確認カード提示（送信先の経費ログ link は確定済み）。 */
async function _processLineImage(userId, replyToken, messageId, link) {
  const { sheetId, identity } = link;

  // プラン確認（チーム限定）
  if (!(await _isTeamPlanActive(sheetId))) {
    return _lineReply(replyToken, _lineText('LINE連携はチームプランでご利用いただけます。管理者にプランをご確認ください。'));
  }

  // メンバー再検証（キャッシュだけ信用しない）
  const name = await _lineMemberName(sheetId, identity);
  if (name === null) {
    return _lineReply(replyToken, _lineText('メンバー登録が見つかりません。管理者に連携し直しを依頼してください。'));
  }

  // レート制限
  if (!(await _lineRateOk(userId))) {
    return _lineReply(replyToken, _lineText('短時間に送信が集中しています。少し時間をおいてからお試しください。'));
  }

  try {
    // 画像取得 → ハッシュ
    const { buf, mime } = await _lineFetchContent(messageId);
    // 画像・PDFのみ受け付ける（ファイル送信で他形式が来た場合の案内）
    if (!/^image\//.test(mime) && mime !== 'application/pdf') {
      return _lineReply(replyToken, _lineText('領収書の画像（JPEG/PNG）またはPDFファイルを送ってください。'));
    }
    const imageHash = crypto.createHash('sha256').update(buf).digest('hex');

    // 証票をDriveへ保存（ベストエフォート）。
    // ⚠️ SAは自分のドライブ容量を持たないためMy Driveフォルダには新規ファイルを作成できない
    //    （Service Accounts do not have storage quota）。共有ドライブ or オーナートークンが必要。
    //    オーナートークンでの保存（設定で有効化・①）が未認可の間は、証票なしで登録を続行する。
    let imageLink = '', driveFileId = '', imageStored = false;
    try {
      const driveInfo = await _lineUploadReceipt(sheetId, buf, mime);
      imageLink = driveInfo.webViewLink || '';
      driveFileId = driveInfo.id || '';
      imageStored = true;
    } catch (upErr) {
      console.error('line receipt upload skipped (fallback):', upErr?.message || upErr);
    }

    // 勘定科目リスト取得 → Gemini解析（解析は画像バイト列を直接使うので保存可否に依存しない）
    const master = await readMasterCached(sheetId).catch(() => ({ categories: [] }));
    const categories = master.categories?.length ? master.categories : ['雑費'];
    const parsed = await _lineAnalyze(sheetId, buf, mime, categories);

    // 解析結果 → 経費データ
    const data = await _lineParsedToData(parsed, categories);
    data.imageLink = imageLink;
    if (!imageStored) {
      data.note = [data.note, '※証票画像は未保存（LINE証票保存の有効化が必要）'].filter(Boolean).join('\n');
    }

    // 監査チェック（既存経費と突合）
    const expenses = await readExpensesViaSA(sheetId).catch(() => []);
    const alerts = _serverAuditChecks(expenses, data, [imageHash]);

    // pending 保存（TTL10分）。sheetId/identity を保持し、修正・登録・再監査が
    // 選択済みの経費ログを対象にする（複数連携ユーザーで links[0] に流れないよう固定）。
    await kv.set(`line:pending:${userId}`, {
      data, imageHash, driveFileId, imageLink, imageStored,
      alerts, aiAmount: data.aiAmount, step: 'confirm',
      sheetId, identity,
    }, { ex: 600 }).catch(() => {});

    return _lineReply(replyToken, _lineConfirmMessage(
      _lineSummary(data, alerts) + (imageStored ? '' : '\n（証票画像は現在保存されません）')
    ));
  } catch (e) {
    const emsg = String(e?.message || e);
    console.error('line image error:', emsg);
    // 失敗理由を管理者が特定しやすいよう、原因別に案内を出し分ける
    let hint = '画像の解析に失敗しました。もう一度、明るくはっきりした画像でお送りください。';
    if (/Gemini|gemini/.test(emsg)) {
      hint = 'AI解析に失敗しました。経費ログの設定で「Gemini APIキー」が未設定か無効の可能性があります。管理者にご確認ください。';
    } else if (/証票フォルダ|folder/.test(emsg)) {
      hint = '証票の保存に失敗しました。証票フォルダの設定・共有（サービスアカウント）をご確認ください。管理者にご相談ください。';
    } else if (/content fetch/.test(emsg)) {
      hint = '画像の取得に失敗しました。少し時間をおいてもう一度送ってみてください。';
    }
    return _lineReply(replyToken, _lineText(hint));
  }
}

const SA_EMAIL = 'keihi-log-proxy@keihi-log.iam.gserviceaccount.com';

/* ── オーナートークンの保管（AES-256-GCM・鍵はGOOGLE_SA_KEYから導出） ── */
function _tokenSecretKey() {
  return crypto.createHash('sha256').update('linedrive:' + (process.env.GOOGLE_SA_KEY || '')).digest();
}
function _encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _tokenSecretKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function _decryptToken(b64) {
  const raw = Buffer.from(b64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', _tokenSecretKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * オーナーのリフレッシュトークン（KV保管）から有効なアクセストークンを得る。
 * 未設定・失効時は null。アクセストークンは in-proc に50分キャッシュ。
 */
async function _ownerAccessToken(sheetId) {
  const cacheKey = `linedrive:at:${sheetId}`;
  const cached = _inProcGet(cacheKey);
  if (cached) return cached;
  const stored = await kv.get(`line:drivetoken:${sheetId}`).catch(() => null);
  if (!stored?.enc) return null;
  let refresh;
  try { refresh = _decryptToken(stored.enc); } catch (_) { return null; }
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: refresh,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
      console.error('owner token refresh failed:', data.error || resp.status);
      return null;
    }
    _inProcSet(cacheKey, data.access_token, 50 * 60 * 1000);
    return data.access_token;
  } catch (e) {
    console.error('owner token refresh error:', e?.message || e);
    return null;
  }
}

/**
 * 証票フォルダ(設定B4)へ画像を保存する。
 * SAは容量が無くMy Driveに新規ファイルを作れないため、オーナーのトークンでアップロードし
 * （＝オーナーが所有・オーナーの容量を使用）、SAには閲覧権限を付与する（Web版と同じ）。
 * オーナートークン未設定時は 'no_owner_token' を投げ、呼び出し側が証票なしで続行する。
 */
async function _lineUploadReceipt(sheetId, buf, mime) {
  const accessToken = await _ownerAccessToken(sheetId);
  if (!accessToken) { const e = new Error('no_owner_token'); e.code = 'no_owner_token'; throw e; }

  const sheets = sheetsClient();
  const cfg = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: '設定!B4' });
  const folderId = cfg.data.values?.[0]?.[0] || '';
  if (!folderId) throw new Error('証票フォルダ(設定B4)未設定');

  const ext = mime.includes('png') ? 'png' : mime.includes('pdf') ? 'pdf' : 'jpg';
  const meta = JSON.stringify({ name: `LINE_${Date.now()}.${ext}`, mimeType: mime, parents: [folderId] });
  const boundary = '----keihiLine' + crypto.randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const data = await up.json().catch(() => ({}));
  if (!up.ok || !data.id) throw new Error('drive upload ' + up.status + ' ' + (data.error?.message || ''));

  // SA に閲覧権限を付与（プロキシ経由での証票閲覧を可能にする。Web版 uploadFile と同じ）
  await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: SA_EMAIL }),
  }).catch(() => {});

  return { id: data.id, webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view` };
}

/**
 * POST /api/data/linedrivetoken   オーナーのリフレッシュトークンを保存（LINE証票保存を有効化）
 * GET  /api/data/linedrivetoken   有効/無効の状態を返す
 * DELETE /api/data/linedrivetoken 無効化（トークン削除）
 * ※ 保存できるのはオーナー本人（ライセンス購入メール＝ログインメール）のみ。
 */
async function lineDriveToken(req, res) {
  const authz = await _authorize(req, res);
  if (!authz) return;
  const key = `line:drivetoken:${authz.sheetId}`;

  if (req.method === 'GET') {
    const stored = await kv.get(key).catch(() => null);
    return res.status(200).json({
      enabled: !!stored?.enc,
      ownerEmail: authz.ownerEmail || '',
      byEmail: stored?.email || '',
      isOwner: !!authz.ownerEmail && authz.me.email === authz.ownerEmail,
    });
  }

  if (!authz.isAdmin) return res.status(403).json({ error: 'admin_only' });

  if (req.method === 'DELETE') {
    await kv.del(key).catch(() => {});
    _inProcDel(`linedrive:at:${authz.sheetId}`);
    return res.status(200).json({ ok: true, enabled: false });
  }

  if (req.method === 'POST') {
    // オーナー本人のみ（トークンの持ち主＝証票フォルダの所有者である必要があるため）
    if (!authz.ownerEmail || authz.me.email !== authz.ownerEmail) {
      return res.status(403).json({ error: 'owner_only', message: 'オーナー（ライセンス購入者）のGoogleアカウントで有効化してください' });
    }
    const body = (await _body(req)) || {};
    const refreshToken = String(body.refreshToken || '').trim();
    if (!refreshToken) return res.status(400).json({ error: 'no_refresh_token', message: 'リフレッシュトークンがありません。一度サインアウトして再度ログインしてからお試しください。' });

    await kv.set(key, { enc: _encryptToken(refreshToken), email: authz.me.email, at: _nowJst() }).catch(() => {});
    _inProcDel(`linedrive:at:${authz.sheetId}`);
    // 動作確認: すぐアクセストークンを取得できるか
    const ok = !!(await _ownerAccessToken(authz.sheetId));
    return res.status(200).json({ ok: true, enabled: true, verified: ok });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}

/**
 * GET /api/data/linelinks   このシートで現在LINE連携済みの identity 一覧を返す（admin）。
 *   クライアントのメンバー表示（接続済み判定）に使う。
 */
async function lineLinks(req, res) {
  const authz = await _authorize(req, res);
  if (!authz) return;
  if (!authz.isAdmin) return res.status(403).json({ error: 'admin_only' });
  const ids = await kv.smembers(`line:link_by_sheet:${authz.sheetId}`).catch(() => []);
  const identities = [];
  for (const uid of (ids || [])) {
    const links = await _lineLinks(uid);
    for (const l of links) {
      if (l.sheetId === authz.sheetId && l.identity) identities.push(String(l.identity).toLowerCase());
    }
  }
  return res.status(200).json({ identities: [...new Set(identities)] });
}

/**
 * POST   /api/data/linerichmenu   リッチメニューを作成＋画像アップロード＋全ユーザー既定に設定
 * GET    /api/data/linerichmenu   既定リッチメニューの有無
 * DELETE /api/data/linerichmenu   既定解除＋全リッチメニュー削除
 * ※ 管理者のみ。LINE_CHANNEL_ACCESS_TOKEN を使用（無料操作・通数カウント外）。
 */
// リッチメニューの画像/レイアウト/挙動を変えたら上げる（自動で再設定＆再割当される）
const RICHMENU_VERSION = 'v16';
let _richmenuEnsured = false; // ウォームインスタンス内キャッシュ

/** 1つのリッチメニューを作成＋画像アップロードし richMenuId を返す（失敗で null）。 */
async function _createRichMenu(H, def, pngB64) {
  const createResp = await fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(def),
  });
  const created = await createResp.json().catch(() => ({}));
  if (!createResp.ok || !created.richMenuId) { console.error('richmenu create failed:', created.message || createResp.status); return null; }
  const upResp = await fetch(`https://api-data.line.me/v2/bot/richmenu/${created.richMenuId}/content`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'image/png' }, body: Buffer.from(pngB64, 'base64'),
  });
  if (!upResp.ok) { console.error('richmenu upload failed:', upResp.status); return null; }
  return created.richMenuId;
}

/**
 * 2種類のメニューを作成する。
 *   LINK（未連携・既定）: 認証コード入力の案内。selected:false で折りたたみ＝入力欄が見える。
 *   MAIN（連携済み・per-user）: 4ボタン（領収書を送る/過去の申請/未精算/電車代）。selected:true で展開。
 * LINK を全ユーザー既定に設定し、MAIN は連携時に per-user 割当する。
 */
async function _setupRichMenuViaApi() {
  const token = _lineToken();
  if (!token) return false;
  const H = { Authorization: `Bearer ${token}` };
  // 既存の既定解除＋全メニュー削除（重複防止・旧バージョンの掃除）
  await fetch('https://api.line.me/v2/bot/user/all/richmenu', { method: 'DELETE', headers: H }).catch(() => {});
  try {
    const list = await (await fetch('https://api.line.me/v2/bot/richmenu/list', { headers: H })).json();
    for (const m of (list.richmenus || [])) {
      await fetch(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE', headers: H }).catch(() => {});
    }
  } catch (_) {}

  // 連携済み用（4ボタン・展開）
  const mainId = await _createRichMenu(H, {
    size: { width: 2500, height: 843 }, selected: true, name: 'keihi-log-main', chatBarText: 'メニュー',
    areas: [
      // 左＝電車代（全高）、中＝領収書（全高）、右列を上下2分割（上＝過去の申請／下＝未精算）
      { bounds: { x: 0,    y: 0,   width: 833, height: 843 }, action: { type: 'postback', data: 'action=transit',     displayText: '電車代' } },
      { bounds: { x: 833,  y: 0,   width: 834, height: 843 }, action: { type: 'postback', data: 'action=sendreceipt', displayText: '領収書を送る' } },
      { bounds: { x: 1667, y: 0,   width: 833, height: 421 }, action: { type: 'postback', data: 'action=history',     displayText: '過去の申請' } },
      { bounds: { x: 1667, y: 421, width: 833, height: 422 }, action: { type: 'postback', data: 'action=unsettled',   displayText: '未精算' } },
    ],
  }, RICHMENU_PNG_BASE64);
  if (!mainId) return false;

  // 未連携用（認証コード入力案内・折りたたみで入力欄を見せる）
  const linkId = await _createRichMenu(H, {
    size: { width: 2500, height: 843 }, selected: false, name: 'keihi-log-link', chatBarText: '認証コードを入力',
    areas: [
      { bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: 'postback', data: 'action=entercode', displayText: '認証コードを入力' } },
    ],
  }, RICHMENU_LINK_PNG_BASE64);
  if (!linkId) return false;

  await kv.set('line:richmenuid:main', mainId).catch(() => {});
  await kv.set('line:richmenuid:link', linkId).catch(() => {});
  // 未連携（既定）は LINK メニュー。連携時に MAIN を per-user 割当する。
  const setResp = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${linkId}`, { method: 'POST', headers: H });
  if (!setResp.ok) { console.error('richmenu set-default failed:', setResp.status); return false; }
  return true;
}

/**
 * リッチメニューが未設定なら1回だけ自動設定する（Webhook受信時に呼ぶ）。
 * bot単位・全チーム共通。作成後に全ユーザーの既定メニューとして設定し、確実に表示させる。
 */
async function _ensureRichMenu() {
  if (_richmenuEnsured || !_lineToken()) return;
  const flagKey = `line:richmenu:${RICHMENU_VERSION}`;
  const done = await kv.get(flagKey).catch(() => null);
  if (done) { _richmenuEnsured = true; return; }
  const lock = await kv.set(`${flagKey}:lock`, '1', { nx: true, ex: 120 }).catch(() => 'OK');
  if (lock === null) return;
  try {
    if (await _setupRichMenuViaApi()) {
      await kv.set(flagKey, '1').catch(() => {});
      _richmenuEnsured = true;
    }
  } catch (e) { console.error('ensureRichMenu error:', e?.message || e); }
  finally { await kv.del(`${flagKey}:lock`).catch(() => {}); }
}

/**
 * 連携済みユーザーに MAIN（4ボタン）メニューを per-user 割当する（1ユーザー1回・バージョン別フラグ）。
 * 既定は LINK メニューなので、割当に失敗しても「メニューが消える」ことはない（安全）。
 */
async function _lineEnsureUserMenu(userId) {
  if (!userId || !_lineToken()) return;
  const flagKey = `line:menu:${RICHMENU_VERSION}:${userId}`;
  if (await kv.get(flagKey).catch(() => null)) return; // 当バージョンで割当済み（軽量ショートサーキット）
  // 未連携ユーザーには MAIN を割り当てない（LINK＝認証コード入力メニューのまま）
  const link = await _lineLink(userId).catch(() => null);
  if (!link) return;
  const rmid = await kv.get('line:richmenuid:main').catch(() => null);
  if (!rmid) return;
  try {
    const r = await fetch(`https://api.line.me/v2/bot/user/${userId}/richmenu/${rmid}`, {
      method: 'POST', headers: { Authorization: `Bearer ${_lineToken()}` },
    });
    if (r.ok) await kv.set(flagKey, '1', { ex: 120 * 24 * 3600 }).catch(() => {});
  } catch (_) {}
}

/**
 * GET    /api/data/linerichmenu   状態（保守用）
 * POST   /api/data/linerichmenu   手動で再設定（保守用・admin）
 * DELETE /api/data/linerichmenu   解除（保守用・admin）
 * ※ 通常は Webhook 受信時に自動設定されるため、この操作は不要。
 */
async function lineRichMenu(req, res) {
  const authz = await _authorize(req, res);
  if (!authz) return;
  if (!authz.isAdmin) return res.status(403).json({ error: 'admin_only' });
  const token = _lineToken();
  if (!token) return res.status(400).json({ error: 'line_not_configured', message: 'LINE_CHANNEL_ACCESS_TOKEN が未設定です' });
  const H = { Authorization: `Bearer ${token}` };

  if (req.method === 'GET') {
    const r = await fetch('https://api.line.me/v2/bot/user/all/richmenu', { headers: H }).catch(() => null);
    return res.status(200).json({ enabled: !!(r && r.ok) });
  }
  if (req.method === 'DELETE') {
    await fetch('https://api.line.me/v2/bot/user/all/richmenu', { method: 'DELETE', headers: H }).catch(() => {});
    try {
      const list = await (await fetch('https://api.line.me/v2/bot/richmenu/list', { headers: H })).json();
      for (const m of (list.richmenus || [])) await fetch(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE', headers: H }).catch(() => {});
    } catch (_) {}
    await kv.del(`line:richmenu:${RICHMENU_VERSION}`).catch(() => {});
    _richmenuEnsured = false;
    return res.status(200).json({ ok: true, enabled: false });
  }
  if (req.method === 'POST') {
    const ok = await _setupRichMenuViaApi();
    if (ok) { await kv.set(`line:richmenu:${RICHMENU_VERSION}`, '1').catch(() => {}); _richmenuEnsured = true; }
    return res.status(ok ? 200 : 502).json({ ok, enabled: ok });
  }
  return res.status(405).json({ error: 'method_not_allowed' });
}

/** 設定B5の鍵でGeminiを代理呼び出し（gemini()と同じ鍵キャッシュ経路）。 */
async function _lineGeminiKey(sheetId) {
  const keyCacheKey = `gemini:key:${sheetId}`;
  let apiKey = _inProcGet(keyCacheKey);
  if (!apiKey) {
    apiKey = await kv.get(keyCacheKey).catch(() => null);
    if (apiKey) _inProcSet(keyCacheKey, apiKey, 290_000);
  }
  if (!apiKey) {
    const sheets = sheetsClient();
    const cfg = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: '設定!B5' });
    apiKey = cfg.data.values?.[0]?.[0] || '';
    if (apiKey) {
      _inProcSet(keyCacheKey, apiKey, 290_000);
      kv.set(keyCacheKey, apiKey, { ex: 300 }).catch(() => {});
    }
  }
  return apiKey;
}

/** 画像をGeminiで解析し JSON を返す（クライアント gemini.js と同一プロンプト）。 */
async function _lineAnalyze(sheetId, buf, mime, categories) {
  const apiKey = await _lineGeminiKey(sheetId);
  if (!apiKey) throw new Error('Gemini APIキー(設定B5)未設定');

  const prompt = `
以下の領収書画像を解析して、JSON形式で情報を抽出してください。
勘定科目は次のリストから必ず1つ選んでください（リスト外の値は返さないこと）：${categories.join('、')}
判断が難しい場合はリストの先頭（${categories[0]}）を返し、category_fallback を true にしてください。

必ず以下のJSON形式で回答してください（コードブロックなし）：
{
  "date": "YYYY-MM-DD",
  "shop": "支払先名",
  "invoice": "T+13桁のインボイス番号またはnull",
  "currency": "この領収書の通貨コード（JPY/USD/EUR/GBP等）。必ず1つ判定する",
  "total_amount": 税込み合計金額（通貨は currency のもの。円でも外貨でもこの欄に数値を入れる）,
  "category": "勘定科目（単一カテゴリの場合）",
  "category_fallback": true または false,
  "items": [{"amount": 金額（合算後）, "category": "勘定科目", "tax_rate": "課税10%/課税8%/非課税/不課税のいずれか"}] または null,
  "fx_currency": "外貨の場合の通貨コード（currencyと同じ）。日本円ならnull",
  "fx_amount": 外貨の場合の合計金額（currencyの通貨）。日本円ならnull,
  "tax_rate": "課税10%/課税8%/混在/非課税/不課税のいずれか",
  "withholding_amount": 源泉徴収税額（整数）またはnull
}

注意：
- ★最優先で通貨を判定する：金額に付く記号や表記（¥・円→JPY、$・US$・USD→USD、€・EUR→EUR、£・GBP→GBP など）や店舗の所在地から判断し currency に入れる。$表記は米ドル(USD)。判定できないときだけ JPY とする。
- currency が JPY のとき：total_amount に円の税込み合計を入れ、fx_* は null。
- currency が JPY 以外（外貨）のとき：total_amount と fx_amount の両方に「その外貨の合計金額」を入れ、fx_currency に通貨コードを入れる。
  ⚠️ レシートに円で併記された消費税額・参考円換算額があっても、それらは使わない（外貨の合計金額そのものを入れる。例：$40なら 40）
- total_amount/fx_amount は「税込み費用計上額（源泉徴収控除前）」を入れること
  - 源泉徴収税が差し引かれている場合、合計欄の支払金額（源泉控除後）ではなく、小計＋消費税の合計を使う
- 複数カテゴリ・税区分が混在する場合は items を使い category は null
- items の集約ルール：「勘定科目」と「税区分」の組み合わせが同じ明細は1行に合算すること
- インボイス番号は T+13桁の数字で始まる番号
- tax_rate：食品・飲料なら「課税8%」、交通費は「課税10%」、非課税取引なら「非課税」、不課税取引なら「不課税」、複数税率混在なら「混在」、それ以外は「課税10%」
`;

  const b64 = buf.toString('base64');
  const reqBody = {
    contents: [{ parts: [{ inlineData: { mimeType: mime, data: b64 } }, { text: prompt }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };
  const MODEL = 'gemini-3.1-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(55000),
  });
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    throw new Error('gemini ' + resp.status + ' ' + (d?.error?.message || ''));
  }
  const d = await resp.json();
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try { return JSON.parse(text); }
  catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('解析結果のパース失敗');
  }
}

/** 為替レート取得（Web版 _fetchExchangeRate と同じ3ソースのフォールバック・サーバー版）。 */
async function _fetchExchangeRate(from, to, date = null) {
  const f = String(from).toLowerCase(), t = String(to).toLowerCase();
  const dateStr = date || 'latest';
  const _timeout = () => AbortSignal.timeout(8000);
  // 1. jsdelivr currency-api（過去日付対応）
  try {
    const r = await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dateStr}/v1/currencies/${f}.json`, { signal: _timeout() });
    if (r.ok) { const d = await r.json(); const rate = d[f]?.[t]; if (rate) return rate; }
  } catch (_) {}
  // 2. Frankfurter（過去レート対応）
  try {
    const endpoint = date ? date : 'latest';
    const r = await fetch(`https://api.frankfurter.dev/v1/${endpoint}?base=${String(from).toUpperCase()}&symbols=${String(to).toUpperCase()}`, { signal: _timeout() });
    if (r.ok) { const d = await r.json(); const rate = d.rates?.[String(to).toUpperCase()]; if (rate) return rate; }
  } catch (_) {}
  // 3. ExchangeRate-API 無料枠（最新のみ）
  try {
    const r = await fetch(`https://open.er-api.com/v6/latest/${String(from).toUpperCase()}`, { signal: _timeout() });
    if (r.ok) { const d = await r.json(); const rate = d.rates?.[String(to).toUpperCase()]; if (rate) return rate; }
  } catch (_) {}
  return null;
}

/** 外貨→円換算（Web版と同じ：取引日レート×手数料3%込み・切り捨て）。取得失敗時は null。 */
async function _lineFxConvert(from, fxAmount, date) {
  const base = await _fetchExchangeRate(from, 'JPY', date);
  if (!base) return null;
  const markupPct = 3;
  const rate = base * (1 + markupPct / 100);
  const jpy = Math.floor(Number(fxAmount) * rate);
  const note = `${from} ${Number(fxAmount).toLocaleString()} × ${rate.toFixed(2)}（手数料${markupPct}%込）= ¥${jpy.toLocaleString('ja-JP')}（${date}レート）`;
  return { jpy, note };
}

/** Gemini解析JSON → 経費データ（G列科目フォーマット・S列税区分を組む・外貨は円換算）。 */
async function _lineParsedToData(g, categories) {
  const valid = new Set(categories);
  const pickCat = (c) => (c && valid.has(c)) ? c : categories[0];
  const txDate = _validDateStr(g.date) ? g.date : _todayJst();

  // 通貨判定：currency（明示）を最優先。無ければ fx_currency、それも無ければ JPY。
  const _cur = String(g.currency || g.fx_currency || 'JPY').toUpperCase().trim();
  const _isForeign = !!_cur && !['JPY', 'YEN', 'JP', '円', 'JPY円'].includes(_cur);
  // 外貨の合計額：fx_amount 優先、無ければ total_amount（Geminiが外貨額をtotalに入れても拾う）
  const _fxAmt = Number(g.fx_amount) || Number(g.total_amount) || 0;

  let amount = 0, category = '', taxRate = '課税10%', note = '';
  if (_isForeign && _fxAmt > 0) {
    // 外貨: 取引日レートで円換算（明細分割は無視し合計を換算）
    category = pickCat(g.category);
    taxRate = g.tax_rate && g.tax_rate !== '混在' ? g.tax_rate : '課税10%';
    const conv = await _lineFxConvert(_cur, _fxAmt, txDate);
    if (conv) { amount = conv.jpy; note = conv.note; }
    else { amount = 0; note = `外貨: ${_cur} ${_fxAmt}（為替レート取得に失敗。「修正する」で金額を入力してください）`; }
  } else if (Array.isArray(g.items) && g.items.length) {
    // 円・分割: "科目:金額:税率/..." 形式（parseSplitCategory と対称）
    const parts = g.items.map(it => {
      const cat = pickCat(it.category);
      const amt = Math.round(Number(it.amount) || 0);
      const tax = it.tax_rate || '課税10%';
      return { cat, amt, tax };
    });
    amount = parts.reduce((s, p) => s + p.amt, 0);
    category = parts.map(p => p.amt ? `${p.cat}:${p.amt}:${p.tax}` : p.cat).join('/');
    const taxes = [...new Set(parts.map(p => p.tax))];
    taxRate = taxes.length === 1 ? taxes[0] : '混在';
  } else {
    // 円・単一
    amount = Math.round(Number(g.total_amount) || 0);
    category = pickCat(g.category);
    taxRate = g.tax_rate && g.tax_rate !== '混在' ? g.tax_rate : '課税10%';
  }

  const withholding = Math.round(Number(g.withholding_amount) || 0);

  return {
    date:    txDate,
    place:   String(g.shop || '').slice(0, 100),
    amount,
    category,
    note,
    invoice: String(g.invoice && g.invoice !== 'null' ? g.invoice : '').trim(),
    taxRate,
    withholding,
    aiAmount: amount,  // 解析時点の金額＝AI解析額（N列・手修正検知の基準）
    corpPay: false,    // 支払方法（true=会社払い）。修正メニューで変更可能。
    paySource: '',     // 会社払い時の支払元（設定の支払元リストから選ぶ）
  };
}

function _validDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function _todayJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** 全角数字→半角。 */
function _toHalfWidthDigits(s) {
  return String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/**
 * ゆるい日付パース → 'YYYY-MM-DD' or null。
 * 受け付ける例: 2026-05-05 / 2026/5/5 / 2026.5.5 / 2026年5月5日 / 20260505 /
 *   5月5日 / 5/5（年なしは今年）/ 26-5-5 / 全角数字。
 */
function _parseLooseDate(text) {
  const s = _toHalfWidthDigits(String(text).trim());
  const yNow = Number(_todayJst().slice(0, 4));
  let y, m, d;
  const nums = s.match(/\d+/g);
  if (!nums) return null;
  if (/^\d{8}$/.test(s)) {              // 20260505
    y = +s.slice(0, 4); m = +s.slice(4, 6); d = +s.slice(6, 8);
  } else if (nums.length >= 3) {         // 2026-05-05 / 2026年5月5日 等
    y = +nums[0]; m = +nums[1]; d = +nums[2];
  } else if (nums.length === 2) {        // 5月5日 / 5/5（年なし→今年）
    y = yNow; m = +nums[0]; d = +nums[1];
  } else {
    return null;
  }
  if (y < 100) y += 2000;                // 26 → 2026
  if (!(m >= 1 && m <= 12) || d < 1) return null;
  const dim = new Date(y, m, 0).getDate();  // その月の日数
  if (d > dim) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 確認画面のテキスト（解析結果＋監査アラート）。 */
// YYYY-MM-DD → 「2026年7月10日」。LINEがハイフン日付を電話番号と誤認しリンク化するのを防ぐ。
function _fmtDateJa(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s || ''));
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : String(s || '');
}

function _lineSummary(data, alerts) {
  const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');
  const catLabel = data.category.split('/').map(seg => {
    const p = seg.split(':');
    return p.length >= 2 ? `${p[0]}(${yen(p[1])})` : p[0];
  }).join(' / ');
  const lines = [
    '【内容を確認してください】',
    `日付: ${_fmtDateJa(data.date)}`,
    `支払先: ${data.place || '(不明)'}`,
    `金額: ${yen(data.amount)}`,
    `科目: ${catLabel || '(未設定)'}`,
    `税区分: ${data.taxRate}`,
    `支払方法: ${data.corpPay ? `会社払い${data.paySource ? `（${data.paySource}）` : ''}` : '自分の立替'}`,
  ];
  if (data.invoice) lines.push(`インボイス: ${data.invoice}`);
  if (data.withholding) lines.push(`源泉徴収: ${yen(data.withholding)}`);
  if (data.note) lines.push(`備考: ${data.note}`);
  if (alerts && alerts.length) {
    lines.push('', '⚠️ 確認事項:');
    alerts.forEach(a => lines.push(`・${a}`));
  }
  lines.push('', 'この内容で登録しますか？');
  return lines.join('\n');
}

/* ── 電車代（出発駅→到着駅→往復）フロー ── */

/** Yahoo乗換（既存の /api/transit）で運賃を取得。{ fare, yahooUrl } または { error }。 */
async function _lineTransitFare(from, to) {
  try {
    const url = `https://keihi-log.com/api/transit?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.fare) return { error: data.error || '運賃を取得できませんでした' };
    return { fare: Number(data.fare) || 0, yahooUrl: data.yahooUrl || '' };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? '運賃検索がタイムアウトしました' : '運賃検索に失敗しました' };
  }
}

/** 電車代フローの入口：未連携/複数経費ログを判定し、開始 or 組織選択へ。 */
async function _beginLineTransit(userId, replyToken) {
  const links = await _lineLinks(userId);
  if (!links.length) {
    return _lineReply(replyToken, _lineText('未連携です。まず管理者から受け取った6桁の連携コードを送信してください。'));
  }
  _lineEnsureUserMenu(userId).catch(() => {});
  if (links.length === 1) return _startLineTransit(userId, replyToken, links[0]);
  // 複数経費ログ：登録先を選ばせてから開始
  await kv.set(`line:pending:${userId}`, { step: 'awaiting_org_transit' }, { ex: 600 }).catch(() => {});
  const choices = await Promise.all(links.map(async l => ({
    sheetId: l.sheetId, label: await _lineOrgLabel(l.sheetId).catch(() => '経費ログ'),
  })));
  return _lineReply(replyToken, _lineText('どの経費ログに登録しますか？',
    choices.map(o => _qpPostback(o.label, `action=pickorgtransit&s=${encodeURIComponent(o.sheetId)}`))));
}

/** 電車代フロー開始：出発駅を尋ねる（対象の経費ログは選択済み link を pending に保持）。 */
async function _startLineTransit(userId, replyToken, link) {
  if (!(await _isTeamPlanActive(link.sheetId))) {
    return _lineReply(replyToken, _lineText('LINE連携はチームプランでご利用いただけます。管理者にご確認ください。'));
  }
  const name = await _lineMemberName(link.sheetId, link.identity);
  if (name === null) return _lineReply(replyToken, _lineText('メンバー登録が見つかりません。管理者に連携し直しを依頼してください。'));
  await kv.set(`line:pending:${userId}`, {
    step: 'transit_from', sheetId: link.sheetId, identity: link.identity,
  }, { ex: 600 }).catch(() => {});
  return _lineReply(replyToken, _lineText('🚃 電車代を登録します。\nまず「出発駅」を送ってください。\n例: 東京'));
}

/** 出発駅・到着駅・往復の会話ステップを処理（テキスト受信時に呼ぶ）。 */
async function _handleLineTransitText(userId, replyToken, pending, text) {
  const v = String(text || '').trim().slice(0, 50);
  if (!v) return _lineReply(replyToken, _lineText('駅名を送ってください。'));
  if (pending.step === 'transit_from') {
    pending.from = v; pending.step = 'transit_to';
    await kv.set(`line:pending:${userId}`, pending, { ex: 600 }).catch(() => {});
    return _lineReply(replyToken, _lineText('次に「到着駅」を送ってください。\n例: 横浜'));
  }
  // transit_to
  pending.to = v; pending.step = 'transit_round';
  await kv.set(`line:pending:${userId}`, pending, { ex: 600 }).catch(() => {});
  return _lineReply(replyToken, _lineText(`「${pending.from} → ${pending.to}」\n片道・往復を選んでください。`, [
    _qpPostback('片道', 'action=transitround&r=0'),
    _qpPostback('往復', 'action=transitround&r=1'),
  ]));
}

/** 往復選択 → 運賃検索 → 経費データを組み立てて確認カードを提示。 */
async function _lineTransitConfirm(userId, replyToken, pending, round) {
  const { sheetId, identity, from, to } = pending;
  if (!from || !to) return _lineReply(replyToken, _lineText('入力が途中で切れました。もう一度「電車」と送ってやり直してください。'));
  const { fare, error, yahooUrl } = await _lineTransitFare(from, to);
  if (error || !fare) {
    return _lineReply(replyToken, _lineText(`運賃を取得できませんでした（${error || '該当なし'}）。\n駅名をご確認のうえ、もう一度「電車」と送ってお試しください。`));
  }
  const amount = round ? fare * 2 : fare;
  const master = await readMasterCached(sheetId).catch(() => ({ categories: [] }));
  const category = (master.categories || []).includes('旅費交通費') ? '旅費交通費'
    : (master.categories || []).find(c => /交通|旅費/.test(c)) || (master.categories?.[0] || '旅費交通費');
  const data = {
    type: '電車/バス',
    date: _todayJst(),
    place: `${from} ${round ? '↔' : '→'} ${to}`,
    amount, category, taxRate: '課税10%',
    note: '', corpPay: false, paySource: '', invoice: '', withholding: 0, imageLink: '',
  };
  const expenses = await readExpensesViaSA(sheetId).catch(() => []);
  const alerts = _serverAuditChecks(expenses, data, []);
  await kv.set(`line:pending:${userId}`, {
    data, sheetId, identity, alerts, aiAmount: amount, imageHash: '', imageLink: '', imageStored: false, step: 'confirm',
  }, { ex: 600 }).catch(() => {});
  const messages = [_lineConfirmMessage(
    _lineSummary(data, alerts) + `\n（運賃 ¥${fare.toLocaleString('ja-JP')}${round ? ' ×2（往復）' : ''}）`
  )];
  if (yahooUrl) messages.unshift(_lineText(`🔗 Yahoo!乗換で経路・運賃を確認\n${yahooUrl}`));
  return _lineReply(replyToken, messages);
}

/* ── postback（登録/修正/やめる/項目選択） ── */

async function _handleLinePostback(userId, replyToken, dataStr) {
  const params = new URLSearchParams(dataStr);
  const action = params.get('action');

  // ── リッチメニューのボタン（pending不要） ──
  // 未連携メニューの「認証コードを入力」
  if (action === 'entercode') {
    return _lineReply(replyToken, _lineText(
      '管理者から届いた6桁の認証コードを、この下の入力欄に入力して送信してください。\n（入力欄が出ていない場合は、メニュー右上の「∨」やキーボードのアイコンをタップしてください）'
    ));
  }
  // カメラ/アルバムはLINE仕様でクイックリプライ限定のため、メニュー→ワンタップで開かせる。
  if (action === 'camera') {
    return _lineReply(replyToken, {
      type: 'text',
      text: '領収書を撮影してください📷',
      quickReply: { items: [{ type: 'action', action: { type: 'camera', label: 'カメラを開く' } }] },
    });
  }
  if (action === 'upload') {
    return _lineReply(replyToken, {
      type: 'text',
      text: '送りたい画像を選んでください🖼',
      quickReply: { items: [{ type: 'action', action: { type: 'cameraRoll', label: 'アルバムを開く' } }] },
    });
  }
  // 旧メニュー（sendreceipt）互換：カメラ/アルバム両方を出す
  if (action === 'sendreceipt') {
    return _lineReply(replyToken, {
      type: 'text',
      text: '領収書の写真を送ってください📷',
      quickReply: { items: [
        { type: 'action', action: { type: 'camera',     label: 'カメラで撮影' } },
        { type: 'action', action: { type: 'cameraRoll', label: 'アルバム/スクショ' } },
      ] },
    });
  }
  if (action === 'history')   return _handleLineHistory(userId, replyToken);
  if (action === 'unsettled') return _handleLineUnsettled(userId, replyToken);
  if (action === 'transit')   return _beginLineTransit(userId, replyToken);

  const pending = await kv.get(`line:pending:${userId}`).catch(() => null);

  // 電車代: 登録先の経費ログ選択 → フロー開始
  if (action === 'pickorgtransit') {
    if (!pending || pending.step !== 'awaiting_org_transit') {
      return _lineReply(replyToken, _lineText('時間切れです。もう一度「電車」と送ってやり直してください。'));
    }
    const sheetId = params.get('s');
    const links = await _lineLinks(userId);
    const link = links.find(l => l.sheetId === sheetId);
    if (!link) return _lineReply(replyToken, _lineText('選択した経費ログが見つかりません。もう一度「電車」と送ってください。'));
    return _startLineTransit(userId, replyToken, link);
  }
  // 電車代: 片道/往復の選択 → 運賃検索して確認カードへ
  if (action === 'transitround') {
    if (!pending || pending.step !== 'transit_round') {
      return _lineReply(replyToken, _lineText('時間切れです。もう一度「電車」と送ってやり直してください。'));
    }
    return _lineTransitConfirm(userId, replyToken, pending, params.get('r') === '1');
  }

  // 複数経費ログ: 登録先の組織を選択 → その経費ログで解析を続行
  if (action === 'pickorg') {
    if (!pending || pending.step !== 'awaiting_org' || !pending.messageId) {
      return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    }
    const sheetId = params.get('s');
    const links = await _lineLinks(userId);
    const link = links.find(l => l.sheetId === sheetId);
    if (!link) return _lineReply(replyToken, _lineText('選択した経費ログが見つかりません。もう一度画像を送ってください。'));
    await kv.del(`line:pending:${userId}`).catch(() => {});
    return _processLineImage(userId, replyToken, pending.messageId, link);
  }

  // 組織選択待ち中に確認系の操作が来た場合（データ未解析）→ 選び直しを促す
  if (pending && pending.step === 'awaiting_org') {
    return _lineReply(replyToken, _lineText('先にどの経費ログに登録するか選んでください。もう一度画像を送ると選び直せます。'));
  }

  if (action === 'register') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    return _lineRegister(userId, replyToken, pending);
  }
  if (action === 'cancel') {
    await kv.del(`line:pending:${userId}`).catch(() => {});
    return _lineReply(replyToken, _lineText('取り消しました。'));
  }
  if (action === 'edit') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    return _lineReply(replyToken, _lineText('どの項目を修正しますか？', [
      _qpPostback('日付',     'action=editfield&f=date'),
      _qpPostback('支払先',   'action=editfield&f=place'),
      _qpPostback('金額',     'action=editfield&f=amount'),
      _qpPostback('科目',     'action=editfield&f=category'),
      _qpPostback('備考',     'action=editfield&f=note'),
      _qpPostback('支払方法', 'action=paymethod'),
      _qpPostback('戻る',     'action=editback'),
    ]));
  }
  if (action === 'editback') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    return _lineReply(replyToken, _lineConfirmMessage(_lineSummary(pending.data, pending.alerts)));
  }
  if (action === 'editfield') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    const f = params.get('f');
    // 科目はボタン選択（マスタのカテゴリ）にする
    if (f === 'category') {
      const link = await _pendingLink(userId, pending);
      const master = link ? await readMasterCached(link.sheetId).catch(() => null) : null;
      const cats = (master?.categories || []).slice(0, 12);
      if (cats.length) {
        const items = cats.map(c => _qpPostback(c, `action=setcat&c=${encodeURIComponent(c)}`));
        return _lineReply(replyToken, _lineText('科目を選んでください:', items));
      }
    }
    pending.step = 'awaiting_value';
    pending.editField = f;
    await kv.set(`line:pending:${userId}`, pending, { ex: 600 }).catch(() => {});
    const labels = { date: '日付（例: 2026-05-05 / 20260505 / 5月5日）', place: '支払先', amount: '金額（数字）', category: '科目', note: '備考' };
    return _lineReply(replyToken, _lineText(`新しい「${labels[f] || f}」を送ってください。`));
  }
  if (action === 'setcat') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    const c = params.get('c') || '';
    pending.data.category = c;  // 単一科目に置換
    delete pending.step; delete pending.editField;
    pending.alerts = await _reauditPending(userId, pending);
    await kv.set(`line:pending:${userId}`, pending, { ex: 600 }).catch(() => {});
    return _lineReply(replyToken, _lineConfirmMessage(_lineSummary(pending.data, pending.alerts)));
  }
  // 支払方法: 自分の立替 / 会社払い（→支払元選択）
  if (action === 'paymethod') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    return _lineReply(replyToken, _lineText('支払方法を選んでください:', [
      _qpPostback('自分の立替', 'action=setpay&corp=0'),
      _qpPostback('会社払い',   'action=setpay&corp=1'),
    ]));
  }
  if (action === 'setpay') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    if (params.get('corp') !== '1') {
      // 自分の立替に設定して確認へ戻る
      pending.data.corpPay = false; pending.data.paySource = '';
      await kv.set(`line:pending:${userId}`, pending, { ex: 600 }).catch(() => {});
      return _lineReply(replyToken, _lineConfirmMessage(_lineSummary(pending.data, pending.alerts)));
    }
    // 会社払い → 支払元を選ばせる（設定の支払元リスト）。未設定なら支払元なしで会社払い。
    const link = await _pendingLink(userId, pending);
    const master = link ? await readMasterCached(link.sheetId).catch(() => null) : null;
    const sources = (master?.paySources || []).slice(0, 12);
    if (!sources.length) {
      pending.data.corpPay = true; pending.data.paySource = '';
      await kv.set(`line:pending:${userId}`, pending, { ex: 600 }).catch(() => {});
      return _lineReply(replyToken, _lineConfirmMessage(_lineSummary(pending.data, pending.alerts)));
    }
    const items = sources.map(s => _qpPostback(s, `action=setpaysrc&s=${encodeURIComponent(s)}`));
    return _lineReply(replyToken, _lineText('会社払いの支払元を選んでください:', items));
  }
  if (action === 'setpaysrc') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    pending.data.corpPay = true;
    pending.data.paySource = params.get('s') || '';
    await kv.set(`line:pending:${userId}`, pending, { ex: 600 }).catch(() => {});
    return _lineReply(replyToken, _lineConfirmMessage(_lineSummary(pending.data, pending.alerts)));
  }
  return _lineReply(replyToken, _lineText('もう一度画像を送ってください。'));
}

/** 修正値の反映（テキスト入力）。 */
async function _applyLineEdit(userId, replyToken, pending, text) {
  const f = pending.editField;
  const d = pending.data;
  if (f === 'date') {
    const v = _parseLooseDate(text);
    if (!v) return _lineReply(replyToken, _lineText('日付を認識できませんでした。例: 2026-05-05 / 20260505 / 5月5日 のように送ってください。'));
    d.date = v;
  } else if (f === 'place') {
    d.place = text.slice(0, 100);
  } else if (f === 'amount') {
    const n = Number(_toHalfWidthDigits(text).replace(/[^\d]/g, ''));
    if (!n || n < 1) return _lineReply(replyToken, _lineText('金額は1以上の数字で送ってください。'));
    d.amount = n;
    // 単一科目なら分割表記も金額を追従
    if (d.category && !d.category.includes('/') && d.category.includes(':')) {
      const p = d.category.split(':'); d.category = `${p[0]}:${n}:${p[2] || d.taxRate}`;
    }
  } else if (f === 'category') {
    d.category = text.slice(0, 60);
  } else if (f === 'note') {
    d.note = text.slice(0, 200);
  }
  delete pending.step; delete pending.editField;
  pending.alerts = await _reauditPending(userId, pending);
  await kv.set(`line:pending:${userId}`, pending, { ex: 600 }).catch(() => {});
  return _lineReply(replyToken, _lineConfirmMessage(_lineSummary(d, pending.alerts)));
}

/** 修正後に監査を再実行（AI解析額との不一致等が変わるため）。 */
async function _reauditPending(userId, pending) {
  try {
    const link = await _pendingLink(userId, pending);
    if (!link) return pending.alerts || [];
    const expenses = await readExpensesViaSA(link.sheetId).catch(() => []);
    return _serverAuditChecks(expenses, { ...pending.data, aiAmount: pending.aiAmount }, [pending.imageHash]);
  } catch (_) { return pending.alerts || []; }
}

/** 登録実行（申請済で経費一覧へ）。 */
async function _lineRegister(userId, replyToken, pending) {
  const link = await _pendingLink(userId, pending);
  if (!link) return _lineReply(replyToken, _lineText('連携が切れています。連携コードを送信してください。'));
  const { sheetId, identity } = link;

  if (!(await _isTeamPlanActive(sheetId))) {
    return _lineReply(replyToken, _lineText('LINE連携はチームプランでご利用いただけます。'));
  }
  const name = await _lineMemberName(sheetId, identity);
  if (name === null) return _lineReply(replyToken, _lineText('メンバー登録が見つかりません。管理者にご確認ください。'));

  // 管理者の登録は自動承認（Web版 submit.js の confirmed: App.isAdmin() と同じ挙動）。
  //   admins/ownerと一致すれば承認列(J)=true=「登録済」、一般メンバーは false=「申請済」。
  const idLower = String(identity).toLowerCase();
  const master = await readMasterCached(sheetId).catch(() => null);
  const ownerEmail = await resolveOwnerEmail(sheetId).catch(() => '');
  const isAdmin = !!master && ((master.admins || []).includes(idLower) || (!!ownerEmail && idLower === ownerEmail));

  const d = pending.data;
  const aiAudit = (pending.alerts && pending.alerts.length) ? ('⛔ ' + pending.alerts.join(' / ')) : '';
  const imageLink = pending.imageLink || '';
  // 会社払いは L列（精算日）に「会社払い（支払元）」を記録（Web版と同じ扱い＝精算不要・未精算一覧に出ない）
  const settlement = d.corpPay ? `会社払い（${d.paySource || 'その他'}）` : '';
  const row = [
    _nowJst(),                                  // A: 申請日時（サーバー時刻）
    name,                                       // B: 名前
    d.type || '領収書',                         // C: タイプ（電車/バス等も対応）
    d.date,                                     // D: 日付
    d.place,                                    // E: 支払先
    d.amount,                                   // F: 金額
    d.category,                                 // G: 勘定科目
    d.note || '',                               // H: 備考
    imageLink ? `=HYPERLINK("${imageLink}","証票")` : '', // I: 証票
    isAdmin,                                    // J: 承認（管理者は自動承認＝登録済／一般は申請済）
    aiAudit,                                    // K: 監査
    settlement,                                 // L: 精算日（会社払い時は「会社払い（支払元）」）
    d.invoice || '',                            // M: インボイス
    pending.aiAmount || 0,                      // N: AI解析額
    pending.imageHash || '',                    // O: 画像ハッシュ
    identity,                                   // P: email or 合成ID
    _uuid(),                                    // Q: id
    'LINE',                                     // R: デバイス
    d.taxRate || '課税10%',                     // S: 税区分
    d.withholding || 0,                         // T: 源泉徴収
    '',                                         // U: カスタムフラグ
  ];

  try {
    await _withSheetWriteLock(sheetId, () => prependExpenseRowViaSA(sheetId, row));
    _inProcDel(`data:exp:${sheetId}`);
    await kv.del(`data:exp:${sheetId}`).catch(() => {});
    await kv.del(`line:pending:${userId}`).catch(() => {});
    const teamUrl = await _lineTeamUrl(sheetId).catch(() => '');
    const statusLabel = d.corpPay ? '会社払い' : (isAdmin ? '登録済' : '申請済');
    return _lineReply(replyToken, _lineText(
      `登録しました（${statusLabel}）。\n${_fmtDateJa(d.date)} ${d.place} ¥${Number(d.amount).toLocaleString('ja-JP')}` +
      (d.corpPay ? `\n支払方法: 会社払い${d.paySource ? `（${d.paySource}）` : ''}（精算不要）` : '') +
      (aiAudit ? '\n※確認事項ありのため管理者が内容を確認します。' : '') +
      (teamUrl ? `\n\n▼Web版はこちら\n${teamUrl}?openExternalBrowser=1\nGoogleアカウントでメンバー登録済みの方は、Web版からも申請内容の確認・修正ができます。` : '')
    ));
  } catch (e) {
    console.error('line register error:', e?.message || e);
    return _lineReply(replyToken, _lineText('登録に失敗しました。時間をおいて再度お試しください。'));
  }
}

/* ── 未精算一覧 ── */

async function _handleLineUnsettled(userId, replyToken) {
  const links = await _lineLinks(userId);
  if (!links.length) return _lineReply(replyToken, _lineText('未連携です。連携コードを送信してください。'));
  _lineEnsureUserMenu(userId).catch(() => {});
  const multi = links.length > 1;

  const blocks = [];
  let grandTotal = 0, grandCount = 0;
  for (const link of links) {
    const { sheetId, identity } = link;
    const name = await _lineMemberName(sheetId, identity);
    if (name === null) continue; // このログでは既にメンバー外
    const idLower = String(identity).toLowerCase();
    const expenses = await readExpensesViaSA(sheetId).catch(() => []);
    // 自分の・未精算（L列空）のみ
    const mine = expenses.filter(e =>
      String(e.email).toLowerCase() === idLower &&
      !(e.settlementDate && String(e.settlementDate).trim() !== '')
    );
    if (!mine.length) continue;
    mine.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const total = mine.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    grandTotal += total; grandCount += mine.length;
    const N = multi ? 5 : 10;
    const shown = mine.slice(0, N).map(e =>
      `・${_fmtDateJa(e.date)} ${String(e.place || '').slice(0, 16)} ¥${Number(e.amount).toLocaleString('ja-JP')}`
    );
    const more = mine.length > N ? `\n…ほか${mine.length - N}件` : '';
    const head = multi
      ? `【${await _lineOrgLabel(sheetId).catch(() => '')}】未精算 ${mine.length}件 / ¥${total.toLocaleString('ja-JP')}`
      : `未精算 ${mine.length}件 / 合計 ¥${total.toLocaleString('ja-JP')}`;
    blocks.push([head, '', ...shown].join('\n') + more);
  }
  if (!grandCount) return _lineReply(replyToken, _lineText('未精算の経費はありません。'));
  const foot = multi ? `\n\n─────\n合計 ${grandCount}件 / ¥${grandTotal.toLocaleString('ja-JP')}` : '';
  return _lineReply(replyToken, _lineText(blocks.join('\n\n') + foot));
}

/** 経費オブジェクトからステータス表示ラベルを得る。 */
function _expStatusLabel(e) {
  const s = String(e.settlementDate || '').trim();
  if (s.startsWith('会社払い')) return '会社払い';
  if (s !== '') return '精算済';
  if (e.confirmed) return '登録済';
  return '申請済';
}

/** 自分の直近の申請（全ステータス）を返す。リッチメニュー「自分の申請」。 */
async function _handleLineHistory(userId, replyToken) {
  const links = await _lineLinks(userId);
  if (!links.length) return _lineReply(replyToken, _lineText('未連携です。連携コードを送信してください。'));
  _lineEnsureUserMenu(userId).catch(() => {});
  const multi = links.length > 1;

  const blocks = [];
  for (const link of links) {
    const { sheetId, identity } = link;
    const name = await _lineMemberName(sheetId, identity);
    if (name === null) continue;
    const idLower = String(identity).toLowerCase();
    const expenses = await readExpensesViaSA(sheetId).catch(() => []);
    const mine = expenses.filter(e => String(e.email).toLowerCase() === idLower);
    if (!mine.length) continue;
    // 申請日時→日付の新しい順
    mine.sort((a, b) => String(b.appliedAt || b.date || '').localeCompare(String(a.appliedAt || a.date || '')));
    const N = multi ? 8 : 15;
    const shown = mine.slice(0, N).map(e =>
      `・${_fmtDateJa(e.date)} ${String(e.place || '').slice(0, 14)} ¥${Number(e.amount).toLocaleString('ja-JP')}【${_expStatusLabel(e)}】`
    );
    const head = multi
      ? `【${await _lineOrgLabel(sheetId).catch(() => '')}】直近${Math.min(N, mine.length)}件（全${mine.length}件）`
      : `直近の申請（全${mine.length}件中${Math.min(N, mine.length)}件）`;
    const more = mine.length > N ? `\n…ほか${mine.length - N}件` : '';
    blocks.push([head, '', ...shown].join('\n') + more);
  }
  if (!blocks.length) return _lineReply(replyToken, _lineText('申請はまだありません。領収書の写真を送ると登録できます。'));
  return _lineReply(replyToken, _lineText(blocks.join('\n\n')));
}

/* ── 監査ロジックのサーバー移植（submit.js _runAuditChecks と同期） ──
 * ⚠️ クライアント submit.js の監査ルールを変更した場合はこちらも追従すること。 */
function _serverAuditChecks(expenses, data, newHashes) {
  const alerts = [];
  const amount = Number(data.amount) || 0;

  // 0. 交際費：参加者名の記載推奨
  if (String(data.category || '').split('/').some(p => p.split(':')[0] === '交際費') && !data.note) {
    alerts.push('交際費は備考に参加者名を記載することを推奨します');
  }

  // 1. AI解析額との不一致
  const ai = Number(data.aiAmount) || 0;
  if (ai > 0 && amount !== Math.round(ai)) {
    alerts.push(`AI解析額 ¥${Math.round(ai).toLocaleString('ja-JP')} と申請額 ¥${amount.toLocaleString('ja-JP')} が一致しません`);
  }

  // 2. インボイス番号＋金額＋日付の重複
  if (data.invoice && String(data.invoice).trim()) {
    const invNorm = String(data.invoice).trim().toUpperCase();
    const dup = expenses.find(e =>
      e.invoice && String(e.invoice).trim().toUpperCase() === invNorm &&
      Number(e.amount) === amount && String(e.date) === String(data.date));
    if (dup) alerts.push(`インボイス番号と金額が一致する申請済みデータがあります (${dup.date} ${dup.place} ¥${Number(dup.amount).toLocaleString('ja-JP')})`);
  }

  // 3. 画像ハッシュ重複
  if (newHashes && newHashes.length) {
    const dup = expenses.find(e => e.imageHash && newHashes.some(h => String(e.imageHash).split(',').includes(h)));
    if (dup) alerts.push(`同一画像が既に申請済み (${dup.date} ${dup.place})`);
  }

  // 4. 同日・同額・類似取引先
  const sim = (a, b) => {
    if (!a || !b) return false;
    const na = String(a).trim().toLowerCase().replace(/[\s　]/g, '');
    const nb = String(b).trim().toLowerCase().replace(/[\s　]/g, '');
    if (na === nb) return true;
    if (na.length >= 3 && (nb.includes(na) || na.includes(nb))) return true;
    if (na.length >= 4 && nb.length >= 4 && na.slice(0, 4) === nb.slice(0, 4)) return true;
    return false;
  };
  const dupE = expenses.find(e =>
    e.date === data.date && Number(e.amount) === amount && sim(e.place, data.place));
  if (dupE) alerts.push(`重複の疑い: ${dupE.date} ${dupE.place} ¥${Number(dupE.amount).toLocaleString('ja-JP')}`);

  // 5. 高額（10万円以上）
  if (amount >= 100000) alerts.push(`高額（¥${amount.toLocaleString('ja-JP')}）です。内容をご確認ください`);

  // 6. 2ヶ月以上前の日付
  if (_validDateStr(data.date)) {
    const dt = new Date(data.date + 'T00:00:00+09:00');
    const twoMonthsAgo = new Date(Date.now() - 62 * 86400000);
    if (dt < twoMonthsAgo) alerts.push(`日付が2ヶ月以上前（${data.date}）です`);
  }

  return alerts;
}

/* ── 管理者エンドポイント: 連携コード発行 / 解除 ── */

/**
 * POST /api/data/linecode   body: { sheetId, identity, name }
 *   admin が特定メンバー向けの6桁連携コードを発行する。
 *   identity はメール（既存メンバー）または空（→合成ID発行を想定した名前指定）。
 */
async function lineCodeIssue(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const authz = await _authorize(req, res);
  if (!authz) return;
  if (!authz.isAdmin) return res.status(403).json({ error: 'admin_only' });

  if (!(await _isTeamPlanActive(authz.sheetId))) {
    return res.status(403).json({ error: 'team_plan_required', message: 'LINE連携はチームプラン限定です' });
  }

  const body = (await _body(req)) || {};
  const name = String(body.name || '').slice(0, 60);
  let identity = String(body.identity || '').trim().toLowerCase();
  if (!identity && !name) return res.status(400).json({ error: 'identity_or_name_required' });

  // メールなし（LINE専用）の場合は合成IDを生成しマスタ表に登録
  if (!identity) {
    // 合成IDは userId 由来だが発行時点では userId 未確定 → 名前ベースの一時IDを避け、
    // 連携時に userId から合成IDを確定する方式にするため、ここでは identity を空で持つ。
    // マスタ表にはメールなし行として name のみ登録しておく（既存 readMaster が name のみ行を許容）。
    // 合成IDは name/sheet が同一でも衝突しないよう乱数を混ぜて一意化する
    identity = _lineSynthId('m:' + authz.sheetId + ':' + name + ':' + crypto.randomInt(0, 1e9));
    try {
      const sheets = sheetsClient();
      await sheets.spreadsheets.values.append({
        spreadsheetId: authz.sheetId,
        range: 'マスタ表!A:H',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[name, identity, '', 'member', '', '', '', '']] },
      });
      _inProcDel(`acct:master:${authz.sheetId}`);
      await kv.del(`acct:master:${authz.sheetId}`).catch(() => {});
    } catch (e) {
      console.error('line synth member add error:', e?.message || e);
      return res.status(500).json({ error: 'member_add_failed' });
    }
  } else {
    // 既存メンバーか確認。直前にクライアントがメンバー追加した直後だと
    // マスタ表キャッシュ（in-proc 55s / KV 60s）が古く未反映のことがあるため、
    // キャッシュで見つからなければ1回だけシートを直読み（read-after-write 一貫性）。
    let nm = await _lineMemberName(authz.sheetId, identity);
    if (nm === null) {
      _inProcDel(`acct:master:${authz.sheetId}`);
      await kv.del(`acct:master:${authz.sheetId}`).catch(() => {});
      const fresh = await readMaster(authz.sheetId).catch(() => null);
      const idLower = String(identity).toLowerCase();
      const hit = fresh?.members?.find(mm => String(mm.email).toLowerCase() === idLower);
      nm = hit ? (hit.name || '') : null;
    }
    if (nm === null) return res.status(400).json({ error: 'not_a_member', message: 'そのメンバーがマスタ表にありません' });
  }

  // 6桁コード生成（衝突は極めて稀・使い捨て24h）
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await kv.set(`line:code:${code}`, {
    sheetId: authz.sheetId, identity, name,
  }, { ex: 86400 }).catch(() => {});

  // 公式アカウントの友だち追加URL（環境変数。プレビュー用/本番用で別bot）。
  // 秘密情報ではない（誰でも友だち追加できる公開URL）ためクライアントに返してよい。
  return res.status(200).json({
    ok: true, code, name, identity, expiresInHours: 24,
    addFriendUrl: process.env.LINE_ADD_FRIEND_URL || '',
  });
}

/**
 * POST /api/data/lineunlink  body: { sheetId, userId } または { identity }
 *   admin が連携を解除する（メンバー削除連動でも呼ぶ）。
 */
async function lineUnlink(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const authz = await _authorize(req, res);
  if (!authz) return;
  if (!authz.isAdmin) return res.status(403).json({ error: 'admin_only' });

  const body = (await _body(req)) || {};
  const userId = String(body.userId || '').trim();
  const identity = String(body.identity || '').trim().toLowerCase();
  const sheetId = authz.sheetId;

  // 当該シート向けのリンクだけを配列から外す（複数経費ログ対応に備えた形）。
  //   残りが空になったらキー自体を削除、残れば絞った配列で更新。
  async function _removeLinkFor(uid, matchFn) {
    const links = await _lineLinks(uid);
    const remaining = links.filter(l => !matchFn(l));
    if (remaining.length === links.length) return false;
    if (remaining.length) await kv.set(`line:link:${uid}`, { links: remaining }).catch(() => {});
    else await kv.del(`line:link:${uid}`).catch(() => {});
    await kv.srem(`line:link_by_sheet:${sheetId}`, uid).catch(() => {});
    return true;
  }

  let removed = 0;
  if (userId) {
    if (await _removeLinkFor(userId, l => l.sheetId === sheetId)) removed++;
  } else if (identity) {
    // identity 指定 → このシートの全 userId を走査して該当を解除
    const ids = await kv.smembers(`line:link_by_sheet:${sheetId}`).catch(() => []);
    for (const uid of (ids || [])) {
      if (await _removeLinkFor(uid, l => l.sheetId === sheetId && String(l.identity).toLowerCase() === identity)) removed++;
    }
  } else {
    return res.status(400).json({ error: 'userId_or_identity_required' });
  }

  return res.status(200).json({ ok: true, removed });
}
