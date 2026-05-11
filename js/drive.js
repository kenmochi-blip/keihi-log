/**
 * Google Drive API ラッパー
 * drive.file スコープ：このアプリが作成したファイルのみ操作可能
 */
const Drive = (() => {

  const BASE = 'https://www.googleapis.com/';

  function _folderId() {
    return localStorage.getItem('keihi_folder_id') || '';
  }

  /**
   * フォルダを作成して ID を返す
   */
  async function createFolder(name, parentId) {
    const meta = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {})
    };
    const resp = await Auth.authFetch(
      'https://www.googleapis.com/drive/v3/files',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta)
      }
    );
    if (!resp.ok) throw new Error(`Drive createFolder error: ${resp.status}`);
    const data = await resp.json();
    return data.id;
  }

  /**
   * ファイルをアップロードする（マルチパート）
   * @param {string} base64   Base64エンコードされたファイルデータ
   * @param {string} mimeType ファイルのMIMEタイプ
   * @param {string} filename ファイル名
   * @returns {{ id, webViewLink }} ファイルID とウェブリンク
   */
  async function uploadFile(base64, mimeType, filename) {
    if (typeof Demo !== 'undefined' && Demo.isActive())
      return { id: 'demo', webViewLink: '' };
    const folderId = _folderId();

    // Base64 → Blob
    const binary = atob(base64.replace(/^data:[^;]+;base64,/, ''));
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });

    const meta = JSON.stringify({
      name: filename,
      mimeType,
      ...(folderId ? { parents: [folderId] } : {})
    });

    const form = new FormData();
    form.append('metadata', new Blob([meta], { type: 'application/json' }));
    form.append('file', blob);

    const resp = await Auth.authFetch(
      `${BASE}upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink`,
      { method: 'POST', body: form }
    );
    if (!resp.ok) throw new Error(`Drive upload error: ${resp.status}`);
    return resp.json(); // { id, webViewLink }
  }

  /**
   * 画像を検証してからアップロードする（電帳法：解像度チェック）
   * @returns {{ url, hash, warn }} webViewLink, SHA-256ハッシュ, 解像度警告メッセージ
   */
  async function uploadReceiptFile(base64, mimeType, filename) {
    let warn = null;

    // 画像の場合のみ解像度チェック（200万画素以上 = 2,000,000px）
    if (mimeType.startsWith('image/')) {
      warn = await _checkResolution(base64);
    }

    // SHA-256ハッシュ計算
    const hash = await _sha256(base64);

    const { webViewLink } = await uploadFile(base64, mimeType, filename);
    return { url: webViewLink, hash, warn };
  }

  /** 画像の解像度を確認して200万画素未満なら警告文を返す */
  function _checkResolution(base64) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const pixels = img.width * img.height;
        resolve(pixels < 2_000_000
          ? `解像度が低い可能性があります（${img.width}×${img.height}px）。電子帳簿保存法では200万画素以上が推奨されています。`
          : null
        );
      };
      img.onerror = () => resolve(null);
      img.src = base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;
    });
  }

  /** Base64データのSHA-256ハッシュを返す */
  async function _sha256(base64) {
    const clean = base64.replace(/^data:[^;]+;base64,/, '');
    const binary = atob(clean);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** 画像ファイルをBase64に変換する */
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  const SETTINGS_FILENAME = 'keihi-settings.json';

  /** Drive appDataFolder に設定を保存する（端末をまたいで同期） */
  async function saveSettings(settings) {
    const fileId = await _findSettingsFile();
    const body = JSON.stringify(settings);
    const blob = new Blob([body], { type: 'application/json' });

    if (fileId) {
      // 既存ファイルを更新
      await Auth.authFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: blob }
      );
    } else {
      // 新規作成
      const meta = JSON.stringify({ name: SETTINGS_FILENAME, parents: ['appDataFolder'] });
      const form = new FormData();
      form.append('metadata', new Blob([meta], { type: 'application/json' }));
      form.append('file', blob);
      await Auth.authFetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        { method: 'POST', body: form }
      );
    }
  }

  /** Drive appDataFolder から設定を読み込む。未設定ならnullを返す */
  async function loadSettings() {
    try {
      const fileId = await _findSettingsFile();
      if (!fileId) return null;
      const resp = await Auth.authFetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
      );
      if (!resp.ok) return null;
      return await resp.json();
    } catch (_) {
      return null;
    }
  }

  async function _findSettingsFile() {
    const resp = await Auth.authFetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D'${SETTINGS_FILENAME}'&fields=files(id)`
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.files?.[0]?.id || null;
  }

  async function moveToFolder(fileId, folderId) {
    if (!fileId || !folderId) return;
    const resp = await Auth.authFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${folderId}&removeParents=root&fields=id`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' } }
    );
    if (!resp.ok) throw new Error(`Drive moveToFolder error: ${resp.status}`);
  }

  return { createFolder, moveToFolder, uploadFile, uploadReceiptFile, fileToBase64, saveSettings, loadSettings };
})();
