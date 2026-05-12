/**
 * マスタ管理ビュー（管理者のみ表示）
 * メンバー・勘定科目・支払元・GeminiAPIキーをWebアプリ内で管理する
 */
const AdminView = (() => {

  let _master = null; // { members, categories, paySources, admins }

  function render() {
    return `
<div class="pt-3">
  <h5 class="fw-bold mb-3"><i class="bi bi-shield-fill me-2 text-primary"></i>マスタ管理</h5>
  <div id="adminLoading" class="text-center py-4">
    <div class="spinner-border text-primary" role="status"></div>
    <div class="text-muted small mt-2">データを読み込んでいます...</div>
  </div>
  <div id="adminContent" class="d-none">

    <!-- Gemini APIキー -->
    <div class="card mb-3">
      <div class="card-body">
        <div class="settings-section-title">Gemini APIキー（全メンバー共用）</div>
        <p class="text-muted small mb-2">Google AI Studioで取得したAPIキーを入力してください。メンバーは個別に取得不要です。</p>
        <div class="input-group">
          <input type="password" class="form-control form-control-sm" id="inputGeminiKey" placeholder="AIzaSy...">
          <button class="btn btn-outline-primary btn-sm" id="btnSaveGeminiKey">保存</button>
        </div>
        <div id="geminiKeyMsg" class="form-text"></div>
      </div>
    </div>

    <!-- メンバー管理 -->
    <div class="card mb-3">
      <div class="card-body">
        <div class="settings-section-title d-flex justify-content-between align-items-center">
          <span>メンバー管理</span>
          <button class="btn btn-outline-primary btn-sm" id="btnAddMember">
            <i class="bi bi-plus me-1"></i>追加
          </button>
        </div>
        <div id="memberList" class="mt-2"></div>
      </div>
    </div>

    <!-- 勘定科目管理 -->
    <div class="card mb-3">
      <div class="card-body">
        <div class="settings-section-title d-flex justify-content-between align-items-center">
          <span>勘定科目</span>
          <button class="btn btn-outline-primary btn-sm" id="btnAddCategory">
            <i class="bi bi-plus me-1"></i>追加
          </button>
        </div>
        <div id="categoryList" class="mt-2"></div>
      </div>
    </div>

    <!-- 会社払い支払元管理 -->
    <div class="card mb-3">
      <div class="card-body">
        <div class="settings-section-title d-flex justify-content-between align-items-center">
          <span>会社払い支払元</span>
          <button class="btn btn-outline-primary btn-sm" id="btnAddPaySource">
            <i class="bi bi-plus me-1"></i>追加
          </button>
        </div>
        <div id="paySourceList" class="mt-2"></div>
      </div>
    </div>

  </div>
</div>`;
  }

  async function bindEvents(el) {
    try {
      _master = await Sheets.readMaster();
      // 現在のGeminiキーを設定シートから読み込む
      const geminiKey = await Sheets.readSetting('B5');
      el.querySelector('#inputGeminiKey').value = geminiKey || '';
      _renderAll(el);
      el.querySelector('#adminLoading').classList.add('d-none');
      el.querySelector('#adminContent').classList.remove('d-none');
    } catch (err) {
      el.querySelector('#adminLoading').innerHTML =
        `<div class="text-danger small"><i class="bi bi-exclamation-triangle me-1"></i>${err.message}</div>`;
      return;
    }

    // Gemini APIキー保存
    el.querySelector('#btnSaveGeminiKey')?.addEventListener('click', async () => {
      const key = el.querySelector('#inputGeminiKey').value.trim();
      const msg = el.querySelector('#geminiKeyMsg');
      try {
        await Sheets.update('設定!B5', [[key]]);
        Gemini.clearApiKey();
        msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>保存しました</span>';
        App.showToast('Gemini APIキーを保存しました', 'success');
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${err.message}</span>`;
      }
    });

    // メンバー追加
    el.querySelector('#btnAddMember')?.addEventListener('click', () => _showMemberForm(el, null));
    // 勘定科目追加
    el.querySelector('#btnAddCategory')?.addEventListener('click', () => _showInlineAdd(el, 'category'));
    // 支払元追加
    el.querySelector('#btnAddPaySource')?.addEventListener('click', () => _showInlineAdd(el, 'paySource'));
  }

  function _renderAll(el) {
    _renderMembers(el);
    _renderSimpleList(el, 'categoryList', _master.categories, 'category');
    _renderSimpleList(el, 'paySourceList', _master.paySources, 'paySource');
  }

  function _renderMembers(el) {
    const container = el.querySelector('#memberList');
    if (!container) return;
    if (_master.members.length === 0) {
      container.innerHTML = '<div class="text-muted small">メンバーが登録されていません</div>';
      return;
    }
    container.innerHTML = _master.members.map((m, i) => `
      <div class="d-flex align-items-center gap-2 py-2 border-bottom member-row" data-index="${i}">
        <div class="flex-grow-1">
          <div class="master-item-name">${_escape(m.name)}</div>
          <div class="text-muted" style="font-size:0.72rem;">${_escape(m.email)} ${m.dept ? '/ ' + _escape(m.dept) : ''}
            ${m.role === 'admin' ? '<span class="badge bg-primary ms-1" style="font-size:0.6rem;">管理者</span>' : ''}
          </div>
        </div>
        <button class="btn btn-outline-secondary btn-sm btn-edit-member" data-index="${i}"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-outline-danger btn-sm btn-del-member" data-index="${i}"><i class="bi bi-trash"></i></button>
      </div>
    `).join('');

    container.querySelectorAll('.btn-edit-member').forEach(btn => {
      btn.addEventListener('click', () => _showMemberForm(el, Number(btn.dataset.index)));
    });
    container.querySelectorAll('.btn-del-member').forEach(btn => {
      btn.addEventListener('click', () => _deleteMember(el, Number(btn.dataset.index)));
    });
  }

  function _renderSimpleList(el, containerId, items, type) {
    const container = el.querySelector(`#${containerId}`);
    if (!container) return;
    if (items.length === 0) {
      container.innerHTML = '<div class="text-muted small">登録がありません</div>';
      return;
    }
    container.innerHTML = items.map((item, i) => `
      <div class="d-flex align-items-center gap-2 py-1 border-bottom">
        <span class="flex-grow-1 master-item-name">${_escape(item)}</span>
        <button class="btn btn-outline-danger btn-sm btn-del-item" data-type="${type}" data-index="${i}">
          <i class="bi bi-trash"></i>
        </button>
      </div>
    `).join('');

    container.querySelectorAll('.btn-del-item').forEach(btn => {
      btn.addEventListener('click', () => _deleteSimpleItem(el, btn.dataset.type, Number(btn.dataset.index)));
    });
  }

  function _showMemberForm(el, idx) {
    const m = idx !== null ? _master.members[idx] : { name: '', email: '', dept: '', role: '' };
    const isNew = idx === null;

    const modal = document.createElement('div');
    modal.innerHTML = `
      <div class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h6 class="modal-title">${isNew ? 'メンバー追加' : 'メンバー編集'}</h6>
              <button class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-2">
                <label class="form-label small">氏名</label>
                <input type="text" class="form-control form-control-sm" id="mName" value="${_escape(m.name)}">
              </div>
              <div class="mb-2">
                <label class="form-label small">メールアドレス</label>
                <input type="email" class="form-control form-control-sm" id="mEmail" value="${_escape(m.email)}">
              </div>
              <div class="mb-2">
                <label class="form-label small">所属</label>
                <input type="text" class="form-control form-control-sm" id="mDept" value="${_escape(m.dept)}">
              </div>
              <div class="mb-2">
                <label class="form-label small">権限</label>
                <select class="form-select form-select-sm" id="mRole">
                  <option value="" ${!m.role || m.role === 'member' ? 'selected' : ''}>一般</option>
                  <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>管理者</option>
                </select>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">キャンセル</button>
              <button class="btn btn-primary btn-sm" id="btnSaveMember">保存</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal.querySelector('.modal'));
    bsModal.show();

    modal.querySelector('#btnSaveMember').addEventListener('click', async () => {
      const updated = {
        name:  modal.querySelector('#mName').value.trim(),
        email: modal.querySelector('#mEmail').value.trim(),
        dept:  modal.querySelector('#mDept').value.trim(),
        role:  modal.querySelector('#mRole').value,
      };
      if (!updated.name || !updated.email) return App.showToast('氏名・メールは必須です', 'danger');
      const oldEmail = isNew ? null : (_master.members[idx]?.email || null);
      if (isNew) _master.members.push(updated);
      else       _master.members[idx] = updated;
      await _saveMasterToSheet(el);
      // Drive編集権限を付与（メール変更時は旧メールの権限を剥奪）
      const ssId = localStorage.getItem('keihi_sheet_id');
      if (ssId && updated.email) {
        if (oldEmail && oldEmail !== updated.email) {
          Drive.revokeAccess(oldEmail, ssId).catch(() => {});
        }
        Drive.grantEditorAccess(updated.email, ssId)
          .then(() => App.showToast(`${updated.name} にSSの編集権限を付与しました`, 'success'))
          .catch(() => App.showToast('権限付与に失敗しました（Drive権限を確認してください）', 'warning'));
      }
      bsModal.hide();
    });
    modal.addEventListener('hidden.bs.modal', () => modal.remove());
  }

  function _showInlineAdd(el, type) {
    const containerId = type === 'category' ? 'categoryList' : 'paySourceList';
    const container = el.querySelector(`#${containerId}`);
    const input = document.createElement('div');
    input.className = 'd-flex gap-1 mt-2';
    input.innerHTML = `
      <input type="text" class="form-control form-control-sm" placeholder="追加する項目名">
      <button class="btn btn-primary btn-sm">追加</button>
      <button class="btn btn-secondary btn-sm">✕</button>`;
    container.prepend(input);
    input.querySelector('input').focus();
    input.querySelectorAll('button')[1].addEventListener('click', () => input.remove());
    input.querySelectorAll('button')[0].addEventListener('click', async () => {
      const val = input.querySelector('input').value.trim();
      if (!val) return;
      if (type === 'category') _master.categories.push(val);
      else _master.paySources.push(val);
      await _saveMasterToSheet(el);
      input.remove();
    });
  }

  async function _deleteMember(el, idx) {
    const member = _master.members[idx];
    if (!confirm(`${member.name} を削除しますか？`)) return;
    _master.members.splice(idx, 1);
    await _saveMasterToSheet(el);
    // Drive編集権限を剥奪
    const ssId = localStorage.getItem('keihi_sheet_id');
    if (ssId && member.email) {
      Drive.revokeAccess(member.email, ssId)
        .then(() => App.showToast(`${member.name} のSS編集権限を削除しました`, 'success'))
        .catch(() => App.showToast('権限削除に失敗しました（Drive権限を確認してください）', 'warning'));
    }
  }

  async function _deleteSimpleItem(el, type, idx) {
    if (type === 'category') _master.categories.splice(idx, 1);
    else _master.paySources.splice(idx, 1);
    await _saveMasterToSheet(el);
  }

  async function _saveMasterToSheet(el) {
    // マスタ表を全行書き直す
    const maxRows = Math.max(_master.members.length, _master.categories.length, _master.paySources.length);
    const rows = [];
    for (let i = 0; i < maxRows; i++) {
      const m = _master.members[i]    || {};
      const c = _master.categories[i] || '';
      const p = _master.paySources[i] || '';
      // A:氏名 B:メール C:所属 D:権限 E:備考 F:会社払い支払元 G:勘定科目
      rows.push([m.name || '', m.email || '', m.dept || '', m.role || '', '', p, c]);
    }
    // ヘッダーを保持しながら2行目以降を上書き
    await Sheets.update(`マスタ表!A2:G${rows.length + 1}`, rows);
    App.showToast('保存しました', 'success');
    _renderAll(el);
    // AppのmasterキャッシュをクリアAして再読み込みさせる
    App.clearMasterCache();
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  return { render, bindEvents };
})();
