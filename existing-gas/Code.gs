const LICENSE_LEDGER_ID = '1yKzvWFC8cgXhHPiA2DzSfSK_-IlDsDCmGwBsdSRI0uU';

function onOpen() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('設定');
  if (!sheet) return;
  sheet.getRange('B3').setValue(ss.getUrl());
}

function doGet(e) {
  const ssId = e.parameter.id;
  if (!ssId) return ContentService.createTextOutput("エラー：URLにスプレッドシートIDが必要です");

  try {
    const ss = SpreadsheetApp.openById(ssId);
    const activeUserEmail = Session.getActiveUser().getEmail();
    if (!activeUserEmail) throw new Error("Googleアカウントのメールアドレスが取得できませんでした。");

    const listSheet = ss.getSheetByName('経費一覧');
    const summarySheet = ss.getSheetByName('集計表');
    const template = HtmlService.createTemplateFromFile('index');
    template.ssId = ssId;
    template.appTitle = ss.getName();
    template.userEmail = activeUserEmail;
    template.listUrl = listSheet ? `${ss.getUrl()}#gid=${listSheet.getSheetId()}` : ss.getUrl();
    template.summaryUrl = summarySheet ? `${ss.getUrl()}#gid=${summarySheet.getSheetId()}` : ss.getUrl();

    return template.evaluate().addMetaTag('viewport', 'width=device-width, initial-scale=1').setTitle(ss.getName());
  } catch (err) {
    return ContentService.createTextOutput("エラー: " + err.message);
  }
}

function verifyLicense(ssId) {
  const key = SpreadsheetApp.openById(ssId).getSheetByName('設定').getRange('B6').getValue();
  if (!key) throw new Error("ライセンスキー未設定");

  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();

  // L1: CacheService（最速・6時間有効・デプロイでリセット）
  const l1 = cache.get('LIC_' + key);
  if (l1 === 'OK') return true;
  if (l1 === 'NG') throw new Error("ライセンスが無効です");

  // L2: PropertiesService（デプロイ後も生存・有効24h / 無効1h）
  const l2raw = props.getProperty('LIC_' + key);
  if (l2raw) {
    const l2 = JSON.parse(l2raw);
    const ageMs = Date.now() - l2.at;
    if (l2.ok && ageMs < 86400000)  { cache.put('LIC_' + key, 'OK', 21600); return true; }
    if (!l2.ok && ageMs < 3600000) { cache.put('LIC_' + key, 'NG', 3600); throw new Error("ライセンスが無効です"); }
  }

  // L3: 台帳丸ごとキャッシュ（1回の読み取りで全ユーザー6時間分をカバー）
  const allCached = cache.get('LEDGER_ALL');
  let validKeys;
  if (allCached) {
    validKeys = new Set(JSON.parse(allCached));
  } else {
    try {
      const rows = SpreadsheetApp.openById(LICENSE_LEDGER_ID).getSheets()[0].getDataRange().getValues();
      validKeys = new Set(rows.filter(r => r[2] === '有効').map(r => r[1]));
      cache.put('LEDGER_ALL', JSON.stringify([...validKeys]), 21600);
    } catch (e) {
      throw new Error("ライセンス認証サーバーにアクセスできません");
    }
  }

  if (validKeys.has(key)) {
    cache.put('LIC_' + key, 'OK', 21600);
    props.setProperty('LIC_' + key, JSON.stringify({ ok: true, at: Date.now() }));
    return true;
  }
  cache.put('LIC_' + key, 'NG', 3600);
  props.setProperty('LIC_' + key, JSON.stringify({ ok: false, at: Date.now() }));
  throw new Error("ライセンスが無効です");
}

