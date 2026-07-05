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
      case 'line':
        return await lineRouter(req, res);
      default:
        return res.status(404).json({ error: 'not_found', resource });
    }
  } catch (e) {
    console.error('data router error:', e);
    return res.status(500).json({ error: 'server_error' });
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
 *   POST /api/data/line/webhook   LINE署名検証（生ボディ必須。bodyParser無効化済み）
 *   POST /api/data/line/code      連携コード発行（admin・設定タブから）
 *   POST /api/data/line/unlink    連携解除（admin・メンバー削除連動）
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

async function lineRouter(req, res) {
  const sub = _pathSegs(req)[3] || '';
  if (sub === 'webhook') return lineWebhook(req, res);
  if (sub === 'code')    return lineCodeIssue(req, res);
  if (sub === 'unlink')  return lineUnlink(req, res);
  return res.status(404).json({ error: 'not_found' });
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
    return _lineReply(replyToken, _lineText(
      '経費ログbotへようこそ。\nご利用には管理者から受け取った6桁の連携コードの送信が必要です。\n連携後は領収書の画像を送るだけで経費を登録できます。'
    ));
  }

  if (!userId) return;

  if (ev.type === 'postback') {
    return _handleLinePostback(userId, replyToken, ev.postback?.data || '');
  }

  if (ev.type === 'message') {
    const m = ev.message || {};
    if (m.type === 'image') return _handleLineImage(userId, replyToken, m.id);
    if (m.type === 'text')  return _handleLineText(userId, replyToken, String(m.text || '').trim());
    // その他（スタンプ・動画等）は案内のみ
    return _lineReply(replyToken, _lineText('領収書の画像を送ってください。'));
  }
}

/* ── リンク解決・プラン/メンバー検証 ── */

/** userId → 紐付け情報 { sheetId, identity, name } or null。 */
async function _lineLink(userId) {
  return await kv.get(`line:link:${userId}`).catch(() => null);
}

/** チームプランかつ有効なライセンスか（license.js と同じ判定）。 */
async function _isTeamPlanActive(sheetId) {
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
  if (!licKey) return false;
  const data = await kv.get(`license:${licKey}`).catch(() => null);
  if (!data || data.suspended) return false;
  if (data.expiresAt && new Date(data.expiresAt) < new Date()) return false;
  const isTrial = data.trial === true ||
    (!('trial' in data) && data.stripeSessionId && data.createdAt && data.expiresAt &&
      (new Date(data.expiresAt) - new Date(data.createdAt)) / 86400000 <= 35);
  const plan = isTrial ? 'team' : (data.plan || 'solo');
  return plan === 'team';
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

  // 6桁数字 → 連携コード
  if (/^\d{6}$/.test(text)) {
    return _handleLineCode(userId, replyToken, text);
  }

  // 未精算キーワード
  if (/未精算|未清算|一覧|残/.test(text)) {
    return _handleLineUnsettled(userId, replyToken);
  }

  // 連携済みなら使い方案内、未連携なら連携案内
  const link = await _lineLink(userId);
  if (link) {
    return _lineReply(replyToken, _lineText(
      '領収書の画像を送ると経費を登録できます。\n「未精算」と送ると自分の未精算一覧を表示します。'
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
  await kv.set(`line:link:${userId}`, {
    sheetId: info.sheetId, identity: info.identity, name: info.name || '',
  }).catch(() => {});
  await kv.sadd(`line:link_by_sheet:${info.sheetId}`, userId).catch(() => {});
  await kv.del(`line:code:${code}`).catch(() => {});
  await kv.del(failKey).catch(() => {});

  return _lineReply(replyToken, _lineText(
    `連携しました。「${info.name || 'メンバー'}」として登録されます。\n領収書の画像を送ってください。`
  ));
}

/* ── 画像受信 → 解析 → 確認 ── */

async function _handleLineImage(userId, replyToken, messageId) {
  const link = await _lineLink(userId);
  if (!link) {
    return _lineReply(replyToken, _lineText('未連携です。まず管理者から受け取った6桁の連携コードを送信してください。'));
  }
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
    // 画像取得 → ハッシュ → SAで証票フォルダへ保存
    const { buf, mime } = await _lineFetchContent(messageId);
    const imageHash = crypto.createHash('sha256').update(buf).digest('hex');
    const driveInfo = await _lineUploadReceipt(sheetId, buf, mime);

    // 勘定科目リスト取得 → Gemini解析
    const master = await readMasterCached(sheetId).catch(() => ({ categories: [] }));
    const categories = master.categories?.length ? master.categories : ['雑費'];
    const parsed = await _lineAnalyze(sheetId, buf, mime, categories);

    // 解析結果 → 経費データ
    const data = _lineParsedToData(parsed, categories);
    data.imageLink = driveInfo.webViewLink || '';

    // 監査チェック（既存経費と突合）
    const expenses = await readExpensesViaSA(sheetId).catch(() => []);
    const alerts = _serverAuditChecks(expenses, data, [imageHash]);

    // pending 保存（TTL10分）
    await kv.set(`line:pending:${userId}`, {
      data, imageHash, driveFileId: driveInfo.id, imageLink: data.imageLink,
      alerts, aiAmount: data.aiAmount, step: 'confirm',
    }, { ex: 600 }).catch(() => {});

    return _lineReply(replyToken, _lineText(
      _lineSummary(data, alerts), _confirmQuick()
    ));
  } catch (e) {
    console.error('line image error:', e?.message || e);
    return _lineReply(replyToken, _lineText('画像の解析に失敗しました。もう一度お試しいただくか、明るくはっきりした画像でお送りください。'));
  }
}

/** SAで証票フォルダ(設定B4)へ画像を保存。 */
async function _lineUploadReceipt(sheetId, buf, mime) {
  const sheets = sheetsClient();
  const cfg = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: '設定!B4' });
  const folderId = cfg.data.values?.[0]?.[0] || '';
  if (!folderId) throw new Error('証票フォルダ(設定B4)未設定');
  const ext = mime.includes('png') ? 'png' : mime.includes('pdf') ? 'pdf' : 'jpg';
  const drive = driveClient();
  const created = await drive.files.create({
    requestBody: { name: `LINE_${Date.now()}.${ext}`, mimeType: mime, parents: [folderId] },
    media: { mimeType: mime, body: bufferToStream(buf) },
    fields: 'id, webViewLink',
  });
  return { id: created.data.id, webViewLink: created.data.webViewLink };
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
  "total_amount": 金額（日本円の場合）またはnull（外貨の場合）,
  "category": "勘定科目（単一カテゴリの場合）",
  "category_fallback": true または false,
  "items": [{"amount": 金額（合算後）, "category": "勘定科目", "tax_rate": "課税10%/課税8%/非課税/不課税のいずれか"}] または null,
  "fx_currency": "USD/EUR等の通貨コードまたはnull",
  "fx_amount": 外貨金額またはnull,
  "tax_rate": "課税10%/課税8%/混在/非課税/不課税のいずれか",
  "withholding_amount": 源泉徴収税額（整数）またはnull
}

