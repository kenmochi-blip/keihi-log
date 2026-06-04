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
      case 'masters':
        return await masters(req, res);
      case 'settings':
        return await settings(req, res);
      case 'receipt':
        return await receipt(req, res);
      case 'gemini':
        return await gemini(req, res);
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
    master = await readMaster(sheetId);
  } catch (e) {
    // SA がシートにアクセスできない場合（共有未設定など）は 503 を返す（500 ではなくプロキシ失敗と明示）
    res.status(503).json({ error: 'sa_sheet_access_failed', message: e.message || 'SA cannot read sheet' });
    return null;
  }
  const isAdmin = master.admins.includes(me.email);
  const isMember = isAdmin || master.members.some(m => m.email === me.email);
  if (!isMember) { res.status(403).json({ error: 'not_a_member' }); return null; }

  return { me, isAdmin, master, sheetId };
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

  const sheetId = _query(req).get('sheetId');

  try {
    const auth = getSaAuth();
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    const base = {
      saConfigured: true,
      authenticated: !!token?.token,
      serviceAccountEmail: client.email || null,
    };

    // 共有検証プローブ（PIIなし）
    if (sheetId && _validSheetId(sheetId)) {
      const sheets = sheetsClient();
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: sheetId,
        fields: 'properties.title,sheets.properties.title',
      });
      const tabs = (meta.data.sheets || []).map(s => s.properties.title);
      const master = await readMaster(sheetId);
      const exp = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId, range: '経費一覧!A2:A',
      }).catch(() => ({ data: {} }));
      base.sheetProbe = {
        canRead: true,
        title: meta.data.properties?.title || '',
        tabs,
        memberCount: master.members.length,
        adminCount: master.admins.length,
        expenseRowCount: (exp.data.values || []).length,
      };
    }
    return res.status(200).json(base);
  } catch (e) {
    return res.status(200).json({
      saConfigured: true,
      authenticated: false,
      ...(sheetId ? { sheetProbe: { canRead: false, error: e.message || 'read_failed' } } : {}),
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
  const { me, isAdmin, sheetId } = authz;
  const refresh = _query(req).get('refresh') === '1';

  // キャッシュ（全件）→ レスポンス時にロール別フィルタ
  const cacheKey = `data:exp:${sheetId}`;
  let all = null;
  if (!refresh) all = await kv.get(cacheKey).catch(() => null);
  let cached = !!all;
  if (!all) {
    all = await readExpensesViaSA(sheetId);
    await kv.set(cacheKey, all, { ex: 60 }).catch(() => {});
    cached = false;
  }

  const rows = isAdmin ? all : all.filter(e => (e.email || '').toLowerCase() === me.email);
  // 証票リンク（Drive URL）を署名付きプロキシURLへ書き換える。
  // 署名は「このメンバーが閲覧できる経費」にのみ発行されるため、他人の証票URLは取得できない。
  // キャッシュ済みオブジェクトは変更せずシャローコピーで返す（署名はリクエスト毎に再発行）。
  const signed = rows.map(e => e.imageLinks ? { ...e, imageLinks: _signImageLinks(e.imageLinks) } : e);
  return res.status(200).json({
    expenses: signed,
    role: isAdmin ? 'admin' : 'member',
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

  await prependExpenseRowViaSA(sheetId, r);
  await kv.del(`data:exp:${sheetId}`).catch(() => {}); // 一覧キャッシュ無効化

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

  const found = await _getExpenseByIdViaSA(sheetId, id);
  if (!found) return res.status(404).json({ error: 'not_found' });
  if (!_canModify(me, isAdmin, found.raw)) return res.status(403).json({ error: 'forbidden' });

  const r = row.slice(0, 21);
  while (r.length < 21) r.push('');
  // 整合性: 所有者(P)は元のまま維持（編集者で上書きしない）、承認(J)は admin のみ true 可
  r[15] = found.raw[15] || me.email;
  r[9]  = isAdmin ? (r[9] === true || r[9] === 'TRUE') : false;
  r[16] = id;
  r[8]  = _normalizeImageLinks(r[8]);     // I: 署名付きプロキシURL→永続Drive URLへ戻す

  // 修正履歴に旧データの要約を残す
  const o = found.raw;
  const oldSummary = [
    `日付: ${o[3] || ''}`, `支払先: ${o[4] || ''}`, `金額: ${o[5] || ''}`,
    `科目: ${o[6] || ''}`, `タイプ: ${o[2] || ''}`, `備考: ${o[7] || ''}`,
    `精算日: ${o[11] || ''}`, `インボイス: ${o[12] || ''}`, `税区分: ${o[18] || ''}`,
  ].filter(s => !s.endsWith(': ')).join(' / ');

  await prependRowViaSA(sheetId, '修正履歴', [_nowJst(), me.email, oldSummary]);
  await updateRangeViaSA(sheetId, `経費一覧!A${found.rowNum}:U${found.rowNum}`, [r]);
  await kv.del(`data:exp:${sheetId}`).catch(() => {});

  return res.status(200).json({ ok: true, id });
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

  const found = await _getExpenseByIdViaSA(sheetId, id);
  if (!found) return res.status(404).json({ error: 'not_found' });

  // 精算済（実精算＝会社払いマーカー以外の精算日）は削除禁止（電帳法）
  if (_isRealSettled(found.raw)) return res.status(403).json({ error: 'settled_locked' });
  if (!_canModify(me, isAdmin, found.raw)) return res.status(403).json({ error: 'forbidden' });

  const raw21 = found.raw.slice(0, 21);
  while (raw21.length < 21) raw21.push('');
  await prependRowViaSA(sheetId, '削除一覧', [_nowJst(), me.email, ...raw21]);
  await deleteRowViaSA(sheetId, '経費一覧', found.rowNum);
  await kv.del(`data:exp:${sheetId}`).catch(() => {});

  return res.status(200).json({ ok: true, id });
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

  const rowNums = await _rowNumsByIds(authz.sheetId, ids);
  const data = rowNums.map(n => ({ range: `経費一覧!J${n}`, values: [[true]] }));
  if (data.length) await batchUpdateValuesViaSA(authz.sheetId, data);
  await kv.del(`data:exp:${authz.sheetId}`).catch(() => {});

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

  const rowNums = await _rowNumsByIds(authz.sheetId, ids);
  const data = rowNums.map(n => ({ range: `経費一覧!L${n}`, values: [[String(date)]] }));
  if (data.length) await batchUpdateValuesViaSA(authz.sheetId, data);
  await kv.del(`data:exp:${authz.sheetId}`).catch(() => {});

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
  await kv.del(`data:exp:${authz.sheetId}`).catch(() => {});

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

  const { rows } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows_required' });

  const sheetId = authz.sheetId;
  // 既存データを全消去してから書き込む（削除時の残留行を防ぐ）
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: 'マスタ表!A2:H' });
  if (rows.length > 0) {
    await updateRangeViaSA(sheetId, `マスタ表!A2:H${rows.length + 1}`, rows);
  }
  return res.status(200).json({ ok: true });
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

  const sheets = sheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: authz.sheetId, range: '設定!B2:B7',
  });
  const rows = resp.data.values || [];
  const cell = i => rows?.[i]?.[0] ?? '';
  return res.status(200).json({
    settings: {
      B2: cell(0),            // 会社名
      B3: cell(1),            // ライセンスキー
      B4: cell(2),            // フォルダID
      B5: '',                 // Gemini APIキーは返さない（秘匿）
      B6: cell(4),
      B7: cell(5),
    },
    hasGeminiKey: !!cell(3),  // B5 の有無のみ通知
  });
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

  // 証票フォルダID（設定!B4）を SA で取得
  const sheets = sheetsClient();
  const cfg = await sheets.spreadsheets.values.get({
    spreadsheetId: authz.sheetId, range: '設定!B4',
  });
  const folderId = cfg.data.values?.[0]?.[0] || '';

  const clean = base64.replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(clean, 'base64');
  const drive = driveClient();
  const created = await drive.files.create({
    requestBody: { name: filename, mimeType, ...(folderId ? { parents: [folderId] } : {}) },
    media: { mimeType, body: bufferToStream(buf) },
    fields: 'id, webViewLink',
  });

  return res.status(200).json({ id: created.data.id, webViewLink: created.data.webViewLink });
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

  const sheets = sheetsClient();
  const cfg = await sheets.spreadsheets.values.get({
    spreadsheetId: authz.sheetId, range: '設定!B5',
  });
  const apiKey = cfg.data.values?.[0]?.[0] || '';
  if (!apiKey) return res.status(400).json({ error: 'no_gemini_key' });

  const body = await _body(req);
  if (!body?.contents) return res.status(400).json({ error: 'invalid_request' });

  const MODEL = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({}));
  // 鍵が含まれ得るエラー詳細はそのまま返さず、ステータスのみ透過
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: 'gemini_error', message: data?.error?.message || '' });
  }
  return res.status(200).json(data);
}

/** カンマ区切りの証票URL群を署名付きプロキシURLへ書き換える。抽出不能URLは原文維持。 */
function _signImageLinks(links) {
  const exp = Date.now() + 24 * 3600 * 1000;
  return String(links).split(',').map(s => s.trim()).filter(Boolean).map(url => {
    const id = _driveFileId(url);
    if (!id) return url;
    return `/api/data/receipt?fileId=${encodeURIComponent(id)}&exp=${exp}&sig=${_signReceipt(id, exp)}`;
  }).join(',');
}

/* ───────────────────────── SA データアクセス ───────────────────────── */

/** マスタ表 A2:H を SA で読み、クライアントの readMaster と同一形のオブジェクトを返す。
 *  A:氏名 B:メール C:所属 D:権限 E:備考 F:会社払い支払元 G:勘定科目 H:カスタムフラグ */
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

/** リクエストボディを JSON として取得する。Vercel が既にパース済みなら req.body を使う。 */
async function _body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return null; } }
  // ストリームから読む（フォールバック）
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (_) { return null; }
}

function _uuid() {
  try { return crypto.randomUUID(); } catch (_) {}
  // フォールバック（古いランタイム用）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