function saveExpense(data, userAgent, ssId) {
  verifyLicense(ssId);
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { throw new Error("混雑中。しばらく待って再試行してください。"); }

  try {
    const ss = SpreadsheetApp.openById(ssId);
    const sheet = ss.getSheetByName('経費一覧');
    if (!sheet) throw new Error("「経費一覧」シートが見つかりません");

    const activeUserEmail = Session.getActiveUser().getEmail();
    const memberName = getMemberName(activeUserEmail, ssId);

    let finalHashes = data.existingHashes ? data.existingHashes.split(',').filter(h => h) : [];
    let decodedFiles = [];
    if (data.files && data.files.length > 0) {
      data.files.forEach(f => {
        const decoded = Utilities.base64Decode(f.base64);
        decodedFiles.push({ decoded, mimeType: f.mimeType });
        const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, decoded);
        finalHashes.push(digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join(''));
      });
    }

    const fId = getFolderIdFromSettings(ssId);
    let fileLinks = [];
    if (data.existingUrls) data.existingUrls.forEach((u, i) => { if (u) fileLinks.push({ text: `証票(済${i+1})`, url: u }); });
    decodedFiles.forEach((f, i) => {
      const ext = f.mimeType.includes('pdf') ? 'pdf' : 'jpg';
      const filename = `${data.date}_${data.amount}円_${memberName}_${i+1}.${ext}`;
      fileLinks.push({ text: `証票(新${i+1})`, url: uploadFileToDrive(f.decoded, f.mimeType, filename, fId) });
    });

    let richText = null;
    if (fileLinks.length > 0) {
      const builder = SpreadsheetApp.newRichTextValue();
      const txt = fileLinks.map(item => item.text).join("\n");
      builder.setText(txt);
      let pos = 0;
      fileLinks.forEach(item => { builder.setLinkUrl(pos, pos + item.text.length, item.url); pos += item.text.length + 1; });
      richText = builder.build();
    }

    let targetRowIndex = -1;
    if (data.editId && sheet.getLastRow() >= 2) {
      const ids = sheet.getRange(2, 17, sheet.getLastRow() - 1, 1).getValues().flat();
      const idx = ids.indexOf(data.editId);
      if (idx !== -1) targetRowIndex = idx + 2;
    }

    const lines = (data.lines && data.lines.length > 0) ? data.lines : [{ amount: data.amount, category: data.category }];
    const baseNote = data.isCorpPayment ? `【会社払い】${data.note || ""}` : (data.note || "");
    const settlementCol = data.isCorpPayment ? `会社払い (${data.paySource})` : "";

    let alerts = [];
    try {
      if (sheet.getLastRow() >= 2) {
        const pastRecords = sheet.getDataRange().getValues().slice(1);
        for (const row of pastRecords) {
          if (data.editId && row[16] === data.editId) continue;
          if (formatDate(row[3]) === formatDate(data.date) && (row[4] || "") === (data.place || "") && Number(row[5]) === Number(data.amount)) {
            alerts.push('⛔重複疑い');
            break;
          }
        }
        if (finalHashes.length > 0) {
          const existingHashes = new Set(
            pastRecords
              .filter(r => !data.editId || r[16] !== data.editId)
              .flatMap(r => (r[14] || '').split(',').filter(String))
          );
          if (finalHashes.some(h => h && existingHashes.has(h))) alerts.push('⚠️同一画像の可能性');
        }
      }
    } catch (e) { console.error('重複チェックエラー:', e); }

    const aiStatus = alerts.length > 0 ? alerts.join(", ") : "✅ OK";
    if (!data.forceSave && alerts.length > 0) return { requiresConfirm: true, alerts };

    if (targetRowIndex !== -1) {
      const existingRow = sheet.getRange(targetRowIndex, 1, 1, 18).getValues()[0];
      if (existingRow[9] === true) throw new Error("承認済みのデータは修正できません");
      let histSheet = ss.getSheetByName('修正履歴');
      if (!histSheet) {
        histSheet = ss.insertSheet('修正履歴');
        histSheet.appendRow(["修正日時","登録日","氏名","種別","日付","支払先","金額","科目","備考","証票","承認","AI","精算","INV","解析","Hash","Email","ID","UA","修正者"]);
        const prot = histSheet.protect().setDescription('修正履歴は編集禁止（電帳法対応）');
        prot.removeEditors(prot.getEditors());
        prot.addEditor(activeUserEmail);
        if (prot.canDomainEdit()) prot.setDomainEdit(false);
      }
      histSheet.appendRow([new Date(), ...existingRow, activeUserEmail]);
    }

    lines.forEach((line, index) => {
      const lineNote = lines.length > 1 ? `(内訳${index+1}/${lines.length}) ${baseNote}` : baseNote;
      const rowData = [
        new Date(), memberName, data.type, data.date, data.place, line.amount, line.category, lineNote,
        "", false, aiStatus, settlementCol, data.invoice || "", "", finalHashes.join(","),
        activeUserEmail, (index === 0 && data.editId ? data.editId : Utilities.getUuid()), userAgent
      ];

      if (index === 0 && targetRowIndex !== -1) {
        sheet.getRange(targetRowIndex, 1, 1, 8).setValues([rowData.slice(0, 8)]);
        sheet.getRange(targetRowIndex, 11, 1, 8).setValues([rowData.slice(10)]);
        if (richText) { sheet.getRange(targetRowIndex, 9).setRichTextValue(richText); } else { sheet.getRange(targetRowIndex, 9).clearContent(); }
      } else {
        sheet.insertRowAfter(1);
        sheet.getRange(2, 1, 1, 18).setHorizontalAlignment('left');
        sheet.getRange(2, 2).setHorizontalAlignment('center');
        sheet.getRange(2, 3).setHorizontalAlignment('center');
        sheet.getRange(2, 6).setHorizontalAlignment('right');
        sheet.getRange(2, 10).setHorizontalAlignment('center');
        sheet.getRange(2, 14).setHorizontalAlignment('right');
        sheet.getRange(2, 10).insertCheckboxes();
        sheet.getRange(2, 1, 1, 8).setValues([rowData.slice(0, 8)]);
        sheet.getRange(2, 10, 1, 9).setValues([rowData.slice(9)]);
        if (richText) sheet.getRange(2, 9).setRichTextValue(richText);
      }
    });

    return { requiresConfirm: false, message: data.editId ? "修正完了！" : "申請完了！" };
  } finally { lock.releaseLock(); }
}