注意：
- 金額が日本円なら total_amount に数値を入れ fx_* は null
- total_amount は「税込み費用計上額（源泉徴収控除前）」を入れること
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

/** Gemini解析JSON → 経費データ（G列科目フォーマット・S列税区分を組む）。 */
function _lineParsedToData(g, categories) {
  const valid = new Set(categories);
  const pickCat = (c) => (c && valid.has(c)) ? c : categories[0];

  let amount = 0, category = '', taxRate = '課税10%';
  if (Array.isArray(g.items) && g.items.length) {
    // 分割: "科目:金額:税率/..." 形式（parseSplitCategory と対称）
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
    amount = Math.round(Number(g.total_amount) || 0);
    category = pickCat(g.category);
    taxRate = g.tax_rate && g.tax_rate !== '混在' ? g.tax_rate : '課税10%';
  }

  const withholding = Math.round(Number(g.withholding_amount) || 0);
  const fxNote = (!g.total_amount && g.fx_amount)
    ? `外貨: ${g.fx_currency || ''} ${g.fx_amount}（金額は「修正する」で入力してください）` : '';

  return {
    date:    _validDateStr(g.date) ? g.date : _todayJst(),
    place:   String(g.shop || '').slice(0, 100),
    amount,
    category,
    note:    fxNote,
    invoice: String(g.invoice && g.invoice !== 'null' ? g.invoice : '').trim(),
    taxRate,
    withholding,
    aiAmount: amount,  // 解析時点の金額＝AI解析額（N列・手修正検知の基準）
  };
}

