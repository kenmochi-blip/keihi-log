/**
 * Google Sheets API ラッパー
 * すべての操作はユーザー自身のアクセストークンで実行される
 */
const Sheets = (() => {

  function _ssId() {
    const id = localStorage.getItem('keihi_sheet_id');
    if (!id) throw new Error('スプレッドシートIDが設定されていません。設定画面で入力してください。');
    return id;
  }

  const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

  /** 範囲を読み込む。値の2次元配列を返す。 */
  async function read(range, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      // デモ：経費一覧の単一行リクエスト（修正履歴の旧データ取得など）はEXPENSESから再構築
      const m = range.match(/^経費一覧!A(\d+):R\1$/);
      if (m) {
        const idx = Number(m[1]) - 2; // ヘッダー行ぶん -2
        const e = Demo.EXPENSES[idx];
        if (e) return [expenseToRow(e)];
      }
      return [];
    }
    ssId = ssId || _ssId();
    const resp = await Auth.authFetch(
      `${BASE}/${ssId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`
    );
    if (!resp.ok) throw new Error(`Sheets read error: ${resp.status}`);
    const data = await resp.json();
    return data.values || [];
  }

  /** 行を末尾に追記する。 */
  async function append(sheetName, values, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return { updates: { updatedRows: 1 } };
    ssId = ssId || _ssId();
    const range = `${sheetName}!A1`;
    const resp = await Auth.authFetch(
      `${BASE}/${ssId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [values] })
      }
    );
    if (!resp.ok) throw new Error(`Sheets append error: ${resp.status}`);
    return resp.json();
  }

  /** 指定セル範囲を上書きする。 */
  async function update(range, values, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return {};
    ssId = ssId || _ssId();
    const resp = await Auth.authFetch(
      `${BASE}/${ssId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values })
      }
    );
    if (!resp.ok) throw new Error(`Sheets update error: ${resp.status}`);
    return resp.json();
  }

  /** 複数の更新をバッチで送る。 */
  async function batchUpdate(requests, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return {};
    ssId = ssId || _ssId();
    const resp = await Auth.authFetch(
      `${BASE}/${ssId}:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
      }
    );
    if (!resp.ok) throw new Error(`Sheets batchUpdate error: ${resp.status}`);
    return resp.json();
  }

  /** 行番号（1始まり）を指定して行を削除する。 */
  async function deleteRow(sheetId, rowIndex, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return {};
    return batchUpdate([{
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: rowIndex - 1,
          endIndex: rowIndex
        }
      }
    }], ssId);
  }

  /** 経費一覧シートから全行を読み込んでオブジェクト配列に変換する。
   *  spreadsheets.get + hyperlink フィールドを使うことで Insert→Link 形式の
   *  ハイパーリンクセルも正しくURLを取得できる（values.get では表示テキストしか得られない）。
   */
  async function readExpenses(ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return [...Demo.EXPENSES];
    ssId = ssId || _ssId();
    const range  = encodeURIComponent('経費一覧!A2:R');
    const fields = encodeURIComponent('sheets.data.rowData.values(effectiveValue,hyperlink)');
    const resp = await Auth.authFetch(`${BASE}/${ssId}?ranges=${range}&fields=${fields}`);
    if (!resp.ok) throw new Error(`Sheets readExpenses error: ${resp.status}`);
    const data = await resp.json();
    const rowDataList = data.sheets?.[0]?.data?.[0]?.rowData || [];
    return rowDataList.map(rowData => {
      const cells = rowData.values || [];
      const row = cells.map((cell, i) => {
        // I列（index 8）: Insert→Link / =HYPERLINK() どちらもhyperlinkフィールドでURL取得
        if (i === 8 && cell?.hyperlink) return cell.hyperlink;
        const ev = cell?.effectiveValue;
        if (!ev) return '';
        if ('boolValue'   in ev) return ev.boolValue;
        if ('numberValue' in ev) return ev.numberValue;
        if ('stringValue' in ev) return ev.stringValue;
        return '';
      });
      return _rowToExpense(row);
    }).filter(e => e.id);
  }

  /** =HYPERLINK("url","text") 式からURLを取り出す。プレーンURLはそのまま返す。 */
  function _extractUrl(val) {
    if (!val) return '';
    const s = String(val);
    const m = s.match(/^=HYPERLINK\(["']([^"']+)["']/i);
    return m ? m[1] : s;
  }

  /** URLをHYPERLINK式に変換してSS上でクリック可能にする。複数URLはそのまま。 */
  function _toHyperlink(links) {
    if (!links) return '';
    const s = String(links);
    if (s.startsWith('=HYPERLINK(')) return s;
    const urls = s.split(',').map(u => u.trim()).filter(Boolean);
    if (urls.length === 0) return '';
    if (urls.length === 1) return `=HYPERLINK("${urls[0]}","証票")`;
    return links; // 複数URLはプレーンテキストのまま（アプリ側で複数ボタン表示）
  }

  /** 行配列 → 経費オブジェクト */
  function _rowToExpense(row) {
    return {
      appliedAt:      row[0]  || '',
      name:           row[1]  || '',
      type:           row[2]  || '',
      date:           _parseSheetDate(row[3]),
      place:          row[4]  || '',
      amount:         Number(row[5]) || 0,
      category:       row[6]  || '',
      note:           row[7]  || '',
      imageLinks:     _extractUrl(row[8] || ''),
      confirmed:      row[9]  === true || row[9] === 'TRUE',
      aiAudit:        row[10] || '',
      settlementDate: row[11] != null && row[11] !== '' ? String(row[11]) : '',  // L列：精算日
      invoice:        row[12] || '',
      aiAmount:       Number(row[13]) || 0,
      imageHash:      row[14] || '',
      email:          row[15] || '',
      id:             row[16] || '',
      device:         row[17] || '',
    };
  }

  /** Google Sheetsのシリアル日付値またはISO文字列をYYYY-MM-DDに変換 */
  function _parseSheetDate(val) {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'number') {
      // Sheetsシリアル値: 1900-01-01 = 1, Unixエポック = 25569
      const d = new Date(Math.round((val - 25569) * 86400000));
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return String(val);
  }

  /** 経費オブジェクト → 行配列（18列）*/
  function expenseToRow(e) {
    return [
      e.appliedAt,                 // A
      e.name,                      // B
      e.type,                      // C
      e.date,                      // D
      e.place,                     // E
      e.amount,                    // F
      e.category,                  // G
      e.note,                      // H
      _toHyperlink(e.imageLinks),  // I
      e.confirmed ? true : false,  // J
      e.aiAudit,                   // K
      e.settlementDate || '',      // L：精算日
      e.invoice,                   // M
      e.aiAmount,                  // N
      e.imageHash,                 // O
      e.email,                     // P
      e.id,                        // Q
      e.device,                    // R
    ];
  }

  /**
   * UUIDで行番号（1始まり、ヘッダー含む）を検索する。
   * 見つからない場合は -1 を返す。
   */
  async function findRowById(id, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      const idx = Demo.EXPENSES.findIndex(e => e.id === id);
      return idx === -1 ? -1 : idx + 2;
    }
    const rows = await read('経費一覧!Q2:Q', ssId);
    const idx = rows.findIndex(r => r[0] === id);
    return idx === -1 ? -1 : idx + 2; // ヘッダー行(1) + 0-index補正
  }

  /** 設定シートから指定セルの値を読む */
  async function readSetting(cell, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      if (cell === 'B2') return 'デモ会社';
      return '';
    }
    const rows = await read(`設定!${cell}`, ssId);
    return rows?.[0]?.[0] ?? '';
  }

  /** マスタ表を読んでメンバー・カテゴリ・支払元を返す */
  async function readMaster(ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return Demo.MASTER;
    const rows = await read('マスタ表!A2:G', ssId);
    const members    = [];
    const categories = [];
    const paySources = [];
    const admins     = [];
    const viewers    = [];

    rows.forEach(r => {
      // A:氏名 B:メール C:所属 D:権限 E:備考 F:会社払い支払元 G:勘定科目
      if (r[0] || r[1]) members.push({ name: r[0] || '', email: r[1] || '', dept: r[2] || '', role: r[3] || '' });
      if (r[5]) paySources.push(r[5]);
      if (r[6]) categories.push(r[6]);
      const role = (r[3] || '').toLowerCase();
      if (role === 'admin' && r[1]) admins.push(r[1].toLowerCase());
      if (role === 'viewer' && r[1]) viewers.push(r[1].toLowerCase());
    });

    return {
      members,
      categories: [...new Set(categories)],
      paySources: [...new Set(paySources)],
      admins,
      viewers,
    };
  }

  /** 複数範囲を一括上書きする（名前同期などに使用）*/
  async function batchUpdateValues(data, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return {};
    ssId = ssId || _ssId();
    const resp = await Auth.authFetch(
      `${BASE}/${ssId}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
      }
    );
    if (!resp.ok) throw new Error(`Sheets batchUpdateValues error: ${resp.status}`);
    return resp.json();
  }

  /** シート名 → sheetId のマップを返す */
  async function _getSheetId(sheetName, ssId) {
    const resp = await Auth.authFetch(`${BASE}/${ssId}?fields=sheets.properties`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const sheet = data.sheets.find(s => s.properties.title === sheetName);
    return sheet ? sheet.properties.sheetId : null;
  }

  /**
   * 経費一覧に追記した後、行の書式をリセットし金額列をカンマ右寄せにする
   * @param {string} updatedRange  append レスポンスの updates.updatedRange
   */
  async function formatExpenseRow(updatedRange, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return;
    ssId = ssId || _ssId();
    const match = updatedRange.match(/!A(\d+):/);
    if (!match) return;
    const rowIdx = parseInt(match[1], 10) - 1; // 0-based

    const sheetId = await _getSheetId('経費一覧', ssId);
    if (sheetId === null) return;

    const rowRange = { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1 };
    const amountCols = [5, 13]; // F列（金額）・N列（AI解析額）
    const dateFmts = [
      { col: 0, pattern: 'yyyy-mm-dd hh:mm:ss' }, // A列（申請日時）
      { col: 3, pattern: 'yyyy-mm-dd' },           // D列（日付）
    ];

    await batchUpdate([
      // 行全体の書式をリセット（ヘッダー色の引き継ぎを除去）
      {
        repeatCell: {
          range: rowRange,
          cell: { userEnteredFormat: {} },
          fields: 'userEnteredFormat',
        }
      },
      // 金額列に #,##0 フォーマットと右寄せを適用
      ...amountCols.map(col => ({
        repeatCell: {
          range: { ...rowRange, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'NUMBER', pattern: '#,##0' },
              horizontalAlignment: 'RIGHT',
            }
          },
          fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
        }
      })),
      // 日付列に日付フォーマットを適用（USER_ENTEREDでシリアル値変換されても正しく表示）
      ...dateFmts.map(({ col, pattern }) => ({
        repeatCell: {
          range: { ...rowRange, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'DATE_TIME', pattern },
            }
          },
          fields: 'userEnteredFormat(numberFormat)',
        }
      })),
    ], ssId);
  }

  /**
   * 指定IDの経費を一括精算済みにする（S列に精算日を書き込む）
   * @param {string[]} ids  精算対象の expense ID 配列
   * @param {string}   dateStr  精算日文字列（例: '2026-05-12'）
   */
  async function batchSettle(ids, dateStr, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return {};
    if (!ids.length) return {};
    ssId = ssId || _ssId();
    const qRows = await read('経費一覧!Q2:Q', ssId);
    const updates = [];
    ids.forEach(id => {
      const idx = qRows.findIndex(r => r[0] === id);
      if (idx !== -1) {
        updates.push({ range: `経費一覧!L${idx + 2}`, values: [[dateStr]] });
      }
    });
    if (!updates.length) return {};
    return batchUpdateValues(updates, ssId);
  }

  /**
   * 経費一覧の先頭（ヘッダー直下の2行目）に新規行を挿入する。
   * append と異なり最新データが常に先頭に並ぶ。
   */
  async function prependRow(sheetName, values, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return {};
    ssId = ssId || _ssId();
    const sheetId = await _getSheetId(sheetName, ssId);
    if (sheetId === null) throw new Error(`${sheetName}シートが見つかりません`);
    // ヘッダー直下に書式を引き継がない空行を挿入
    await batchUpdate([{
      insertDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
        inheritFromBefore: false,
      }
    }], ssId);
    await update(`${sheetName}!A2`, [values], ssId);
  }

  async function prependExpense(row, ssId) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      return { updates: { updatedRange: '経費一覧!A2:R2' } };
    }
    ssId = ssId || _ssId();
    const sheetId = await _getSheetId('経費一覧', ssId);
    if (sheetId === null) throw new Error('経費一覧シートが見つかりません');

    // ヘッダー行(index 0)の直下に空行を挿入
    await batchUpdate([{
      insertDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
        inheritFromBefore: false,
      }
    }], ssId);

    // 挿入した行にデータを書き込む
    await update('経費一覧!A2:R2', [row], ssId);

    await formatExpenseRow('経費一覧!A2:R2', ssId);
    return { updates: { updatedRange: '経費一覧!A2:R2' } };
  }

  return {
    read,
    append,
    update,
    batchUpdate,
    batchUpdateValues,
    deleteRow,
    readExpenses,
    expenseToRow,
    findRowById,
    formatExpenseRow,
    prependExpense,
    prependRow,
    batchSettle,
    readSetting,
    readMaster,
    _rowToExpense,
  };
})();