function getMemberName(email, ssId) {
  const sheet = SpreadsheetApp.openById(ssId).getSheetByName('マスタ表');
  if (!sheet || sheet.getLastRow() < 2) throw new Error("マスタ表にユーザーが登録されていません。管理者に連絡してください。");
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const search = email ? email.toLowerCase().trim() : "";
  const m = data.find(r => r[0] && r[1] && r[1].toLowerCase().trim() === search);
  if (!m) throw new Error("このメールアドレスはマスタ表に登録されていません。管理者に連絡してください。");
  return m[0];
}

function getAppData(ssId) {
  const s = SpreadsheetApp.openById(ssId).getSheetByName('マスタ表');
  if (!s || s.getLastRow() < 2) return { paySources: [] , categories: [] };
  const rows = s.getLastRow() - 1;
  return {
    paySources: s.getRange(2, 4, rows, 1).getValues().flat().filter(String),
    categories: s.getRange(2, 6, rows, 1).getValues().flat().filter(String)
  };
}

function deleteExpense(id, userAgent, ssId) {
  verifyLicense(ssId);
  const activeUserEmail = Session.getActiveUser().getEmail();
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName('経費一覧');
  if (!sheet || sheet.getLastRow() < 2) throw new Error("対象データが見つかりません");

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 18).getValues();
  let rows = [], logData = [];

  data.forEach((r, i) => {
    if (r[16] === id) {
      if (r[15] !== activeUserEmail) throw new Error("権限エラー：他人のデータは削除できません");
      if (r[9] === true) throw new Error("承認済みは削除できません");
      rows.push(i + 2);
      logData.push([...r, new Date()]);
    }
  });

  if (rows.length === 0) throw new Error("対象データが見つかりません");

  let logSheet = ss.getSheetByName('削除一覧') || ss.insertSheet('削除一覧');
  if (logSheet.getLastRow() === 0) logSheet.appendRow(["登録日","氏名","種別","日付","支払先","金額","科目","備考","証票","承認","AI","精算","INV","解析","Hash","Email","ID","UA","削除日時"]);
  if (logSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).length === 0) {
    const prot = logSheet.protect().setDescription('削除一覧は編集禁止（電帳法対応）');
    prot.removeEditors(prot.getEditors());
    prot.addEditor(activeUserEmail);
    if (prot.canDomainEdit()) prot.setDomainEdit(false);
  }
  logData.forEach(r => logSheet.appendRow(r));
  rows.reverse().forEach(r => sheet.deleteRow(r));
  return "削除しました";
}

