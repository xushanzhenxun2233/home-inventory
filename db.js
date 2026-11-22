/* 家物志 IndexedDB 本地持久化与完整迁移模块 */
(function (global) {
  const DB_NAME = 'HomeInventoryDB';
  const DB_VERSION = 1;

  const DEFAULT_UNITS = ['个', '瓶', '盒', '袋', '卷', '包', '罐', '支', '套', '双', '箱', '把', '桶', 'kg', 'L'];
  const DEFAULT_LOCATIONS = ['厨房', '客厅', '卫生间', '卧室', '阳台', '玄关', '冰箱', '储物间', '书房'];
  const DEFAULT_CATEGORIES = ['日用百货', '清洁洗护', '食品饮料', '厨房调料', '医药保健', '工具五金', '数码电池', '其他'];

  const DEFAULT_SHOPPING_LISTS = [
    { id: 'list-daily', name: '日常补货', icon: '🛒', createdAt: Date.now() },
    { id: 'list-market', name: '超市生鲜', icon: '🥬', createdAt: Date.now() + 1 },
    { id: 'list-online', name: '网购清单', icon: '📦', createdAt: Date.now() + 2 }
  ];

  let dbInstance = null;

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('items')) {
          const store = db.createObjectStore('items', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('location', 'location', { unique: false });
        }
        if (!db.objectStoreNames.contains('shoppingLists')) {
          db.createObjectStore('shoppingLists', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('shoppingItems')) {
          const sStore = db.createObjectStore('shoppingItems', { keyPath: 'id' });
          sStore.createIndex('listId', 'listId', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => {
        dbInstance = e.target.result;
        resolve(dbInstance);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(storeNames, mode) {
    return openDB().then((db) => db.transaction(storeNames, mode || 'readonly'));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll(storeName) {
    const t = await tx(storeName, 'readonly');
    return reqToPromise(t.objectStore(storeName).getAll());
  }

  async function put(storeName, value) {
    const t = await tx(storeName, 'readwrite');
    return reqToPromise(t.objectStore(storeName).put(value));
  }

  async function remove(storeName, key) {
    const t = await tx(storeName, 'readwrite');
    return reqToPromise(t.objectStore(storeName).delete(key));
  }

  async function getSetting(key, fallback) {
    const t = await tx('settings', 'readonly');
    const row = await reqToPromise(t.objectStore('settings').get(key));
    return row ? row.value : fallback;
  }

  async function setSetting(key, value) {
    return put('settings', { key, value });
  }

  async function ensureDefaults() {
    const lists = await getAll('shoppingLists');
    if (lists.length === 0) {
      for (const l of DEFAULT_SHOPPING_LISTS) {
        await put('shoppingLists', l);
      }
    }
    const units = await getSetting('units', null);
    if (!units) await setSetting('units', DEFAULT_UNITS);

    const locations = await getSetting('locations', null);
    if (!locations) await setSetting('locations', DEFAULT_LOCATIONS);

    const categories = await getSetting('categories', null);
    if (!categories) await setSetting('categories', DEFAULT_CATEGORIES);
  }

  /* 将上传或拍摄的图片压缩为清晰且体积轻量的 JPEG DataURL，便于迁移到手机 */
  function compressImage(file, maxSide = 1280, quality = 0.78) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('解析图片失败'));
        img.onload = () => {
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          if (w > maxSide || h > maxSide) {
            if (w >= h) {
              h = Math.round((h * maxSide) / w);
              w = maxSide;
            } else {
              w = Math.round((w * maxSide) / h);
              h = maxSide;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          resolve(dataUrl);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* 导出全部数据（含所有物品、位置照片、自定义单位、位置、采购清单） */
  async function exportAllData() {
    const [items, shoppingLists, shoppingItems, settingsRows] = await Promise.all([
      getAll('items'),
      getAll('shoppingLists'),
      getAll('shoppingItems'),
      getAll('settings')
    ]);
    return {
      app: 'HomeInventory',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        items,
        shoppingLists,
        shoppingItems,
        settings: settingsRows
      }
    };
  }

  /* 导入迁移包：mode = 'merge'（智能合并） 或 'replace'（完全覆盖恢复） */
  async function importAllData(payload, mode = 'merge') {
    if (!payload || payload.app !== 'HomeInventory' || !payload.data) {
      throw new Error('文件格式不正确，请选择由「家物志」导出的备份文件 (.json)');
    }
    const { items = [], shoppingLists = [], shoppingItems = [], settings = [] } = payload.data;

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(['items', 'shoppingLists', 'shoppingItems', 'settings'], 'readwrite');
      const itemStore = t.objectStore('items');
      const listStore = t.objectStore('shoppingLists');
      const shopStore = t.objectStore('shoppingItems');
      const setStore = t.objectStore('settings');

      if (mode === 'replace') {
        itemStore.clear();
        listStore.clear();
        shopStore.clear();
        setStore.clear();
      }

      for (const it of items) {
        if (it && it.id) itemStore.put(it);
      }
      for (const l of shoppingLists) {
        if (l && l.id) listStore.put(l);
      }
      for (const s of shoppingItems) {
        if (s && s.id) shopStore.put(s);
      }
      for (const st of settings) {
        if (st && st.key) {
          if (mode === 'merge' && Array.isArray(st.value)) {
            const existingReq = setStore.get(st.key);
            existingReq.onsuccess = () => {
              const prev = existingReq.result && Array.isArray(existingReq.result.value) ? existingReq.result.value : [];
              const merged = Array.from(new Set([...prev, ...st.value]));
              setStore.put({ key: st.key, value: merged });
            };
          } else {
            setStore.put(st);
          }
        }
      }

      t.oncomplete = () => resolve({
        itemsCount: items.length,
        listsCount: shoppingLists.length,
        shoppingItemsCount: shoppingItems.length
      });
      t.onerror = () => reject(t.error || new Error('导入数据时发生错误'));
    });
  }

  async function clearAllData() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(['items', 'shoppingLists', 'shoppingItems', 'settings'], 'readwrite');
      t.objectStore('items').clear();
      t.objectStore('shoppingLists').clear();
      t.objectStore('shoppingItems').clear();
      t.objectStore('settings').clear();
      t.oncomplete = async () => {
        await ensureDefaults();
        resolve();
      };
      t.onerror = () => reject(t.error);
    });
  }

  async function loadDemoData() {
    await ensureDefaults();
    const now = Date.now();
    const demoItems = [
      {
        id: uid('item'),
        name: '维达抽纸',
        category: '日用百货',
        location: '储物间',
        locationDetail: '置物架第二层左侧',
        quantity: 3,
        unit: '包',
        minStock: 4,
        note: '3层120抽，客厅用完来这里拿',
        photoDataUrl: '',
        createdAt: now - 50000,
        updatedAt: now - 50000
      },
      {
        id: uid('item'),
        name: '5号碱性电池',
        category: '数码电池',
        location: '客厅',
        locationDetail: '电视柜最右边抽屉工具盒内',
        quantity: 8,
        unit: '节',
        minStock: 4,
        note: '空调遥控器/电子秤通用',
        photoDataUrl: '',
        createdAt: now - 40000,
        updatedAt: now - 40000
      },
      {
        id: uid('item'),
        name: '洗洁精',
        category: '清洁洗护',
        location: '厨房',
        locationDetail: '水槽下方右侧收纳篮',
        quantity: 1,
        unit: '瓶',
        minStock: 1,
        note: '柠檬味 1.5kg 大瓶装',
        photoDataUrl: '',
        createdAt: now - 30000,
        updatedAt: now - 30000
      },
      {
        id: uid('item'),
        name: '抽绳垃圾袋',
        category: '日用百货',
        location: '厨房',
        locationDetail: '吊柜左下角挂篮',
        quantity: 2,
        unit: '卷',
        minStock: 2,
        note: '45×50cm 加厚中号',
        photoDataUrl: '',
        createdAt: now - 20000,
        updatedAt: now - 20000
      }
    ];
    for (const it of demoItems) {
      await put('items', it);
    }
    const units = await getSetting('units', DEFAULT_UNITS);
    if (!units.includes('节')) {
      await setSetting('units', [...units, '节']);
    }
    const demoShop = [
      {
        id: uid('shop'),
        listId: 'list-daily',
        linkedItemId: demoItems[0].id,
        name: '维达抽纸',
        quantity: 1,
        unit: '箱',
        note: '24包整箱装更划算',
        priority: 'high',
        checked: false,
        createdAt: now - 10000
      },
      {
        id: uid('shop'),
        listId: 'list-market',
        linkedItemId: '',
        name: '鲜牛奶',
        quantity: 2,
        unit: '瓶',
        note: '950ml 冷藏巴氏奶',
        priority: 'normal',
        checked: false,
        createdAt: now - 5000
      }
    ];
    for (const s of demoShop) {
      await put('shoppingItems', s);
    }
  }

  async function estimateStorageBytes() {
    const payload = await exportAllData();
    const str = JSON.stringify(payload);
    return new Blob([str]).size;
  }

  global.HomeDB = {
    uid,
    DEFAULT_UNITS,
    DEFAULT_LOCATIONS,
    DEFAULT_CATEGORIES,
    openDB,
    ensureDefaults,
    getAll,
    put,
    remove,
    getSetting,
    setSetting,
    compressImage,
    exportAllData,
    importAllData,
    clearAllData,
    loadDemoData,
    estimateStorageBytes
  };
})(window);
