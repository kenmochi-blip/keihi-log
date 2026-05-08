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
      appliedAt:   row[0]  || '',   // A: 申請日時（サーバー時刻）
      name:        row[1]  || '',   // B: 申請者名
      type:        row[2]  || '',   // C: タイプ
      date:        row[3]  || '',   // D: 日付
      place:       row[4]  || '',   // E: 支払先
      amount:      Number(row[5]) || 0, // F: 金額
      category:    row[6]  || '',   // G: 勘定科目
      note:        row[7]  || '',   // H: 備考
      imageLinks:  row[8]  || '',   // I: 証票リンク（カンマ区切りURL）
      confirmed:   row[9]  === true || row[9] === 'TRUE', // J: 確認
      aiAudit:     row[10] || '',   // K: AI監査
      payment:     row[11] || '',   // L: 精算日/会社払い
      invoice:     row[12] || '',   // M: インボイス番号
      aiAmount:    Number(row[13]) || 0, // N: AI解析額
      imageHash:   row[14] || '',   // O: 画像ハッシュ（SHA-256）
      email:       row[15] || '',   // P: 申請者Email
      id:          row[16] || '',   // Q: UUID
      device:      row[17] || '',   // R: デバイス情報
    };
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

  return {
    read,
    append,
    update,
    batchUpdate,
    deleteRow,
    readExpenses,
    expenseToRow,
    findRowById,
    readSetting,
    readMaster,
    _rowToExpense,
  };
})();
