import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkProductPurity,
  estimateProteinMetrics,
  extractQuantityFromText,
  inferBrand,
  normalizeProductUrl,
  parseBundle,
} from "./normalizer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "precios.db");
console.log(`💾 Base de datos SQLite en: ${DB_PATH}`);
export const db = new DatabaseSync(DB_PATH);

// Inicializar esquema SQLite
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS tracked_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    search_query TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'mixed',
    preferred_unit TEXT NOT NULL DEFAULT 'auto',
    category TEXT NOT NULL DEFAULT 'Despensa',
    last_checked_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pinned_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracked_item_id INTEGER NOT NULL,
    store TEXT NOT NULL,
    external_id TEXT NOT NULL,
    sku TEXT,
    name TEXT NOT NULL,
    brand TEXT,
    format_label TEXT,
    unit TEXT NOT NULL DEFAULT 'un',
    base_amount REAL NOT NULL DEFAULT 1,
    url TEXT,
    image_url TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (tracked_item_id) REFERENCES tracked_items(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracked_item_id INTEGER NOT NULL,
    pinned_product_id INTEGER,
    store TEXT NOT NULL,
    external_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    brand TEXT,
    price INTEGER NOT NULL,
    list_price INTEGER,
    member_price INTEGER,
    unit_price INTEGER NOT NULL,
    effective_unit_price INTEGER NOT NULL,
    unit TEXT NOT NULL,
    price_per_100 INTEGER NOT NULL,
    format_label TEXT,
    promo_text TEXT,
    product_url TEXT,
    image_url TEXT,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (tracked_item_id) REFERENCES tracked_items(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_item_time
    ON price_snapshots(tracked_item_id, recorded_at DESC);

  CREATE INDEX IF NOT EXISTS idx_snapshots_store
    ON price_snapshots(tracked_item_id, store, recorded_at DESC);

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export function getSetting(key, defaultValue = null) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

// Inicializar ajustes por defecto (actualización automática cada 360 min = 6 horas)
if (getSetting("auto_interval_minutes") === null) {
  setSetting("auto_interval_minutes", "360");
}

export function listTrackedItems() {
  const items = db
    .prepare("SELECT * FROM tracked_items ORDER BY id ASC")
    .all();

  return items.map((item) => enrichTrackedItemWithStats(item));
}

export function getTrackedItemById(id) {
  const item = db
    .prepare("SELECT * FROM tracked_items WHERE id = ?")
    .get(Number(id));
  if (!item) return null;
  return enrichTrackedItemWithStats(item);
}

export function createTrackedItem({
  title,
  searchQuery = "",
  mode = "mixed",
  preferredUnit = "auto",
  category = "Despensa",
}) {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO tracked_items (title, search_query, mode, preferred_unit, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      title.trim(),
      searchQuery.trim(),
      mode,
      preferredUnit,
      category.trim() || "Despensa",
      now
    );
  return Number(res.lastInsertRowid);
}

export function deleteTrackedItem(id) {
  db.prepare("DELETE FROM tracked_items WHERE id = ?").run(Number(id));
}

export function addPinnedProduct(trackedItemId, product) {
  const now = new Date().toISOString();
  // Evitar duplicados exactos en el mismo trackedItemId
  const existing = db
    .prepare(
      "SELECT id FROM pinned_products WHERE tracked_item_id = ? AND store = ? AND external_id = ?"
    )
    .get(Number(trackedItemId), product.store, String(product.externalId));

  if (existing) {
    return Number(existing.id);
  }

  const res = db
    .prepare(
      `INSERT INTO pinned_products (
        tracked_item_id, store, external_id, sku, name, brand,
        format_label, unit, base_amount, url, image_url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(trackedItemId),
      product.store,
      String(product.externalId),
      product.sku ? String(product.sku) : String(product.externalId),
      product.name,
      product.brand || "",
      product.formatLabel || "",
      product.unit || "un",
      product.baseAmount ?? 1,
      product.url || "",
      product.imageUrl || "",
      now
    );

  const pinnedId = Number(res.lastInsertRowid);

  // También registrar su snapshot inmediato si trae precio
  if (product.price && product.unitPrice) {
    insertSnapshot({
      trackedItemId: Number(trackedItemId),
      pinnedProductId: pinnedId,
      product,
      recordedAt: now,
    });
  }

  return pinnedId;
}

export function removePinnedProduct(pinnedId) {
  db.prepare("DELETE FROM pinned_products WHERE id = ?").run(Number(pinnedId));
}

export function insertSnapshot({
  trackedItemId,
  pinnedProductId = null,
  product,
  recordedAt = new Date().toISOString(),
}) {
  db.prepare(
    `INSERT INTO price_snapshots (
      tracked_item_id, pinned_product_id, store, external_id, product_name,
      brand, price, list_price, member_price, unit_price, effective_unit_price,
      unit, price_per_100, format_label, promo_text, product_url, image_url, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Number(trackedItemId),
    pinnedProductId ? Number(pinnedProductId) : null,
    product.store,
    String(product.externalId || product.sku || "manual"),
    product.name,
    product.brand || "",
    Math.round(product.price),
    product.listPrice ? Math.round(product.listPrice) : null,
    product.memberPrice ? Math.round(product.memberPrice) : null,
    Math.round(product.unitPrice),
    Math.round(product.effectiveUnitPrice ?? product.unitPrice),
    product.unit || "un",
    Math.round(product.pricePer100 ?? Math.round(product.unitPrice / 10)),
    product.formatLabel || "",
    product.promoText || null,
    product.url || "",
    product.imageUrl || "",
    recordedAt
  );

  db.prepare("UPDATE tracked_items SET last_checked_at = ? WHERE id = ?").run(
    recordedAt,
    Number(trackedItemId)
  );
}

/**
 * Enriquecer un producto seguido con:
 * - Productos fijados (pinnedProducts)
 * - Último snapshot vigente por cada supermercado (latestByStore)
 * - Mejor opción por precio unitario ($/kg, $/L, $/un) y mejor por precio total
 * - Estadísticas de variabilidad histórica por supermercado y global
 */
export function enrichTrackedItemWithStats(item) {
  const pinnedProducts = db
    .prepare("SELECT * FROM pinned_products WHERE tracked_item_id = ? ORDER BY id ASC")
    .all(item.id);

  // Obtener todos los snapshots históricos ordenados cronológicamente
  const snapshots = db
    .prepare(
      "SELECT * FROM price_snapshots WHERE tracked_item_id = ? ORDER BY recorded_at ASC, id ASC"
    )
    .all(item.id);

  // Agrupar por tienda para encontrar el último estado y estadísticas de variabilidad
  const byStore = {};
  for (const snap of snapshots) {
    if (!byStore[snap.store]) {
      byStore[snap.store] = [];
    }
    byStore[snap.store].push(snap);
  }

  const latestByStore = {};
  const variabilityByStore = {};

  for (const [store, list] of Object.entries(byStore)) {
    const latest = list[list.length - 1];
    const previous = list.length >= 2 ? list[list.length - 2] : null;
    const first = list[0];

    const unitPrices = list.map((s) => s.unit_price);
    const totalPrices = list.map((s) => s.price);

    const minUnitPrice = Math.min(...unitPrices);
    const maxUnitPrice = Math.max(...unitPrices);
    const avgUnitPrice = Math.round(
      unitPrices.reduce((a, b) => a + b, 0) / unitPrices.length
    );

    const minPrice = Math.min(...totalPrices);
    const maxPrice = Math.max(...totalPrices);

    const deltaPrevClp = previous ? latest.unit_price - previous.unit_price : 0;
    const deltaPrevPct =
      previous && previous.unit_price > 0
        ? Number((((latest.unit_price - previous.unit_price) / previous.unit_price) * 100).toFixed(1))
        : 0;

    const deltaFirstPct =
      first && first.unit_price > 0
        ? Number((((latest.unit_price - first.unit_price) / first.unit_price) * 100).toFixed(1))
        : 0;

    const volatilityPct =
      minUnitPrice > 0
        ? Number((((maxUnitPrice - minUnitPrice) / minUnitPrice) * 100).toFixed(1))
        : 0;

    // --- Semáforo "¿Compro hoy o espero?" & Detector de Ofertas Infladas ---
    let signal = "normal";
    let signalLabel = "🟡 Precio Habitual";
    let signalExplanation = "El precio está en su rango promedio.";

    const isAtFloor =
      latest.unit_price <= minUnitPrice * 1.03 ||
      (avgUnitPrice > 0 && latest.unit_price <= avgUnitPrice * 0.88);
    const hasPromoBadge = Boolean(latest.promo_text || latest.list_price);
    const isInflatedPromo =
      hasPromoBadge && avgUnitPrice > 0 && latest.unit_price >= avgUnitPrice * 0.99;

    if (isAtFloor) {
      signal = "floor";
      signalLabel = "🟢 Piso Histórico (¡Stockeo!)";
      const dropPct =
        avgUnitPrice > 0
          ? Math.round(((avgUnitPrice - latest.unit_price) / avgUnitPrice) * 100)
          : 0;
      signalExplanation = `¡Excelente momento para abastecerse! Está ${
        dropPct > 0 ? `un ${dropPct}% bajo su promedio` : "en su mínimo histórico"
      }.`;
    } else if (isInflatedPromo) {
      signal = "inflated";
      signalLabel = "🔴 Oferta Dudosa / Inflada";
      signalExplanation =
        "Pese a mostrar cartel de oferta, su precio actual es igual o superior al promedio histórico registrado.";
    } else if (avgUnitPrice > 0 && latest.unit_price >= avgUnitPrice * 1.08) {
      signal = "expensive";
      signalLabel = "🔴 Sobre el Promedio";
      signalExplanation =
        "Precio más alto de lo normal (+8% sobre su promedio). Conviene esperar.";
    }

    // --- Detección de Reduflación (Shrinkflation) ---
    let shrinkflation = null;
    if (list.length >= 2) {
      const firstFmt = list[0].format_label;
      const lastFmt = latest.format_label;
      if (firstFmt && lastFmt && firstFmt !== lastFmt) {
        shrinkflation = {
          detected: true,
          originalFormat: firstFmt,
          currentFormat: lastFmt,
          firstRecordedAt: first.recorded_at,
          note: `El envase cambió de ${firstFmt} a ${lastFmt}.`,
        };
      }
    }

    const spec = extractQuantityFromText(latest.product_name, latest.format_label || "");
    const baseAmt = spec?.baseAmount || 1;
    const brandClean = inferBrand(latest.product_name, latest.brand);
    const nut = estimateProteinMetrics(
      latest.product_name,
      latest.unit,
      baseAmt,
      latest.price,
      brandClean
    );
    const purity = checkProductPurity(
      item.search_query || item.title,
      latest.product_name,
      brandClean
    );
    const bundle = latest.promo_text ? parseBundle(latest.promo_text) : null;
    const promoUnitPrice =
      bundle?.unitPriceInBundle && bundle.unitPriceInBundle < latest.price
        ? bundle.unitPriceInBundle
        : null;
    const promoMinQty = promoUnitPrice ? bundle.minQuantity : null;
    const effectiveUnitPrice =
      promoUnitPrice && baseAmt > 0
        ? Math.round(promoUnitPrice / baseAmt)
        : latest.effective_unit_price || latest.unit_price;
    const packageUnitPrice = promoUnitPrice || latest.price;

    latestByStore[store] = {
      ...latest,
      product_url: normalizeProductUrl(latest.product_url, store),
      brand: brandClean,
      promo_unit_price: promoUnitPrice,
      promo_min_qty: promoMinQty,
      effective_unit_price: effectiveUnitPrice,
      package_unit_price: packageUnitPrice,
      protein_price: nut.pricePer10gProtein,
      protein_grams_total: nut.proteinGramsTotal,
      protein_per_100g: nut.proteinPer100g,
      nutrition_score: nut.nutritionScore,
      nutrition_grade: nut.nutritionGrade,
      nutrition_badge: nut.nutritionBadge,
      is_pure: purity.isPure,
      is_blend: purity.isBlend,
      purity_warning: purity.purityWarning,
      signal,
      signalLabel,
      signalExplanation,
    };

    variabilityByStore[store] = {
      store,
      observations: list.length,
      minUnitPrice,
      maxUnitPrice,
      avgUnitPrice,
      minPrice,
      maxPrice,
      deltaPrevClp,
      deltaPrevPct,
      deltaFirstPct,
      volatilityPct,
      signal,
      signalLabel,
      signalExplanation,
      shrinkflation,
      firstRecordedAt: first.recorded_at,
      lastRecordedAt: latest.recorded_at,
    };
  }

  const activeLatest = Object.values(latestByStore);
  const purePool = activeLatest.filter((s) => s.is_pure !== false);
  const candidatePool = purePool.length > 0 ? purePool : activeLatest;

  const byUnit = [...candidatePool].sort((a, b) => a.unit_price - b.unit_price);
  const bestByUnitPrice = byUnit[0] || null;
  const worstByUnitPrice = byUnit.length > 1 ? byUnit[byUnit.length - 1] : null;

  const byEffective = [...candidatePool].sort(
    (a, b) => (a.effective_unit_price || a.unit_price) - (b.effective_unit_price || b.unit_price)
  );
  const bestByEffectiveUnitPrice = byEffective[0] || null;

  const byPackage = [...candidatePool].sort(
    (a, b) => (a.package_unit_price || a.price) - (b.package_unit_price || b.price)
  );
  const bestByPackagePrice = byPackage[0] || null;

  const withProtein = candidatePool.filter((s) => s.protein_price > 0);
  withProtein.sort((a, b) => a.protein_price - b.protein_price || a.unit_price - b.unit_price);
  const bestByProteinPrice = withProtein[0] || null;

  const withNutrition = candidatePool.filter((s) => s.nutrition_score > 0);
  withNutrition.sort(
    (a, b) =>
      b.nutrition_score - a.nutrition_score ||
      (a.protein_price || a.unit_price) - (b.protein_price || b.unit_price)
  );
  const bestByNutritionScore = withNutrition[0] || null;

  const byTotal = [...candidatePool].sort((a, b) => a.price - b.price);
  const bestByTotalPrice = byTotal[0] || null;

  const maxSavingsPct =
    bestByUnitPrice && worstByUnitPrice && worstByUnitPrice.unit_price > 0
      ? Math.round(
          ((worstByUnitPrice.unit_price - bestByUnitPrice.unit_price) /
            worstByUnitPrice.unit_price) *
            100
        )
      : 0;

  const normalizedHistory = snapshots.map((s) => {
    const sSpec = extractQuantityFromText(s.product_name, s.format_label || "");
    const sBase = sSpec?.baseAmount || 1;
    const sBundle = s.promo_text ? parseBundle(s.promo_text) : null;
    const sPromoUnit =
      sBundle?.unitPriceInBundle && sBundle.unitPriceInBundle < s.price
        ? sBundle.unitPriceInBundle
        : null;
    const sEffUnit =
      sPromoUnit && sBase > 0
        ? Math.round(sPromoUnit / sBase)
        : s.effective_unit_price || s.unit_price;
    return {
      ...s,
      product_url: normalizeProductUrl(s.product_url, s.store),
      promo_unit_price: sPromoUnit,
      effective_unit_price: sEffUnit,
    };
  });

  return {
    ...item,
    pinnedProducts,
    latestByStore,
    variabilityByStore,
    bestByUnitPrice,
    bestByEffectiveUnitPrice,
    bestByPackagePrice,
    bestByProteinPrice,
    bestByNutritionScore,
    bestByTotalPrice,
    maxSavingsPct,
    totalSnapshots: snapshots.length,
    history: normalizedHistory,
  };
}

export function getAllSnapshotsForExport() {
  return db
    .prepare(
      `SELECT
        ps.id,
        ti.title AS tracked_title,
        ti.category AS category,
        ps.store,
        ps.product_name,
        ps.brand,
        ps.format_label,
        ps.price,
        ps.list_price,
        ps.member_price,
        ps.unit_price,
        ps.unit,
        ps.price_per_100,
        ps.promo_text,
        ps.recorded_at,
        ps.product_url
      FROM price_snapshots ps
      JOIN tracked_items ti ON ti.id = ps.tracked_item_id
      ORDER BY ps.recorded_at DESC, ps.id DESC`
    )
    .all();
}


/**
 * Calcula el IPC Personal (Inflación Real de tu Canasta Hogar)
 * ponderando los productos monitoreados a lo largo del tiempo.
 */
export function calculatePersonalIpc() {
  const items = listTrackedItems();
  if (items.length === 0) {
    return {
      basketInflationPct: 0,
      monthlyInflationRatePct: 0,
      totalTrackedCount: 0,
      storeInflation: {},
      topIncreases: [],
      topDecreases: [],
      timeline: [],
    };
  }

  const storeDeltas = { jumbo: [], santaisabel: [], unimarc: [], tottus: [], lider: [] };
  const itemChanges = [];

  for (const item of items) {
    const varMap = item.variabilityByStore || {};
    let itemFirstSum = 0;
    let itemLastSum = 0;
    let storeCount = 0;

    for (const [storeId, vStat] of Object.entries(varMap)) {
      if (vStat && vStat.observations >= 2) {
        storeDeltas[storeId]?.push(vStat.deltaFirstPct);
        itemFirstSum += vStat.minUnitPrice || vStat.avgUnitPrice;
        itemLastSum += (item.latestByStore?.[storeId]?.unit_price || vStat.avgUnitPrice);
        storeCount++;
      }
    }

    if (storeCount > 0 && itemFirstSum > 0) {
      const overallItemChange = Number((((itemLastSum - itemFirstSum) / itemFirstSum) * 100).toFixed(1));
      itemChanges.push({
        title: item.title,
        category: item.category,
        changePct: overallItemChange,
        currentBest: item.bestByUnitPrice?.unit_price || 0,
        unit: item.bestByUnitPrice?.unit || "un",
      });
    }
  }

  // Inflación acumulada promedio de la canasta
  const validChanges = itemChanges.map((i) => i.changePct);
  const basketInflationPct =
    validChanges.length > 0
      ? Number((validChanges.reduce((a, b) => a + b, 0) / validChanges.length).toFixed(1))
      : 0;

  // Inflación por supermercado
  const storeInflation = {};
  for (const [sId, deltas] of Object.entries(storeDeltas)) {
    if (deltas.length > 0) {
      const avg = Number((deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(1));
      storeInflation[sId] = {
        store: sId,
        inflationPct: avg,
        productsEvaluated: deltas.length,
      };
    }
  }

  // Top aumentos y top bajas
  itemChanges.sort((a, b) => b.changePct - a.changePct);
  const topIncreases = itemChanges.filter((i) => i.changePct > 0).slice(0, 5);
  const topDecreases = [...itemChanges].reverse().filter((i) => i.changePct < 0).slice(0, 5);

  return {
    basketInflationPct,
    totalTrackedCount: items.length,
    storeInflation,
    topIncreases,
    topDecreases,
  };
}