function getMyHistory(ssId) {
  verifyLicense(ssId);
  const activeUserEmail = Session.getActiveUser().getEmail();
  const sheet = SpreadsheetApp.openById(ssId).getSheetByName('経費一覧');
  if (!sheet || sheet.getLastRow() < 2) return [];

  const maxRows = Math.min(sheet.getLastRow() - 1, 300);
  const data = sheet.getRange(2, 1, maxRows, 18).getValues();
  const rts = sheet.getRange(2, 9, maxRows, 1).getRichTextValues();

  return data
    .map((r, i) => ({ row: r, rt: rts[i][0] }))
    .filter(x => x.row[15] === activeUserEmail && x.row[16])
    .slice(0, 30)
    .map(x => {
      let urls = [];
      if (x.rt) x.rt.getRuns().forEach(run => { if (run.getLinkUrl()) urls.push(run.getLinkUrl()); });
      return {
        id: x.row[16], date: formatDate(x.row[3]), place: x.row[4], amount: x.row[5],
        category: x.row[6], type: x.row[2], imageUrls: urls, note: x.row[7],
        status: x.row[9] === true ? "承認" : "未確認", payment: x.row[11] || "",
        imgHash: x.row[14], invoice: x.row[12] || ""
      };
    });
}

function analyzeReceipt(files, ssId, categories) {
  verifyLicense(ssId);
  const key = SpreadsheetApp.openById(ssId).getSheetByName('設定').getRange('B5').getValue();
  if (!key) throw new Error("APIキーが設定されていません");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const catList = (categories && categories.length > 0) ? categories.join('、') : '消耗品費、旅費交通費、会議費、交際費、通信費、新聞図書費、水道光熱費、賃借料、租税公課、支払手数料、雑費';
  const prompt = `領収書を解析し、JSONのみ出力してください。科目リスト：${catList}
【外貨の判定】日本円以外の通貨で記載されている場合は fx_currency に通貨コード（USD/EUR/GBP/CNY/HKD/AUD/CAD/SGD/KRW/THB など）、fx_amount に外貨金額（数値）を設定し、total_amount は null にしてください。日本円取引の場合は fx_currency と fx_amount は null。
単一科目の場合：{ "date": "YYYY/MM/DD", "shop": "店名", "invoice": "T+13桁またはnull", "total_amount": 円金額または null, "category": "科目リストから1つ", "items": null, "fx_currency": "USD等またはnull", "fx_amount": 外貨金額または null }
複数科目に分けるべき場合（宿泊税・ゴルフ税など別途課税項目がある場合）：{ "date": "YYYY/MM/DD", "shop": "店名", "invoice": "T+13桁またはnull", "total_amount": 円金額または null, "category": null, "items": [{"amount": 数値, "category": "科目"}, {"amount": 数値, "category": "科目"}], "fx_currency": "USD等またはnull", "fx_amount": 外貨金額または null }`;
  const parts = [{ text: prompt }];
  files.forEach(f => parts.push({ inline_data: { mime_type: f.mimeType, data: f.base64 } }));

  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ contents: [{ parts }] }),
    muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText());

  if (json.error) throw new Error("AI処理エラー: " + json.error.message);
  if (!json.candidates?.[0]?.content) throw new Error("AIが画像を読み取れませんでした。手動で入力してください。");

  return JSON.parse(json.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim());
}

