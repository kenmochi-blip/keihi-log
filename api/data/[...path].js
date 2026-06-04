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
import { kv } from '@vercel/kv';
import { sheetsClient, isSaConfigured } from '../_sa.js';
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

  const master = await readMaster(sheetId);
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
  if (req.method === 'GET')  return expensesGet(req, res);
  if (req.method === 'POST') return expensesCreate(req, res);
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
  return res.status(200).json({
    expenses: rows,
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

  await prependExpenseRowViaSA(sheetId, r);
  await kv.del(`data:exp:${sheetId}`).catch(() => {}); // 一覧キャッシュ無効化

  return res.status(200).json({ ok: true, id: r[16] });
}

/**
 * GET /api/data/masters?sheetId=XXX
 *   マスタ表（メンバー/勘定科目/支払元/カスタムフラグ/admin判定）を SA 経由で取得する。
 *   メンバーであれば全員が同じマスタを取得する（アプリ動作に必要なため）。
 */
async function masters(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const authz = await _authorize(req, res);
  if (!authz) return;
  // _authorize が読んだマスタをそのまま返す（追加のAPIコールを避ける）
  return res.status(200).json({ master: authz.master });
}

/**
 * GET /api/data/settings?sheetId=XXX
 *   設定シートを SA 経由で取得する。
 *   ★ B5（Gemini APIキー）はブラウザに返さない（B'の趣旨：鍵はサーバー側に留める）。
 *     管理者の鍵設定/更新や Gemini 実行は別エンドポイントで扱う（後続実装）。
 *   返却: B2会社名 / B3ライセンス / B4フォルダID / B6 / B7、および hasGeminiKey。
 */
async function settings(req, res) {
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
    settlementDate: row[11] != null && row[11] !== '' ? String(row[11]) : '',
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

function _validSheetId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{20,}$/.test(id);
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
