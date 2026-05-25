/**
 * Google Picker API ラッパー
 * drive.file スコープ運用において、共有シートへの初回アクセス時に
 * ユーザーが明示的にファイルを「開く」操作を行うために使用する。
 * 管理者がアプリで作成したファイルは drive.file で自動カバーされるため Picker 不要。
 */
const Picker = (() => {

  const PREFIX = 'keihi_picker_ok_';

  function isGranted(ssId) {
    return !!localStorage.getItem(PREFIX + ssId);
  }

  function markGranted(ssId) {
    localStorage.setItem(PREFIX + ssId, '1');
  }

  async function _loadGapi() {
    if (window.gapi?.picker) return;
    await new Promise((resolve, reject) => {
      if (window.gapi) {
        gapi.load('picker', { callback: resolve, onerror: reject });
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://apis.google.com/js/api.js';
      s.onload = () => gapi.load('picker', { callback: resolve, onerror: reject });
      s.onerror = () => reject(new Error('Google Picker APIの読み込みに失敗しました'));
      document.head.appendChild(s);
    });
  }

  /**
   * Picker を開いてユーザーにシートを選択させる。
   * ssId が一致するファイルが選ばれた場合に markGranted して resolve。
   * 異なるファイルが選ばれた場合は reject（wrong_file）。
   * キャンセルは reject（picker_cancelled）。
   */
  async function openForFile(ssId, accessToken) {
    await _loadGapi();
    return new Promise((resolve, reject) => {
      const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
        .setMode(google.picker.DocsViewMode.LIST)
        .setIncludeFolders(false);

      // setFileIds: 2025年1月追加のAPI - 特定ファイルだけ表示して誤選択を防ぐ
      if (typeof view.setFileIds === 'function') {
        view.setFileIds([ssId]);
      }

      const builder = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setTitle('経費ログのスプレッドシートを選択してください')
        .setCallback((data) => {
          const action = data[google.picker.Response.ACTION];
          if (action === google.picker.Action.PICKED) {
            const fileId = data[google.picker.Response.DOCUMENTS][0][google.picker.Document.ID];
            if (fileId !== ssId) {
              reject(new Error('wrong_file'));
              return;
            }
            markGranted(fileId);
            resolve(fileId);
          } else if (action === google.picker.Action.CANCEL) {
            reject(new Error('picker_cancelled'));
          }
        });

      builder.build().setVisible(true);
    });
  }

  return { isGranted, markGranted, openForFile };
})();