function getFolderIdFromSettings(ssId) {
  const sheet = SpreadsheetApp.openById(ssId).getSheetByName('設定');
  if (!sheet) throw new Error('「設定」シートが見つかりません');
  const val = String(sheet.getRange('B4').getValue()).trim();
  if (!val || val === 'undefined') throw new Error('設定シートのB4に証票保存フォルダのURLまたはIDを入力してください');
  const m = val.match(/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : val;
}

function uploadFileToDrive(decoded, mimeType, filename, folderId) {
  const token = ScriptApp.getOAuthToken();
  const boundary = 'b' + Utilities.getUuid().replace(/-/g, '');
  const metaStr = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
    + JSON.stringify({ name: filename, parents: [folderId] })
    + '\r\n--' + boundary + '\r\nContent-Type: ' + mimeType + '\r\n\r\n';
  const endStr = '\r\n--' + boundary + '--';
  const bodyBytes = [].concat(
    Utilities.newBlob(metaStr).getBytes(),
    decoded,
    Utilities.newBlob(endStr).getBytes()
  );
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id%2CwebViewLink',
    {
      method: 'post',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
      payload: bodyBytes,
      muteHttpExceptions: true
    }
  );
  const result = JSON.parse(res.getContentText());
  if (!result.id) throw new Error('ファイルのアップロードに失敗しました');
  return result.webViewLink;
}

function getExchangeRate(date, currency, ssId) {
  const url = `https://api.frankfurter.app/${date}?from=${currency}&to=JPY`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('為替レートの取得に失敗しました（コード: ' + res.getResponseCode() + '）');
  const json = JSON.parse(res.getContentText());
  if (!json.rates || !json.rates.JPY) throw new Error('JPYレートが見つかりません（通貨: ' + currency + '）');
  return { rate: json.rates.JPY, date: json.date, currency };
}

function formatDate(d) { return Utilities.formatDate(new Date(d), "Asia/Tokyo", "yyyy-MM-dd"); }

function lockApprovedRows(ssId) {
  verifyLicense(ssId);
  const sheet = SpreadsheetApp.openById(ssId).getSheetByName('経費一覧');
  if (!sheet || sheet.getLastRow() < 2) return "ロック対象なし";
  const adminEmail = Session.getActiveUser().getEmail();
  const existingProts = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  const alreadyLockedRows = new Set(existingProts.map(p => p.getRange().getRow()));
  const data = sheet.getRange(2, 10, sheet.getLastRow() - 1, 1).getValues();
  let lockedCount = 0;
  data.forEach((row, i) => {
    if (row[0] === true) {
      const rowNum = i + 2;
      if (!alreadyLockedRows.has(rowNum)) {
        [sheet.getRange(rowNum, 1, 1, 11), sheet.getRange(rowNum, 13, 1, 6)].forEach(range => {
          const prot = range.protect().setDescription('承認済み行（電帳法対応）');
          prot.removeEditors(prot.getEditors());
          prot.addEditor(adminEmail);
          if (prot.canDomainEdit()) prot.setDomainEdit(false);
        });
        lockedCount++;
      }
    }
  });
  return `${lockedCount}行をロックしました`;
}

function setupFilter(ssId) {
  verifyLicense(ssId);
  const sheet = SpreadsheetApp.openById(ssId).getSheetByName('経費一覧');
  if (!sheet) throw new Error("「経費一覧」シートが見つかりません");
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 18).createFilter();
  return "フィルターを設定しました";
}