function _validDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function _todayJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** 確認画面のテキスト（解析結果＋監査アラート）。 */
function _lineSummary(data, alerts) {
  const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');
  const catLabel = data.category.split('/').map(seg => {
    const p = seg.split(':');
    return p.length >= 2 ? `${p[0]}(${yen(p[1])})` : p[0];
  }).join(' / ');
  const lines = [
    '【内容を確認してください】',
    `日付: ${data.date}`,
    `支払先: ${data.place || '(不明)'}`,
    `金額: ${yen(data.amount)}`,
    `科目: ${catLabel || '(未設定)'}`,
    `税区分: ${data.taxRate}`,
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

/* ── postback（登録/修正/やめる/項目選択） ── */

async function _handleLinePostback(userId, replyToken, dataStr) {
  const params = new URLSearchParams(dataStr);
  const action = params.get('action');
  const pending = await kv.get(`line:pending:${userId}`).catch(() => null);

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
      _qpPostback('日付',   'action=editfield&f=date'),
      _qpPostback('支払先', 'action=editfield&f=place'),
      _qpPostback('金額',   'action=editfield&f=amount'),
      _qpPostback('科目',   'action=editfield&f=category'),
      _qpPostback('戻る',   'action=editback'),
    ]));
  }
  if (action === 'editback') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    return _lineReply(replyToken, _lineText(_lineSummary(pending.data, pending.alerts), _confirmQuick()));
  }
  if (action === 'editfield') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    const f = params.get('f');
    // 科目はボタン選択（マスタのカテゴリ）にする
    if (f === 'category') {
      const link = await _lineLink(userId);
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
    const labels = { date: '日付（例: 2026-07-05）', place: '支払先', amount: '金額（数字）', category: '科目' };
    return _lineReply(replyToken, _lineText(`新しい「${labels[f] || f}」を送ってください。`));
  }
  if (action === 'setcat') {
    if (!pending) return _lineReply(replyToken, _lineText('時間切れです。もう一度画像を送ってください。'));
    const c = params.get('c') || '';
    pending.data.category = c;  // 単一科目に置換
    delete pending.step; delete pending.editField;
    pending.alerts = await _reauditPending(userId, pending);
    await kv.set(`line:pending:${userId}`, pending, { ex: 600 }).catch(() => {});
    return _lineReply(replyToken, _lineText(_lineSummary(pending.data, pending.alerts), _confirmQuick()));
  }
  return _lineReply(replyToken, _lineText('もう一度画像を送ってください。'));
}

/** 修正値の反映（テキスト入力）。 */
async function _applyLineEdit(userId, replyToken, pending, text) {
  const f = pending.editField;
  const d = pending.data;
  if (f === 'date') {
    const v = text.replace(/[／.]/g, '-').replace(/[^\d-]/g, '');
    if (!_validDateStr(v)) return _lineReply(replyToken, _lineText('日付は YYYY-MM-DD 形式で送ってください（例: 2026-07-05）。'));
    d.date = v;
  } else if (f === 'place') {
    d.place = text.slice(0, 100);
  } else if (f === 'amount') {
    const n = Number(text.replace(/[^\d]/g, ''));
    if (!n || n < 1) return _lineReply(replyToken, _lineText('金額は1以上の数字で送ってください。'));
    d.amount = n;
    // 単一科目なら分割表記も金額を追従
    if (d.category && !d.category.includes('/') && d.category.includes(':')) {
      const p = d.category.split(':'); d.category = `${p[0]}:${n}:${p[2] || d.taxRate}`;
    }
  } else if (f === 'category') {
    d.category = text.slice(0, 60);
  }
  delete pending.step; delete pending.editField;
  pending.alerts = await _reauditPending(userId, pending);
  await kv.set(`line:pending:${userId}`, pending, { ex: 600 }).catch(() => {});
  return _lineReply(replyToken, _lineText(_lineSummary(d, pending.alerts), _confirmQuick()));
}

/** 修正後に監査を再実行（AI解析額との不一致等が変わるため）。 */
async function _reauditPending(userId, pending) {
  try {
    const link = await _lineLink(userId);
    if (!link) return pending.alerts || [];
    const expenses = await readExpensesViaSA(link.sheetId).catch(() => []);
    return _serverAuditChecks(expenses, { ...pending.data, aiAmount: pending.aiAmount }, [pending.imageHash]);
  } catch (_) { return pending.alerts || []; }
}

