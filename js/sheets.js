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

  /** 経費一覧シートから全行を読み込んでオブジェクト配列に変換する。 */
  async function readExpenses(ssId) {
    const rows = await read('経費一覧!A2:R', ssId);
    return rows.map(_rowToExpense).filter(e => e.id); // IDがない行はスキップ
  }

  /** 行配列 → 経費オブジェクト */
  function _rowToExpense(row) {
    return {
      appliedAt:   row[0]  || '',
      name:        row[1]  || '',
      type:        row[2]  || '',
      date:        _parseSheetDate(row[3]),
      place:       row[4]  || '',
      amount:      Number(row[5]) || 0,
      category:    row[6]  || '',
      note:        row[7]  || '',
      imageLinks:  row[8]  || '',
      confirmed:   row[9]  === true || row[9] === 'TRUE',
      aiAudit:     row[10] || '',
      payment:     row[11] || '',
      invoice:     row[12] || '',
      aiAmount:    Number(row[13]) || 0,
      imageHash:   row[14] || '',
      email:       row[15] || '',
      id:          row[16] || '',
      device:      row[17] || '',
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
      e.appliedAt,   // A
      e.name,        // B
      e.type,        // C
      e.date,        // D
      e.place,       // E
      e.amount,      // F
      e.category,    // G
      e.note,        // H
      e.imageLinks,  // I
      e.confirmed ? true : false, // J
      e.aiAudit,     // K
      e.payment,     // L
      e.invoice,     // M
      e.aiAmount,    // N
      e.imageHash,   // O
      e.email,       // P
      e.id,          // Q
      e.device,      // R
    ];
  }

  /**
   * UUIDで行番号（1始まり、ヘッダー含む）を検索する。
   * 見つからない場合は -1 を返す。
   */
  async function findRowById(id, ssId) {
    const rows = await read('経費一覧!Q2:Q', ssId);
    const idx = rows.findIndex(r => r[0] === id);
    return idx === -1 ? -1 : idx + 2; // ヘッダー行(1) + 0-index補正
  }

  /** 設定シートから指定セルの値を読む */
  async function readSetting(cell, ssId) {
    const rows = await read(`設定!${cell}`, ssId);
    return rows?.[0]?.[0] ?? '';
  }

  /** マスタ表を読んでメンバー・カテゴリ・支払元を返す */
  async function readMaster(ssId) {
    const rows = await read('マスタ表!A2:G', ssId);
    const members    = [];
    const categories = [];
    const paySources = [];
    const admins     = [];

    rows.forEach(r => {
      if (r[0] || r[1]) members.push({ name: r[0] || '', email: r[1] || '', dept: r[2] || '', role: r[5] || '' });
      if (r[3]) paySources.push(r[3]);
      if (r[4]) categories.push(r[4]);
      if ((r[5] || '').toLowerCase() === 'admin' && r[1]) admins.push(r[1].toLowerCase());
    });

    return {
      members,
      categories: [...new Set(categories)],
      paySources: [...new Set(paySources)],
      admins,
    };
  }

  /** 複数範囲を一括上書きする（名前同期などに使用）*/
  async function batchUpdateValues(data, ssId) {
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
    readSetting,
    readMaster,
    _rowToExpense,
  };
})();
