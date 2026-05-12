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
  async function createSpreadsheet(companyName, parentFolderId) {
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

    // 3. 保存先フォルダが指定されていればスプレッドシートを移動
    if (parentFolderId) {
      await Drive.moveToFolder(ssId, parentFolderId).catch(() => {});
    }

    // 4. Drive 証票フォルダ作成（保存先フォルダ内 or ルート）
    const folderId = await Drive.createFolder(`経費証票 - ${companyName || ''}`.trim(), parentFolderId || null);

    // 5. フォルダIDを設定シートに保存
    await Sheets.update('設定!B4', [[folderId]], ssId);

    // 6. localStorageとDriveに保存（端末間同期）
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
        range: '設定!A1:B8',
        values: [
          ['設定項目', '値'],
          ['会社名', companyName || ''],
          ['ライセンスキー', localStorage.getItem('keihi_license_key') || ''],
          ['証票保存フォルダID', ''],  // フォルダ作成後に更新
          ['Gemini APIキー', ''],
          ['ライセンス確認日時', ''],
          ['バージョン', '2.0.0'],
          ['ヘッダー色', '#4582B5'],
        ]
      },
      // マスタ表ヘッダー・初期管理者・デフォルト勘定科目・支払元
      {
        range: 'マスタ表!A1:G13',
        values: [
          ['氏名', 'メールアドレス', '所属', '権限',    '備考',       '会社払い支払元',              '勘定科目'],
          [userName, userEmail, '',   'admin',   '初期管理者', '法人カード',                    '消耗品費'],
          ['', '', '', '', '', '小口現金',                      '旅費交通費'],
          ['', '', '', '', '', '○○銀行(管理タブで変更可)',      '会議費'],
          ['', '', '', '', '', '▲▲銀行(管理タブで変更可)',      '交際費'],
          ['', '', '', '', '', '', '通信費'],
          ['', '', '', '', '', '', '新聞図書費'],
          ['', '', '', '', '', '', '水道光熱費'],
          ['', '', '', '', '', '', '賃借料'],
          ['', '', '', '', '', '', '租税公課'],
          ['', '', '', '', '', '', '支払手数料'],
          ['', '', '', '', '', '', '雑費'],
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
    const requests = [];

    // 各シート：ヘッダー行を濃紺・白太字・センタリング
    headerSheets.filter(n => sheetIds[n] !== undefined).forEach(name => {
      requests.push({
        repeatCell: {
          range: { sheetId: sheetIds[name], startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.27, green: 0.51, blue: 0.71 },
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              horizontalAlignment: 'CENTER',
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
        }
      });
    });

    // 経費一覧：データ行（2行目以降）を白背景・標準テキストにリセット
    // → appendで行挿入するとヘッダーの書式が引き継がれるのを防ぐ
    requests.push({
      repeatCell: {
        range: { sheetId: sheetIds['経費一覧'], startRowIndex: 1, endRowIndex: 5000 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 1 },
            textFormat: { bold: false, foregroundColor: { red: 0, green: 0, blue: 0 } },
            horizontalAlignment: 'LEFT',
          }
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
      }
    });

    // 経費一覧：フィルターを設定（A1:R1）
    requests.push({
      setBasicFilter: {
        filter: {
          range: {
            sheetId: sheetIds['経費一覧'],
            startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 18
          }
        }
      }
    });

    // 経費一覧：ヘッダー行を固定
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId: sheetIds['経費一覧'],
          gridProperties: { frozenRowCount: 1 }
        },
        fields: 'gridProperties.frozenRowCount'
      }
    });

    // 経費一覧：列幅設定
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
