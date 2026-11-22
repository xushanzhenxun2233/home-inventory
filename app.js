/* 藏笺 主应用交互逻辑 */
(function () {
  const DB = window.HomeDB;

  const state = {
    tab: 'inventory',
    items: [],
    shoppingLists: [],
    shoppingItems: [],
    units: [],
    locations: [],
    categories: [],

    // Inventory filters
    search: '',
    locationFilter: '',
    categoryFilter: '',
    sort: 'updated',
    onlyLowStock: false,

    // Shopping filters
    activeListId: 'all',

    // Form temp state
    pendingPhotoDataUrl: '',
    pendingImportPayload: null,
    lanAvailable: false
  };

  /* ---------- Utilities ---------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatNum(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '0';
    return Number.isInteger(num) ? String(num) : String(Number(num.toFixed(2)));
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }

  function isLowStock(item) {
    return item.minStock !== '' && item.minStock !== null && item.minStock !== undefined &&
      Number(item.quantity) <= Number(item.minStock);
  }

  /* ---------- Load & Refresh ---------- */
  async function loadAll() {
    await DB.ensureDefaults();
    const [items, shoppingLists, shoppingItems, units, locations, categories] = await Promise.all([
      DB.getAll('items'),
      DB.getAll('shoppingLists'),
      DB.getAll('shoppingItems'),
      DB.getSetting('units', DB.DEFAULT_UNITS),
      DB.getSetting('locations', DB.DEFAULT_LOCATIONS),
      DB.getSetting('categories', DB.DEFAULT_CATEGORIES)
    ]);
    state.items = items;
    state.shoppingLists = shoppingLists.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    state.shoppingItems = shoppingItems;
    state.units = units;
    state.locations = locations;
    state.categories = categories;
    renderAll();
  }

  function renderAll() {
    renderBadges();
    renderInventory();
    renderShopping();
    renderSettings();
  }

  function renderBadges() {
    const pendingCount = state.shoppingItems.filter((s) => !s.checked).length;
    for (const id of ['#desktop-shop-badge', '#mobile-shop-badge']) {
      const badge = $(id);
      if (!badge) continue;
      badge.textContent = pendingCount > 99 ? '99+' : String(pendingCount);
      badge.classList.toggle('hidden', pendingCount === 0);
    }
  }

  /* ---------- Tab Switching ---------- */
  function switchTab(tab) {
    state.tab = tab;
    $$('.view-section').forEach((s) => s.classList.toggle('active', s.id === 'view-' + tab));
    $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));

    const fab = $('#fab-add');
    if (tab === 'inventory') {
      fab.style.display = 'inline-flex';
      fab.textContent = '＋ 记物品';
    } else if (tab === 'shopping') {
      fab.style.display = 'inline-flex';
      fab.textContent = '＋ 加采购';
    } else {
      fab.style.display = 'none';
      updateStorageInfo();
      checkLanSync();
    }
  }

  /* ---------- 1. Inventory Rendering ---------- */
  function renderInventory() {
    const photoCount = state.items.filter((i) => !!i.photoDataUrl).length;
    const lowCount = state.items.filter(isLowStock).length;

    $('#stat-item-count').textContent = state.items.length;
    $('#stat-photo-count').textContent = photoCount;
    $('#stat-low-count').textContent = lowCount;
    $('#btn-filter-low').classList.toggle('warning-active', state.onlyLowStock);

    // Category filter options
    const catSelect = $('#category-filter');
    const prevCat = state.categoryFilter;
    catSelect.innerHTML = '<option value="">全部分类</option>' +
      state.categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    catSelect.value = prevCat;

    // Location chips
    const usedLocations = new Set(state.locations);
    state.items.forEach((it) => { if (it.location) usedLocations.add(it.location); });
    const locContainer = $('#location-chips');
    const locChips = ['<button class="chip ' + (state.locationFilter === '' ? 'active' : '') + '" data-loc="">全部位置</button>'];
    usedLocations.forEach((loc) => {
      const count = state.items.filter((i) => i.location === loc).length;
      locChips.push(
        `<button class="chip ${state.locationFilter === loc ? 'active' : ''}" data-loc="${escapeHtml(loc)}">${escapeHtml(loc)}${count ? ' (' + count + ')' : ''}</button>`
      );
    });
    locContainer.innerHTML = locChips.join('');

    // Filter & sort
    const kw = state.search.trim().toLowerCase();
    let list = state.items.filter((it) => {
      if (state.onlyLowStock && !isLowStock(it)) return false;
      if (state.locationFilter && it.location !== state.locationFilter) return false;
      if (state.categoryFilter && it.category !== state.categoryFilter) return false;
      if (kw) {
        const hay = [it.name, it.location, it.locationDetail, it.category, it.note, it.unit].join(' ').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    if (state.sort === 'qty-asc') {
      list.sort((a, b) => Number(a.quantity) - Number(b.quantity));
    } else if (state.sort === 'name') {
      list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
    } else {
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    const grid = $('#items-container');
    if (list.length === 0) {
      if (state.items.length === 0) {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column: 1 / -1;">
            <div class="empty-icon">🏠</div>
            <h3>还没有记录任何家用物品</h3>
            <p>记录物品个数、计数单位与位置照片，再也不怕忘放哪儿或重复买啦。</p>
            <div class="empty-actions">
              <button class="btn btn-primary" id="btn-empty-add">＋ 记录第一件物品</button>
              <button class="btn btn-outline" id="btn-empty-demo">✨ 加载示例数据看看</button>
            </div>
          </div>`;
      } else {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column: 1 / -1;">
            <div class="empty-icon">🔍</div>
            <h3>没有找到匹配的物品</h3>
            <p>试试清空搜索词或切换位置筛选。</p>
          </div>`;
      }
      return;
    }

    grid.innerHTML = list.map((it) => {
      const low = isLowStock(it);
      const locText = [it.location, it.locationDetail].filter(Boolean).join(' · ');
      return `
        <article class="item-card ${low ? 'low-stock' : ''}" data-item-id="${escapeHtml(it.id)}">
          <div class="item-thumb-wrap" data-action="view-photo" title="${it.photoDataUrl ? '点击查看大图' : '点击编辑添加位置照片'}">
            ${it.photoDataUrl
              ? `<img src="${it.photoDataUrl}" alt="${escapeHtml(it.name)} 位置照片" loading="lazy" /><span class="thumb-badge">位置照</span>`
              : `<div class="thumb-placeholder"><span style="font-size:22px;">📷</span><span>无位置照</span></div>`}
          </div>
          <div class="item-body">
            <div>
              <div class="item-top">
                <h3 class="item-name">${escapeHtml(it.name)}</h3>
                <div class="item-actions">
                  <button class="btn-icon" data-action="edit" title="编辑">✏️</button>
                  <button class="btn-icon" data-action="delete" title="删除">🗑️</button>
                </div>
              </div>
              <div class="item-tags">
                ${locText ? `<span class="tag tag-loc">📍 ${escapeHtml(locText)}</span>` : ''}
                ${it.category ? `<span class="tag">${escapeHtml(it.category)}</span>` : ''}
                ${low ? `<span class="tag tag-low">⚠️ 需补货 (≤${formatNum(it.minStock)}${escapeHtml(it.unit)})</span>` : ''}
              </div>
              ${it.note ? `<p class="item-note" title="${escapeHtml(it.note)}">${escapeHtml(it.note)}</p>` : ''}
            </div>
            <div class="item-footer">
              <div class="stepper">
                <button class="stepper-btn" data-action="dec" aria-label="减少">−</button>
                <span class="stepper-val">${formatNum(it.quantity)} ${escapeHtml(it.unit)}</span>
                <button class="stepper-btn" data-action="inc" aria-label="增加">＋</button>
              </div>
              <button class="btn btn-soft btn-sm" data-action="to-shop">🛒 采购</button>
            </div>
          </div>
        </article>`;
    }).join('');
  }

  /* ---------- Inventory Modal & Actions ---------- */
  function renderQuickPicks(containerId, values, currentVal, inputId) {
    const el = document.getElementById(containerId);
    el.innerHTML = values.map((v) =>
      `<button type="button" class="quick-pick ${v === currentVal ? 'selected' : ''}" data-pick-val="${escapeHtml(v)}" data-pick-target="${inputId}">${escapeHtml(v)}</button>`
    ).join('');
  }

  function openItemModal(item) {
    $('#modal-item-title').textContent = item ? '编辑家用物品' : '添加家用物品';
    $('#item-id').value = item ? item.id : '';
    $('#item-name').value = item ? item.name : '';
    $('#item-qty').value = item ? item.quantity : 1;
    $('#item-unit').value = item ? item.unit : (state.units[0] || '个');
    $('#item-min-stock').value = (item && item.minStock !== '' && item.minStock != null) ? item.minStock : '';
    $('#item-location').value = item ? (item.location || '') : '';
    $('#item-location-detail').value = item ? (item.locationDetail || '') : '';
    $('#item-note').value = item ? (item.note || '') : '';

    const catSel = $('#item-category');
    catSel.innerHTML = state.categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    catSel.value = (item && item.category) ? item.category : (state.categories[0] || '其他');

    renderQuickPicks('item-unit-picks', state.units, $('#item-unit').value, 'item-unit');
    renderQuickPicks('item-location-picks', state.locations, $('#item-location').value, 'item-location');

    state.pendingPhotoDataUrl = item ? (item.photoDataUrl || '') : '';
    updatePhotoPreview();
    openModal('modal-item');
    setTimeout(() => $('#item-name').focus(), 120);
  }

  function updatePhotoPreview() {
    const box = $('#item-photo-preview-box');
    const img = $('#item-photo-preview');
    if (state.pendingPhotoDataUrl) {
      img.src = state.pendingPhotoDataUrl;
      box.classList.add('has-photo');
    } else {
      img.removeAttribute('src');
      box.classList.remove('has-photo');
    }
  }

  async function handlePhotoSelected(file) {
    if (!file) return;
    try {
      showToast('正在压缩位置照片...');
      const dataUrl = await DB.compressImage(file, 1280, 0.78);
      state.pendingPhotoDataUrl = dataUrl;
      updatePhotoPreview();
      showToast('位置照片已添加');
    } catch (err) {
      showToast(err.message || '图片处理失败');
    }
  }

  async function saveItemForm(e) {
    e.preventDefault();
    const id = $('#item-id').value || DB.uid('item');
    const name = $('#item-name').value.trim();
    const quantity = Math.max(0, Number($('#item-qty').value) || 0);
    const unit = $('#item-unit').value.trim() || '个';
    const minStockRaw = $('#item-min-stock').value.trim();
    const minStock = minStockRaw === '' ? '' : Math.max(0, Number(minStockRaw));
    const category = $('#item-category').value;
    const location = $('#item-location').value.trim();
    const locationDetail = $('#item-location-detail').value.trim();
    const note = $('#item-note').value.trim();

    if (!name) return;

    const existing = state.items.find((i) => i.id === id);
    const record = {
      id,
      name,
      quantity,
      unit,
      minStock,
      category,
      location,
      locationDetail,
      note,
      photoDataUrl: state.pendingPhotoDataUrl || '',
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now()
    };

    await DB.put('items', record);

    // Auto-remember new custom unit or location
    if (unit && !state.units.includes(unit)) {
      await DB.setSetting('units', [...state.units, unit]);
    }
    if (location && !state.locations.includes(location)) {
      await DB.setSetting('locations', [...state.locations, location]);
    }

    closeModal('modal-item');
    await loadAll();
    showToast(existing ? '已更新物品' : '已添加物品：' + name);
  }

  async function adjustQuantity(itemId, delta) {
    const it = state.items.find((i) => i.id === itemId);
    if (!it) return;
    const next = Math.max(0, Number((Number(it.quantity) + delta).toFixed(2)));
    it.quantity = next;
    it.updatedAt = Date.now();
    await DB.put('items', it);
    await loadAll();
  }

  /* ---------- 2. Shopping List Rendering & Actions ---------- */
  function renderShopping() {
    // List tabs
    const tabsEl = $('#shop-list-tabs');
    const allPending = state.shoppingItems.filter((s) => !s.checked).length;
    const tabsHtml = [
      `<button class="chip ${state.activeListId === 'all' ? 'active' : ''}" data-shop-list="all">全部清单 (${allPending})</button>`
    ];
    for (const l of state.shoppingLists) {
      const cnt = state.shoppingItems.filter((s) => s.listId === l.id && !s.checked).length;
      tabsHtml.push(
        `<button class="chip ${state.activeListId === l.id ? 'active' : ''}" data-shop-list="${escapeHtml(l.id)}">${escapeHtml(l.icon || '🛒')} ${escapeHtml(l.name)}${cnt ? ' (' + cnt + ')' : ''}</button>`
      );
    }
    tabsEl.innerHTML = tabsHtml.join('');

    const visibleItems = state.shoppingItems.filter((s) =>
      state.activeListId === 'all' ? true : s.listId === state.activeListId
    );
    const unchecked = visibleItems
      .filter((s) => !s.checked)
      .sort((a, b) => (b.priority === 'high' ? 1 : 0) - (a.priority === 'high' ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));
    const checked = visibleItems
      .filter((s) => s.checked)
      .sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0));

    const checkedBar = $('#shop-checked-bar');
    if (checked.length > 0) {
      checkedBar.style.display = 'block';
      $('#shop-checked-summary').textContent = `已勾选 ${checked.length} 项待入库/清理`;
    } else {
      checkedBar.style.display = 'none';
    }

    const container = $('#shopping-container');
    if (visibleItems.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🛒</div>
          <h3>当前采购清单为空</h3>
          <p>点击右下角「＋ 加采购」自由添加采购项，或点击上方「导入低库存」自动补货。</p>
        </div>`;
      return;
    }

    const listMap = new Map(state.shoppingLists.map((l) => [l.id, l]));
    const renderRow = (s) => {
      const listInfo = listMap.get(s.listId);
      const linked = s.linkedItemId ? state.items.find((i) => i.id === s.linkedItemId) : null;
      return `
        <div class="shop-row ${s.checked ? 'checked' : ''}" data-shop-id="${escapeHtml(s.id)}">
          <input type="checkbox" class="shop-check" ${s.checked ? 'checked' : ''} aria-label="勾选已购" />
          <div class="shop-info">
            <div class="shop-item-name">
              <span>${escapeHtml(s.name)}</span>
              ${s.priority === 'high' ? '<span class="priority-dot">急需</span>' : ''}
            </div>
            <div class="shop-meta">
              ${state.activeListId === 'all' && listInfo ? `<span>${escapeHtml(listInfo.icon || '')} ${escapeHtml(listInfo.name)}</span> · ` : ''}
              ${linked ? `<span>库存现有 ${formatNum(linked.quantity)}${escapeHtml(linked.unit)}</span>` : '<span>自定义采购</span>'}
              ${s.note ? ` · ${escapeHtml(s.note)}` : ''}
            </div>
          </div>
          <span class="shop-qty-pill">${formatNum(s.quantity)} ${escapeHtml(s.unit)}</span>
          <button class="btn-icon" data-shop-action="edit" title="编辑">✏️</button>
          <button class="btn-icon" data-shop-action="delete" title="删除">🗑️</button>
        </div>`;
    };

    let html = '';
    if (unchecked.length > 0) {
      html += `
        <div class="shop-list-card">
          <div class="shop-group-title"><span>待采购 (${unchecked.length})</span><span>点击左侧圆框勾选已买</span></div>
          ${unchecked.map(renderRow).join('')}
        </div>`;
    }
    if (checked.length > 0) {
      html += `
        <div class="shop-list-card">
          <div class="shop-group-title"><span>已采购 (${checked.length})</span><span>可一键入库更新库存</span></div>
          ${checked.map(renderRow).join('')}
        </div>`;
    }
    container.innerHTML = html;
  }

  function openShopModal(opts) {
    const item = opts && opts.shopItem ? opts.shopItem : null;
    const fromInventory = opts && opts.fromInventory ? opts.fromInventory : null;

    $('#modal-shop-title').textContent = item ? '编辑采购项' : '添加到采购清单';
    $('#shop-id').value = item ? item.id : '';
    $('#shop-linked-item-id').value = item ? (item.linkedItemId || '') : (fromInventory ? fromInventory.id : '');
    $('#shop-name').value = item ? item.name : (fromInventory ? fromInventory.name : '');
    $('#shop-qty').value = item ? item.quantity : 1;
    $('#shop-unit').value = item ? item.unit : (fromInventory ? fromInventory.unit : (state.units[0] || '个'));
    $('#shop-priority').value = item ? (item.priority || 'normal') : (fromInventory && isLowStock(fromInventory) ? 'high' : 'normal');
    $('#shop-note').value = item ? (item.note || '') : (fromInventory && fromInventory.note ? fromInventory.note : '');

    const sel = $('#shop-list-select');
    sel.innerHTML = state.shoppingLists.map((l) =>
      `<option value="${escapeHtml(l.id)}">${escapeHtml(l.icon || '🛒')} ${escapeHtml(l.name)}</option>`
    ).join('');
    if (item && item.listId) {
      sel.value = item.listId;
    } else if (state.activeListId !== 'all') {
      sel.value = state.activeListId;
    } else if (state.shoppingLists[0]) {
      sel.value = state.shoppingLists[0].id;
    }

    renderQuickPicks('shop-unit-picks', state.units, $('#shop-unit').value, 'shop-unit');
    openModal('modal-shop');
    setTimeout(() => $('#shop-name').focus(), 120);
  }

  async function saveShopForm(e) {
    e.preventDefault();
    const id = $('#shop-id').value || DB.uid('shop');
    const name = $('#shop-name').value.trim();
    const quantity = Math.max(0.1, Number($('#shop-qty').value) || 1);
    const unit = $('#shop-unit').value.trim() || '个';
    const listId = $('#shop-list-select').value || (state.shoppingLists[0] && state.shoppingLists[0].id) || 'list-daily';
    const priority = $('#shop-priority').value;
    const note = $('#shop-note').value.trim();
    const linkedItemId = $('#shop-linked-item-id').value || '';

    if (!name) return;

    const existing = state.shoppingItems.find((s) => s.id === id);
    await DB.put('shoppingItems', {
      id,
      listId,
      linkedItemId,
      name,
      quantity,
      unit,
      priority,
      note,
      checked: existing ? existing.checked : false,
      createdAt: existing ? existing.createdAt : Date.now(),
      checkedAt: existing ? existing.checkedAt : null
    });

    if (unit && !state.units.includes(unit)) {
      await DB.setSetting('units', [...state.units, unit]);
    }

    closeModal('modal-shop');
    await loadAll();
    showToast(existing ? '已更新采购项' : '已加入采购清单：' + name);
  }

  async function importLowStockToShopping() {
    const lowItems = state.items.filter(isLowStock);
    if (lowItems.length === 0) {
      showToast('目前没有低于预警阈值的物品');
      return;
    }
    const targetListId = state.activeListId !== 'all'
      ? state.activeListId
      : (state.shoppingLists[0] ? state.shoppingLists[0].id : 'list-daily');

    let added = 0;
    for (const it of lowItems) {
      const already = state.shoppingItems.find((s) => !s.checked && (s.linkedItemId === it.id || s.name === it.name));
      if (already) continue;
      const suggestQty = Math.max(1, Number(it.minStock || 1) - Number(it.quantity || 0) + 1);
      await DB.put('shoppingItems', {
        id: DB.uid('shop'),
        listId: targetListId,
        linkedItemId: it.id,
        name: it.name,
        quantity: suggestQty,
        unit: it.unit,
        priority: 'high',
        note: it.note || '',
        checked: false,
        createdAt: Date.now()
      });
      added++;
    }
    await loadAll();
    showToast(added > 0 ? `已自动加入 ${added} 件低库存物品到采购清单` : '所有低库存物品都已在采购清单中');
  }

  async function restockCheckedItems() {
    const visibleChecked = state.shoppingItems.filter((s) =>
      s.checked && (state.activeListId === 'all' || s.listId === state.activeListId)
    );
    if (visibleChecked.length === 0) return;

    let updatedCount = 0;
    let createdCount = 0;

    for (const s of visibleChecked) {
      let target = s.linkedItemId ? state.items.find((i) => i.id === s.linkedItemId) : null;
      if (!target) {
        target = state.items.find((i) => i.name === s.name && i.unit === s.unit);
      }
      if (target) {
        target.quantity = Number((Number(target.quantity) + Number(s.quantity)).toFixed(2));
        target.updatedAt = Date.now();
        await DB.put('items', target);
        updatedCount++;
      } else {
        await DB.put('items', {
          id: DB.uid('item'),
          name: s.name,
          quantity: Number(s.quantity),
          unit: s.unit,
          minStock: '',
          category: '日用百货',
          location: '',
          locationDetail: '',
          note: s.note || '',
          photoDataUrl: '',
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        createdCount++;
      }
      await DB.remove('shoppingItems', s.id);
    }

    await loadAll();
    showToast(`入库完成：更新 ${updatedCount} 件库存，新增 ${createdCount} 件物品`);
  }

  async function copyShoppingListText() {
    const pending = state.shoppingItems.filter((s) =>
      !s.checked && (state.activeListId === 'all' || s.listId === state.activeListId)
    );
    if (pending.length === 0) {
      showToast('当前没有待采购物品可复制');
      return;
    }
    const activeList = state.shoppingLists.find((l) => l.id === state.activeListId);
    const title = activeList ? `【${activeList.name}】采购清单` : '【家用采购清单】';
    const lines = [title];
    pending.forEach((s, idx) => {
      lines.push(`${idx + 1}. ${s.priority === 'high' ? '[急] ' : ''}${s.name} × ${formatNum(s.quantity)}${s.unit}${s.note ? '（' + s.note + '）' : ''}`);
    });
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制采购清单，可直接粘贴到微信');
    } catch {
      prompt('请手动复制以下采购清单：', text);
    }
  }

  /* ---------- Custom Shopping Lists Manager ---------- */
  function renderListsManager() {
    const box = $('#custom-lists-editor');
    box.innerHTML = state.shoppingLists.map((l) => `
      <div style="display:flex; align-items:center; gap:8px;">
        <input type="text" value="${escapeHtml(l.icon || '🛒')}" data-list-icon="${escapeHtml(l.id)}" style="width:48px; text-align:center; padding:7px; border:1px solid var(--border); border-radius:8px;" maxlength="4" />
        <input type="text" value="${escapeHtml(l.name)}" data-list-name="${escapeHtml(l.id)}" style="flex:1; padding:7px 10px; border:1px solid var(--border); border-radius:8px;" maxlength="20" />
        <button type="button" class="btn btn-soft btn-sm" data-save-list="${escapeHtml(l.id)}">保存</button>
        ${state.shoppingLists.length > 1 ? `<button type="button" class="btn btn-danger-soft btn-sm" data-del-list="${escapeHtml(l.id)}">删</button>` : ''}
      </div>`).join('');
  }

  /* ---------- 3. Settings & Migration ---------- */
  function renderSettings() {
    $('#units-manager').innerHTML = state.units.map((u) =>
      `<span class="tag-removable">${escapeHtml(u)} <button data-remove-unit="${escapeHtml(u)}" title="删除">×</button></span>`
    ).join('');

    $('#locations-manager').innerHTML = state.locations.map((loc) =>
      `<span class="tag-removable">${escapeHtml(loc)} <button data-remove-loc="${escapeHtml(loc)}" title="删除">×</button></span>`
    ).join('');
  }

  async function updateStorageInfo() {
    try {
      const bytes = await DB.estimateStorageBytes();
      const photos = state.items.filter((i) => !!i.photoDataUrl).length;
      $('#storage-info-text').textContent =
        `当前共存储 ${state.items.length} 件物品（含 ${photos} 张位置照片）、${state.shoppingItems.length} 条采购记录，完整迁移包预计体积约 ${formatBytes(bytes)}。`;
    } catch {
      $('#storage-info-text').textContent = '本地 IndexedDB 数据库运行正常。';
    }
  }

  async function exportBackupFile() {
    try {
      const payload = await DB.exportAllData();
      const jsonStr = JSON.stringify(payload);
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      const filename = `藏笺备份-${stamp}.json`;
      const blob = new Blob([jsonStr], { type: 'application/json' });

      // 移动端优先尝试系统分享（可直接发微信 / AirDrop / 保存到文件）
      if (navigator.share && typeof File !== 'undefined') {
        try {
          const shareFile = new File([blob], filename, { type: 'application/json' });
          if (!navigator.canShare || navigator.canShare({ files: [shareFile] })) {
            await navigator.share({
              title: '藏笺完整数据迁移包',
              text: '包含全部家用物品、位置照片与采购清单',
              files: [shareFile]
            });
            showToast(`已分享完整迁移包（${formatBytes(blob.size)}）`);
            return;
          }
        } catch (shareErr) {
          if (shareErr && shareErr.name === 'AbortError') return;
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`已导出完整迁移包（${formatBytes(blob.size)}），可发送到手机导入`);
    } catch (err) {
      showToast('导出失败：' + (err.message || err));
    }
  }

  function exportCsvFile() {
    const header = ['物品名称', '当前数量', '计数单位', '低库存阈值', '分类', '存放区域', '具体位置', '备注', '是否有位置照'];
    const rows = state.items.map((i) => [
      i.name,
      i.quantity,
      i.unit,
      i.minStock === '' || i.minStock == null ? '' : i.minStock,
      i.category || '',
      i.location || '',
      i.locationDetail || '',
      i.note || '',
      i.photoDataUrl ? '有' : '无'
    ]);
    const csv = '\uFEFF' + [header, ...rows]
      .map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(','))
      .join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '家用物品清单.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('已导出 Excel 表格 (.csv)');
  }

  function openImportConfirm(payload, sourceLabel) {
    if (!payload || payload.app !== 'HomeInventory' || !payload.data) {
      showToast('数据格式不正确，请选择有效的「藏笺」备份文件');
      return;
    }
    state.pendingImportPayload = payload;
    const items = payload.data.items || [];
    const photos = items.filter((i) => !!i.photoDataUrl).length;
    const shops = payload.data.shoppingItems || [];
    $('#import-preview-text').textContent =
      `已读取${sourceLabel}：包含 ${items.length} 件物品（${photos} 张位置照片）、${shops.length} 条采购项。请选择导入方式：`;
    openModal('modal-import');
  }

  /* ---------- LAN Wi-Fi Sync (when served via lan-server.ps1) ---------- */
  async function checkLanSync() {
    const panel = $('#lan-sync-panel');
    const status = $('#lan-status-text');
    const actions = $('#lan-sync-actions');

    if (!location.protocol.startsWith('http')) {
      state.lanAvailable = false;
      panel.classList.remove('connected');
      actions.style.display = 'none';
      status.innerHTML = '当前为本地直接打开模式。如需电脑与手机同 Wi-Fi 一键无线互传，请在电脑双击 <code>启动局域网手机访问.bat</code>。';
      return;
    }

    try {
      const res = await fetch('/api/ping', { cache: 'no-store' });
      if (!res.ok) throw new Error('no');
      const info = await res.json();
      state.lanAvailable = true;
      panel.classList.add('connected');
      actions.style.display = 'flex';
      status.textContent = info.hasSnapshot
        ? `已连接局域网同步服务！中转区已有备份（更新于 ${new Date(info.updatedAt).toLocaleString()}），手机和电脑可随时一键互传。`
        : '已连接局域网同步服务！先在电脑点「推送本机数据」，再到手机浏览器打开同网址点「从局域网拉取」即可完成迁移。';
    } catch {
      state.lanAvailable = false;
      panel.classList.remove('connected');
      actions.style.display = 'none';
      status.innerHTML = '未检测到局域网同步服务（静态托管模式下请使用上方的「离线完整迁移包」）。';
    }
  }

  async function lanPush() {
    try {
      showToast('正在推送数据（含照片）到局域网...');
      const payload = await DB.exportAllData();
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('推送失败');
      await checkLanSync();
      showToast('推送成功！现在可在手机端点击「从局域网拉取」');
    } catch (err) {
      showToast('推送失败：' + (err.message || err));
    }
  }

  async function lanPull() {
    try {
      showToast('正在从局域网拉取数据...');
      const res = await fetch('/api/sync', { cache: 'no-store' });
      if (res.status === 404) {
        showToast('局域网中转区暂无数据，请先在另一台设备点击「推送」');
        return;
      }
      if (!res.ok) throw new Error('拉取失败');
      const payload = await res.json();
      openImportConfirm(payload, '局域网同步数据');
    } catch (err) {
      showToast('拉取失败：' + (err.message || err));
    }
  }

  /* ---------- Event Wiring ---------- */
  function bindEvents() {
    // Navigation tabs
    $$('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // FAB
    $('#fab-add').addEventListener('click', () => {
      if (state.tab === 'shopping') openShopModal();
      else openItemModal(null);
    });

    // Close modals
    $$('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });
    $$('.modal-backdrop').forEach((bg) => {
      bg.addEventListener('click', (e) => {
        if (e.target === bg) bg.classList.remove('open');
      });
    });

    // Inventory filters
    $('#search-input').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderInventory();
    });
    $('#category-filter').addEventListener('change', (e) => {
      state.categoryFilter = e.target.value;
      renderInventory();
    });
    $('#sort-select').addEventListener('change', (e) => {
      state.sort = e.target.value;
      renderInventory();
    });
    $('#btn-filter-low').addEventListener('click', () => {
      state.onlyLowStock = !state.onlyLowStock;
      renderInventory();
    });
    $('#location-chips').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-loc]');
      if (!btn) return;
      state.locationFilter = btn.dataset.loc;
      renderInventory();
    });

    // Inventory item card actions
    $('#items-container').addEventListener('click', async (e) => {
      if (e.target.closest('#btn-empty-add')) {
        openItemModal(null);
        return;
      }
      if (e.target.closest('#btn-empty-demo')) {
        await DB.loadDemoData();
        await loadAll();
        showToast('已加载 4 件示例物品与采购清单');
        return;
      }

      const card = e.target.closest('[data-item-id]');
      if (!card) return;
      const itemId = card.dataset.itemId;
      const item = state.items.find((i) => i.id === itemId);
      if (!item) return;

      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;

      if (action === 'inc') {
        await adjustQuantity(itemId, 1);
      } else if (action === 'dec') {
        await adjustQuantity(itemId, -1);
      } else if (action === 'edit') {
        openItemModal(item);
      } else if (action === 'delete') {
        if (confirm(`确定删除物品「${item.name}」吗？`)) {
          await DB.remove('items', itemId);
          await loadAll();
          showToast('已删除：' + item.name);
        }
      } else if (action === 'to-shop') {
        openShopModal({ fromInventory: item });
      } else if (action === 'view-photo') {
        if (item.photoDataUrl) {
          $('#lightbox-img').src = item.photoDataUrl;
          const loc = [item.location, item.locationDetail].filter(Boolean).join(' · ');
          $('#lightbox-caption').textContent = `${item.name}${loc ? ' — 📍 ' + loc : ''}`;
          $('#lightbox').classList.add('open');
        } else {
          openItemModal(item);
        }
      }
    });

    // Quick pick buttons inside forms
    document.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-pick-val]');
      if (!pick) return;
      const target = document.getElementById(pick.dataset.pickTarget);
      if (target) {
        target.value = pick.dataset.pickVal;
        const parent = pick.parentElement;
        parent.querySelectorAll('.quick-pick').forEach((p) => p.classList.toggle('selected', p === pick));
      }
    });

    // Photo inputs
    $('#item-photo-camera').addEventListener('change', (e) => {
      handlePhotoSelected(e.target.files[0]);
      e.target.value = '';
    });
    $('#item-photo-gallery').addEventListener('change', (e) => {
      handlePhotoSelected(e.target.files[0]);
      e.target.value = '';
    });
    $('#btn-remove-photo').addEventListener('click', () => {
      state.pendingPhotoDataUrl = '';
      updatePhotoPreview();
    });

    // Lightbox close
    $('#lightbox-close').addEventListener('click', () => $('#lightbox').classList.remove('open'));
    $('#lightbox').addEventListener('click', (e) => {
      if (e.target === $('#lightbox')) $('#lightbox').classList.remove('open');
    });

    // Forms submit
    $('#form-item').addEventListener('submit', saveItemForm);
    $('#form-shop').addEventListener('submit', saveShopForm);

    // Shopping tabs & actions
    $('#shop-list-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-shop-list]');
      if (!btn) return;
      state.activeListId = btn.dataset.shopList;
      renderShopping();
    });

    $('#shopping-container').addEventListener('change', async (e) => {
      if (!e.target.classList.contains('shop-check')) return;
      const row = e.target.closest('[data-shop-id]');
      const s = state.shoppingItems.find((x) => x.id === row.dataset.shopId);
      if (!s) return;
      s.checked = e.target.checked;
      s.checkedAt = s.checked ? Date.now() : null;
      await DB.put('shoppingItems', s);
      await loadAll();
    });

    $('#shopping-container').addEventListener('click', async (e) => {
      const actBtn = e.target.closest('[data-shop-action]');
      if (!actBtn) return;
      const row = e.target.closest('[data-shop-id]');
      const s = state.shoppingItems.find((x) => x.id === row.dataset.shopId);
      if (!s) return;
      if (actBtn.dataset.shopAction === 'edit') {
        openShopModal({ shopItem: s });
      } else if (actBtn.dataset.shopAction === 'delete') {
        await DB.remove('shoppingItems', s.id);
        await loadAll();
        showToast('已移除采购项');
      }
    });

    $('#btn-import-low-stock').addEventListener('click', importLowStockToShopping);
    $('#btn-copy-shop-text').addEventListener('click', copyShoppingListText);
    $('#btn-restock-checked').addEventListener('click', restockCheckedItems);
    $('#btn-clear-checked').addEventListener('click', async () => {
      const visibleChecked = state.shoppingItems.filter((s) =>
        s.checked && (state.activeListId === 'all' || s.listId === state.activeListId)
      );
      for (const s of visibleChecked) {
        await DB.remove('shoppingItems', s.id);
      }
      await loadAll();
      showToast('已清除已购项');
    });

    // Manage custom shopping lists
    $('#btn-manage-lists').addEventListener('click', () => {
      renderListsManager();
      openModal('modal-lists');
    });

    $('#btn-create-list').addEventListener('click', async () => {
      const name = $('#new-list-name').value.trim();
      const icon = $('#new-list-icon').value.trim() || '🛍️';
      if (!name) return;
      await DB.put('shoppingLists', { id: DB.uid('list'), name, icon, createdAt: Date.now() });
      $('#new-list-name').value = '';
      await loadAll();
      renderListsManager();
      showToast('已新建采购清单：' + name);
    });

    $('#custom-lists-editor').addEventListener('click', async (e) => {
      const saveBtn = e.target.closest('[data-save-list]');
      if (saveBtn) {
        const id = saveBtn.dataset.saveList;
        const list = state.shoppingLists.find((l) => l.id === id);
        if (!list) return;
        const nameInput = $(`[data-list-name="${id}"]`);
        const iconInput = $(`[data-list-icon="${id}"]`);
        const newName = nameInput.value.trim();
        if (!newName) return;
        list.name = newName;
        list.icon = iconInput.value.trim() || '🛒';
        await DB.put('shoppingLists', list);
        await loadAll();
        renderListsManager();
        showToast('已保存清单名称');
        return;
      }

      const delBtn = e.target.closest('[data-del-list]');
      if (delBtn) {
        const id = delBtn.dataset.delList;
        if (state.shoppingLists.length <= 1) return;
        if (!confirm('删除此清单后，清单内的采购项会移动到第一个清单，确定删除吗？')) return;
        const fallbackId = state.shoppingLists.find((l) => l.id !== id).id;
        for (const s of state.shoppingItems.filter((x) => x.listId === id)) {
          s.listId = fallbackId;
          await DB.put('shoppingItems', s);
        }
        await DB.remove('shoppingLists', id);
        if (state.activeListId === id) state.activeListId = 'all';
        await loadAll();
        renderListsManager();
        showToast('已删除采购清单');
      }
    });

    // Settings: Units & Locations
    $('#btn-add-unit').addEventListener('click', async () => {
      const val = $('#new-unit-input').value.trim();
      if (!val || state.units.includes(val)) return;
      await DB.setSetting('units', [...state.units, val]);
      $('#new-unit-input').value = '';
      await loadAll();
      showToast('已添加单位：' + val);
    });

    $('#units-manager').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-remove-unit]');
      if (!btn) return;
      const val = btn.dataset.removeUnit;
      await DB.setSetting('units', state.units.filter((u) => u !== val));
      await loadAll();
    });

    $('#btn-add-location').addEventListener('click', async () => {
      const val = $('#new-location-input').value.trim();
      if (!val || state.locations.includes(val)) return;
      await DB.setSetting('locations', [...state.locations, val]);
      $('#new-location-input').value = '';
      await loadAll();
      showToast('已添加存放区域：' + val);
    });

    $('#locations-manager').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-remove-loc]');
      if (!btn) return;
      const val = btn.dataset.removeLoc;
      await DB.setSetting('locations', state.locations.filter((l) => l !== val));
      await loadAll();
    });

    // Backup & Migration
    $('#btn-export-backup').addEventListener('click', exportBackupFile);
    $('#btn-export-csv').addEventListener('click', exportCsvFile);
    $('#btn-import-backup').addEventListener('click', () => $('#import-file-input').click());
    $('#import-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        openImportConfirm(payload, `备份文件「${file.name}」`);
      } catch {
        showToast('无法解析该 JSON 文件，请确认文件完整');
      }
    });

    $('#btn-confirm-merge').addEventListener('click', async () => {
      if (!state.pendingImportPayload) return;
      try {
        const res = await DB.importAllData(state.pendingImportPayload, 'merge');
        closeModal('modal-import');
        state.pendingImportPayload = null;
        await loadAll();
        await updateStorageInfo();
        showToast(`合并完成：导入 ${res.itemsCount} 件物品、${res.shoppingItemsCount} 条采购项`);
      } catch (err) {
        showToast(err.message || '导入失败');
      }
    });

    $('#btn-confirm-replace').addEventListener('click', async () => {
      if (!state.pendingImportPayload) return;
      if (!confirm('确定要清空本机现有数据并完全覆盖为备份内容吗？')) return;
      try {
        const res = await DB.importAllData(state.pendingImportPayload, 'replace');
        closeModal('modal-import');
        state.pendingImportPayload = null;
        await loadAll();
        await updateStorageInfo();
        showToast(`恢复完成：共 ${res.itemsCount} 件物品、${res.shoppingItemsCount} 条采购项`);
      } catch (err) {
        showToast(err.message || '恢复失败');
      }
    });

    // LAN Sync buttons
    $('#btn-lan-push').addEventListener('click', lanPush);
    $('#btn-lan-pull').addEventListener('click', lanPull);

    // Demo & Clear
    $('#btn-load-demo').addEventListener('click', async () => {
      await DB.loadDemoData();
      await loadAll();
      await updateStorageInfo();
      showToast('已加载示例物品与采购清单');
    });

    $('#btn-clear-all').addEventListener('click', async () => {
      if (!confirm('⚠️ 确定要清空全部物品、位置照片和采购清单吗？建议先导出备份！')) return;
      await DB.clearAllData();
      await loadAll();
      await updateStorageInfo();
      showToast('已清空全部数据');
    });
  }

  /* ---------- Register PWA Service Worker ---------- */
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  /* ---------- Init ---------- */
  bindEvents();
  loadAll().then(() => {
    updateStorageInfo();
    checkLanSync();
  });
})();