/** 登録実行（申請済で経費一覧へ）。 */
async function _lineRegister(userId, replyToken, pending) {
  const link = await _lineLink(userId);
  if (!link) return _lineReply(replyToken, _lineText('連携が切れています。連携コードを送信してください。'));
  const { sheetId, identity } = link;

  if (!(await _isTeamPlanActive(sheetId))) {
    return _lineReply(replyToken, _lineText('LINE連携はチームプランでご利用いただけます。'));
  }
  const name = await _lineMemberName(sheetId, identity);
  if (name === null) return _lineReply(replyToken, _lineText('メンバー登録が見つかりません。管理者にご確認ください。'));

  const d = pending.data;
  const aiAudit = (pending.alerts && pending.alerts.length) ? ('⛔ ' + pending.alerts.join(' / ')) : '';
  const imageLink = pending.imageLink || '';
  const row = [
    _nowJst(),                                  // A: 申請日時（サーバー時刻）
    name,                                       // B: 名前
    '領収書',                                   // C: タイプ
    d.date,                                     // D: 日付
    d.place,                                    // E: 支払先
    d.amount,                                   // F: 金額
    d.category,                                 // G: 勘定科目
    d.note || '',                               // H: 備考
    imageLink ? `=HYPERLINK("${imageLink}","証票")` : '', // I: 証票
    false,                                      // J: 承認（LINEからは常に未承認）
    aiAudit,                                    // K: 監査
    '',                                         // L: 精算日
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
    return _lineReply(replyToken, _lineText(
      `登録しました（申請済）。\n${d.date} ${d.place} ¥${Number(d.amount).toLocaleString('ja-JP')}` +
      (aiAudit ? '\n※確認事項ありのため管理者が内容を確認します。' : '')
    ));
  } catch (e) {
    console.error('line register error:', e?.message || e);
    return _lineReply(replyToken, _lineText('登録に失敗しました。時間をおいて再度お試しください。'));
  }
}

/* ── 未精算一覧 ── */

async function _handleLineUnsettled(userId, replyToken) {
  const link = await _lineLink(userId);
  if (!link) return _lineReply(replyToken, _lineText('未連携です。連携コードを送信してください。'));
  const { sheetId, identity } = link;

  const name = await _lineMemberName(sheetId, identity);
  if (name === null) return _lineReply(replyToken, _lineText('メンバー登録が見つかりません。'));

  const idLower = String(identity).toLowerCase();
  const expenses = await readExpensesViaSA(sheetId).catch(() => []);
  // 自分の・未精算（L列空）のみ
  const mine = expenses.filter(e =>
    String(e.email).toLowerCase() === idLower &&
    !(e.settlementDate && String(e.settlementDate).trim() !== '')
  );
  if (!mine.length) return _lineReply(replyToken, _lineText('未精算の経費はありません。'));

  mine.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const total = mine.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const N = 10;
  const shown = mine.slice(0, N).map(e =>
    `・${e.date} ${String(e.place || '').slice(0, 16)} ¥${Number(e.amount).toLocaleString('ja-JP')}`
  );
  const head = `未精算 ${mine.length}件 / 合計 ¥${total.toLocaleString('ja-JP')}`;
  const more = mine.length > N ? `\n…ほか${mine.length - N}件` : '';
  return _lineReply(replyToken, _lineText([head, '', ...shown].join('\n') + more));
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
 * POST /api/data/line/code   body: { sheetId, identity, name }
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
    // 既存メンバーか確認
    const nm = await _lineMemberName(authz.sheetId, identity);
    if (nm === null) return res.status(400).json({ error: 'not_a_member', message: 'そのメールはマスタ表にありません' });
  }

  // 6桁コード生成（衝突は極めて稀・使い捨て24h）
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await kv.set(`line:code:${code}`, {
    sheetId: authz.sheetId, identity, name,
  }, { ex: 86400 }).catch(() => {});

  return res.status(200).json({ ok: true, code, name, identity, expiresInHours: 24 });
}

/**
 * POST /api/data/line/unlink  body: { sheetId, userId } または { identity }
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

  let removed = 0;
  if (userId) {
    const link = await kv.get(`line:link:${userId}`).catch(() => null);
    if (link && link.sheetId === sheetId) {
      await kv.del(`line:link:${userId}`).catch(() => {});
      await kv.srem(`line:link_by_sheet:${sheetId}`, userId).catch(() => {});
      removed++;
    }
  } else if (identity) {
    // identity 指定 → このシートの全 userId を走査して該当を解除
    const ids = await kv.smembers(`line:link_by_sheet:${sheetId}`).catch(() => []);
    for (const uid of (ids || [])) {
      const link = await kv.get(`line:link:${uid}`).catch(() => null);
      if (link && String(link.identity).toLowerCase() === identity) {
        await kv.del(`line:link:${uid}`).catch(() => {});
        await kv.srem(`line:link_by_sheet:${sheetId}`, uid).catch(() => {});
        removed++;
      }
    }
  } else {
    return res.status(400).json({ error: 'userId_or_identity_required' });
  }

  return res.status(200).json({ ok: true, removed });
}
