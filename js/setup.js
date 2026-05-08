/**
 * スプレッドシート自動作成モジュール
 * 管理者が「新規作成」ボタンを押したときに呼ばれる
 */
const Setup = (() => {

  const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

  /**
   * 経費ログ用スプレッドシートをゼロから作成する
   * @param {string} companyName 会社名（シートタイトルに使用）
   * @returns {string} 作成されたスプレッドシートID
   */
  async function createSpreadsheet(companyName) {
    const title = `経費ログ - ${companyName || ''}`.trim();

    // 1. スプレッドシート作成（シート構成まで一括で作成）
    const body = {
      properties: { title, locale: 'ja_JP', timeZone: 'Asia/Tokyo' },
      sheets: [
        { properties: { title: '経費一覧', index: 0 } },
        { properties: { title: '設定',     index: 1 } },
        { properties: { title: 'マスタ表', index: 2 } },
        { properties: { title: '修正履歴', index: 3 } },
        { properties: { title: '削除一覧', index: 4 } },
      ]
    };

    const resp = await Auth.authFetch(SHEETS_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error(`スプレッドシート作成エラー: ${resp.status}`);
    const ss = await resp.json();
    const ssId = ss.spreadsheetId;

    // シートIDを名前で引けるマップ
    const sheetIds = {};
    ss.sheets.forEach(s => { sheetIds[s.properties.title] = s.properties.sheetId; });

    // 2. ヘッダーと初期データを書き込む
    await _writeInitialData(ssId, sheetIds, companyName);

    // 3. Drive フォルダ作成
    const folderId = await Drive.createFolder(`経費証票 - ${companyName || ''}`.trim());

    // 4. フォルダIDを設定シートに保存
    await Sheets.update('設定!B4', [[folderId]], ssId);

    // 5. localStorageとDriveに保存（端末間同期）
    localStorage.setItem('keihi_sheet_id', ssId);
    localStorage.setItem('keihi_folder_id', folderId);
    Drive.saveSettings({
      licenseKey: localStorage.getItem('keihi_license_key') || '',
      sheetId:    ssId,
      folderId,
    }).catch(() => {});

    return ssId;
  }

  async function _writeInitialData(ssId, sheetIds, companyName) {
    const userEmail = Auth.getUserEmail();
    const userName  = Auth.getUserInfo()?.name || userEmail;

    const updates = [
      // 経費一覧ヘッダー（18列）
      {
        range: '経費一覧!A1:R1',
        values: [[
          '申請日時', '申請者名', 'タイプ', '日付', '支払先', '金額',
          '勘定科目', '備考', '証票', '確認', 'AI監査', '精算日',
          'インボイス番号', 'AI解析額', '画像ハッシュ(SHA256)', '申請者Email', 'ID', 'デバイス情報'
        ]]
      },
      // 修正履歴ヘッダー
      {
        range: '修正履歴!A1:C1',
        values: [['修正日時', '修正者Email', '修正前データ（JSON）']]
      },
      // 削除一覧ヘッダー
      {
        range: '削除一覧!A1:S1',
        values: [['削除日時', '削除者Email', '申請日時', '申請者名', 'タイプ', '日付', '支払先', '金額',
          '勘定科目', '備考', '証票', '確認', 'AI監査', '精算日', 'インボイス番号', 'AI解析額', '画像ハッシュ', '申請者Email', 'ID']]
      },
      // 設定シート
      {
        range: '設定!A1:B7',
        values: [
          ['設定項目', '値'],
          ['会社名', companyName || ''],
          ['ライセンスキー', localStorage.getItem('keihi_license_key') || ''],
          ['証票保存フォルダID', ''],  // フォルダ作成後に更新
          ['Gemini APIキー', ''],
          ['ライセンス確認日時', ''],
          ['バージョン', '2.0.0'],
        ]
      },
      // マスタ表ヘッダー・初期管理者・デフォルト勘定科目・支払元
      {
        range: 'マスタ表!A1:G13',
        values: [
          ['氏名', 'メールアドレス', '所属', '会社払い支払元',         '勘定科目',   '権限',  '備考'],
          [userName, userEmail, '',   '法人カード',                    '消耗品費',   'admin', '初期管理者'],
          ['', '', '',                '小口現金',                      '旅費交通費', '',      ''],
          ['', '', '',                '○○銀行(管理タブで変更可)',      '会議費',     '',      ''],
          ['', '', '',                '▲▲銀行(管理タブで変更可)',      '交際費',     '',      ''],
          ['', '', '', '', '通信費',     '', ''],
          ['', '', '', '', '新聞図書費', '', ''],
          ['', '', '', '', '水道光熱費', '', ''],
          ['', '', '', '', '賃借料',     '', ''],
          ['', '', '', '', '租税公課',   '', ''],
          ['', '', '', '', '支払手数料', '', ''],
          ['', '', '', '', '雑費',       '', ''],
        ]
      },
    ];

    // バッチ更新で一括書き込み
    const resp = await Auth.authFetch(
      `${SHEETS_BASE}/${ssId}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: updates
        })
      }
    );
    if (!resp.ok) throw new Error(`初期データ書き込みエラー: ${resp.status}`);

    // ヘッダー行を太字・背景色に
    await _formatHeaders(ssId, sheetIds);
  }

  async function _formatHeaders(ssId, sheetIds) {
    const headerSheets = ['経費一覧', '設定', 'マスタ表', '修正履歴', '削除一覧'];
    const requests = headerSheets
      .filter(name => sheetIds[name] !== undefined)
      .map(name => ({
        repeatCell: {
          range: { sheetId: sheetIds[name], startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.27, green: 0.51, blue: 0.71 },
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)'
        }
      }));

    // 経費一覧の列幅を設定
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: sheetIds['経費一覧'], dimension: 'COLUMNS', startIndex: 0, endIndex: 18 },
        properties: { pixelSize: 120 },
        fields: 'pixelSize'
      }
    });

    await Sheets.batchUpdate(requests, ssId);
  }

  return { createSpreadsheet };
})();
