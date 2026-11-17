import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkProductPurity,
  estimateProteinMetrics,
  extractQuantityFromText,
  inferBrand,
  inferProductCategory,
  normalizeProductUrl,
  normalizeText,
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
    target_price_clp INTEGER,
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
    in_stock INTEGER NOT NULL DEFAULT 1,
    stock_status TEXT NOT NULL DEFAULT 'in_stock',
    store_zone TEXT NOT NULL DEFAULT '',
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

// Inicializar ajustes por defecto y migraciones livianas
const trackedCols = db.prepare("PRAGMA table_info(tracked_items)").all();
if (!trackedCols.some((c) => c.name === "target_price_clp")) {
  db.exec("ALTER TABLE tracked_items ADD COLUMN target_price_clp INTEGER;");
}

const snapCols = db.prepare("PRAGMA table_info(price_snapshots)").all();
if (!snapCols.some((c) => c.name === "in_stock")) {
  db.exec("ALTER TABLE price_snapshots ADD COLUMN in_stock INTEGER NOT NULL DEFAULT 1;");
}
if (!snapCols.some((c) => c.name === "stock_status")) {
  db.exec("ALTER TABLE price_snapshots ADD COLUMN stock_status TEXT NOT NULL DEFAULT 'in_stock';");
}
if (!snapCols.some((c) => c.name === "store_zone")) {
  db.exec("ALTER TABLE price_snapshots ADD COLUMN store_zone TEXT NOT NULL DEFAULT '';");
}

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
  targetPriceClp = null,
}) {
  const now = new Date().toISOString();
  const parsedTarget =
    targetPriceClp !== null && targetPriceClp !== undefined && Number(targetPriceClp) > 0
      ? Math.round(Number(targetPriceClp))
      : null;
  const res = db
    .prepare(
      `INSERT INTO tracked_items (title, search_query, mode, preferred_unit, category, target_price_clp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title.trim(),
      searchQuery.trim(),
      mode,
      preferredUnit,
      category.trim() || "Despensa",
      parsedTarget,
      now
    );
  return Number(res.lastInsertRowid);
}

export function updateTrackedItem(id, fields = {}) {
  const item = db
    .prepare("SELECT * FROM tracked_items WHERE id = ?")
    .get(Number(id));
  if (!item) return null;

  const nextTitle =
    typeof fields.title === "string" && fields.title.trim()
      ? fields.title.trim()
      : item.title;
  const nextQuery =
    typeof fields.searchQuery === "string"
      ? fields.searchQuery.trim()
      : item.search_query;
  const nextUnit =
    typeof fields.preferredUnit === "string" && fields.preferredUnit.trim()
      ? fields.preferredUnit.trim()
      : item.preferred_unit;
  const nextCategory =
    typeof fields.category === "string" && fields.category.trim()
      ? fields.category.trim()
      : item.category;

  let nextTarget = item.target_price_clp ?? null;
  if (Object.prototype.hasOwnProperty.call(fields, "targetPriceClp")) {
    const val = Number(fields.targetPriceClp);
    nextTarget =
      fields.targetPriceClp === null ||
      fields.targetPriceClp === "" ||
      !Number.isFinite(val) ||
      val <= 0
        ? null
        : Math.round(val);
  }

  db.prepare(
    `UPDATE tracked_items
     SET title = ?, search_query = ?, preferred_unit = ?, category = ?, target_price_clp = ?
     WHERE id = ?`
  ).run(nextTitle, nextQuery, nextUnit, nextCategory, nextTarget, Number(id));

  return getTrackedItemById(id);
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
  const inStockInt = product.inStock === false || product.stockStatus === "out_of_stock" ? 0 : 1;
  const stockStatus =
    product.stockStatus || (inStockInt === 0 ? "out_of_stock" : "in_stock");
  const storeZone = String(product.storeZone || "").trim();

  db.prepare(
    `INSERT INTO price_snapshots (
      tracked_item_id, pinned_product_id, store, external_id, product_name,
      brand, price, list_price, member_price, unit_price, effective_unit_price,
      unit, price_per_100, format_label, promo_text, product_url, image_url,
      in_stock, stock_status, store_zone, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    inStockInt,
    stockStatus,
    storeZone,
    recordedAt
  );

  db.prepare("UPDATE tracked_items SET last_checked_at = ? WHERE id = ?").run(
    recordedAt,
    Number(trackedItemId)
  );
}

/**
 * Inserta snapshot solo si cambió algún precio/formato/promo/stock respecto al último
 * snapshot de esa tienda; si todo sigue idéntico, actualiza su timestamp para evitar
 * duplicar filas redundantes en las corridas automáticas de 6 horas.
 */
export function touchOrInsertSnapshot({
  trackedItemId,
  pinnedProductId = null,
  product,
  recordedAt = new Date().toISOString(),
}) {
  const latest = db
    .prepare(
      `SELECT * FROM price_snapshots
       WHERE tracked_item_id = ? AND store = ?
       ORDER BY recorded_at DESC, id DESC LIMIT 1`
    )
    .get(Number(trackedItemId), product.store);

  const extId = String(product.externalId || product.sku || "manual");
  const nextPrice = Math.round(product.price);
  const nextUnitPrice = Math.round(product.unitPrice);
  const nextEffUnit = Math.round(product.effectiveUnitPrice ?? product.unitPrice);
  const nextList = product.listPrice ? Math.round(product.listPrice) : null;
  const nextMember = product.memberPrice ? Math.round(product.memberPrice) : null;
  const nextPromo = product.promoText || "";
  const nextFmt = product.formatLabel || "";
  const nextInStock = product.inStock === false || product.stockStatus === "out_of_stock" ? 0 : 1;
  const nextStockStatus =
    product.stockStatus || (nextInStock === 0 ? "out_of_stock" : "in_stock");
  const nextStoreZone = String(product.storeZone || "").trim();

  const isUnchanged =
    latest &&
    String(latest.external_id) === extId &&
    Number(latest.price) === nextPrice &&
    Number(latest.unit_price) === nextUnitPrice &&
    Number(latest.effective_unit_price) === nextEffUnit &&
    (latest.list_price ?? null) === nextList &&
    (latest.member_price ?? null) === nextMember &&
    (latest.promo_text || "") === nextPromo &&
    (latest.format_label || "") === nextFmt &&
    Number(latest.in_stock ?? 1) === nextInStock &&
    String(latest.stock_status || "in_stock") === nextStockStatus &&
    String(latest.store_zone || "") === nextStoreZone;

  if (isUnchanged) {
    const nextUrl = product.url || latest.product_url || "";
    const nextImg = product.imageUrl || latest.image_url || "";
    const nextPinnedId = pinnedProductId ? Number(pinnedProductId) : latest.pinned_product_id;
    db.prepare(
      `UPDATE price_snapshots
       SET recorded_at = ?, product_url = ?, image_url = ?, pinned_product_id = ?, store_zone = ?
       WHERE id = ?`
    ).run(recordedAt, nextUrl, nextImg, nextPinnedId, nextStoreZone, latest.id);

    db.prepare("UPDATE tracked_items SET last_checked_at = ? WHERE id = ?").run(
      recordedAt,
      Number(trackedItemId)
    );
    return { inserted: false, touchedId: latest.id };
  }

  insertSnapshot({ trackedItemId, pinnedProductId, product, recordedAt });
  return { inserted: true };
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
    .all(item.id)
    .map((p) => ({
      ...p,
      brand: inferBrand(p.name, p.brand),
      url: normalizeProductUrl(p.url, p.store),
    }));

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
    // Exige al menos 3 observaciones de precio para evitar falsos "Piso Histórico" en el día 1.
    let signal = "new";
    let signalLabel = "🆕 Precio Base (faltan med.)";
    let signalExplanation = `Registradas ${list.length}/3 variaciones de precio en esta tienda para detectar piso histórico.`;

    if (list.length >= 3) {
      signal = "normal";
      signalLabel = "🟡 Precio Habitual";
      signalExplanation = "El precio está en su rango promedio.";

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
    }

    const priceRangePct =
      maxUnitPrice > minUnitPrice
        ? Math.max(
            0,
            Math.min(
              100,
              Math.round(((latest.unit_price - minUnitPrice) / (maxUnitPrice - minUnitPrice)) * 100)
            )
          )
        : 50;

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
    const inferredAmt =
      latest.price > 0 && latest.unit_price > 0 ? latest.price / latest.unit_price : 1;
    const baseAmt = spec?.baseAmount || inferredAmt;
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
      nutrition_seals: nut.nutritionSeals || [],
      inferred_category: nut.inferredCategory || inferProductCategory(latest.product_name),
      price_range_pct: priceRangePct,
      in_stock: latest.in_stock !== 0 && latest.stock_status !== "out_of_stock",
      stock_status: latest.stock_status || (latest.in_stock === 0 ? "out_of_stock" : "in_stock"),
      store_zone: latest.store_zone || "",
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
      firstUnitPrice: first.unit_price,
      minUnitPrice,
      maxUnitPrice,
      avgUnitPrice,
      minPrice,
      maxPrice,
      deltaPrevClp,
      deltaPrevPct,
      deltaFirstPct,
      volatilityPct,
      priceRangePct,
      signal,
      signalLabel,
      signalExplanation,
      shrinkflation,
      firstRecordedAt: first.recorded_at,
      lastRecordedAt: latest.recorded_at,
    };
  }

  const activeLatest = Object.values(latestByStore);
  const inStockPool = activeLatest.filter((s) => s.in_stock !== false && s.stock_status !== "out_of_stock");
  const stockPool = inStockPool.length > 0 ? inStockPool : activeLatest;
  const purePool = stockPool.filter((s) => s.is_pure !== false);
  const candidatePool = purePool.length > 0 ? purePool : stockPool;

  const byUnit = [...candidatePool].sort((a, b) => a.unit_price - b.unit_price);
  const bestByUnitPrice = byUnit[0] || null;
  const worstByUnitPrice = byUnit.length > 1 ? byUnit[byUnit.length - 1] : null;

  for (const entry of activeLatest) {
    entry.vs_best_pct =
      bestByUnitPrice?.unit_price > 0
        ? Math.max(0, Math.round(((entry.unit_price - bestByUnitPrice.unit_price) / bestByUnitPrice.unit_price) * 100))
        : 0;
  }

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
    const sInferredAmt = s.price > 0 && s.unit_price > 0 ? s.price / s.unit_price : 1;
    const sBase = sSpec?.baseAmount || sInferredAmt;
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


export function listCartItemWeightsForIpc() {
  try {
    return db
      .prepare("SELECT label, search_query, quantity FROM cart_items")
      .all();
  } catch {
    return [];
  }
}

function matchCartWeightForTrackedItem(item, cartRows = []) {
  if (!cartRows || cartRows.length === 0) return { inCart: false, qty: 1 };
  const itemTokens = normalizeText(item.search_query || item.title)
    .split(" ")
    .filter((w) => w.length >= 3);
  if (itemTokens.length === 0) return { inCart: false, qty: 1 };

  let matchedQty = 0;
  for (const row of cartRows) {
    const rowNorm = normalizeText(`${row.label || ""} ${row.search_query || ""}`);
    const hits = itemTokens.filter((t) => rowNorm.includes(t)).length;
    if (hits >= Math.min(2, itemTokens.length)) {
      matchedQty += Math.max(1, Number(row.quantity) || 1);
    }
  }
  return {
    inCart: matchedQty > 0,
    qty: matchedQty > 0 ? matchedQty : 1,
  };
}

/**
 * Calcula el IPC Personal (Inflación Real de tu Canasta Hogar)
 * ponderando los productos monitoreados por su peso en carritos activos.
 */
export function calculatePersonalIpc() {
  const items = listTrackedItems();
  if (items.length === 0) {
    return {
      basketInflationPct: 0,
      weightedBasketInflationPct: 0,
      monthlyInflationRatePct: 0,
      totalTrackedCount: 0,
      weightedItemsCount: 0,
      storeInflation: {},
      categoryBreakdown: [],
      itemChanges: [],
      topIncreases: [],
      topDecreases: [],
      timeline: [],
    };
  }

  const cartRows = listCartItemWeightsForIpc();
  const storeDeltas = { jumbo: [], santaisabel: [], unimarc: [], tottus: [], lider: [] };
  const itemChanges = [];
  const categoryStats = {};

  for (const item of items) {
    const varMap = item.variabilityByStore || {};
    let itemFirstSum = 0;
    let itemLastSum = 0;
    let storeCount = 0;

    const { inCart, qty } = matchCartWeightForTrackedItem(item, cartRows);
    const refPackPrice = Math.max(500, item.bestByUnitPrice?.price || item.bestByUnitPrice?.unit_price || 1000);
    const weightClp = Math.round(qty * refPackPrice * (inCart ? 1.5 : 1));

    for (const [storeId, vStat] of Object.entries(varMap)) {
      if (vStat && vStat.observations >= 2) {
        storeDeltas[storeId]?.push({ pct: vStat.deltaFirstPct, weightClp });
        const baseFirst = vStat.firstUnitPrice || vStat.avgUnitPrice || vStat.minUnitPrice;
        const baseLast = item.latestByStore?.[storeId]?.unit_price || vStat.avgUnitPrice;
        if (baseFirst > 0 && baseLast > 0) {
          itemFirstSum += baseFirst;
          itemLastSum += baseLast;
          storeCount++;
        }
      }
    }

    if (storeCount > 0 && itemFirstSum > 0) {
      const overallItemChange = Number((((itemLastSum - itemFirstSum) / itemFirstSum) * 100).toFixed(1));
      const cat = item.category || "Despensa";
      itemChanges.push({
        id: item.id,
        title: item.title,
        category: cat,
        changePct: overallItemChange,
        currentBest: item.bestByUnitPrice?.unit_price || 0,
        unit: item.bestByUnitPrice?.unit || "un",
        weightQty: qty,
        weightClp,
        inCart,
      });

      if (!categoryStats[cat]) {
        categoryStats[cat] = { category: cat, weightedSum: 0, totalWeight: 0, itemCount: 0 };
      }
      categoryStats[cat].weightedSum += overallItemChange * weightClp;
      categoryStats[cat].totalWeight += weightClp;
      categoryStats[cat].itemCount += 1;
    }
  }

  const validChanges = itemChanges.map((i) => i.changePct);
  const basketInflationPct =
    validChanges.length > 0
      ? Number((validChanges.reduce((a, b) => a + b, 0) / validChanges.length).toFixed(1))
      : 0;

  const totalWeightAll = itemChanges.reduce((s, i) => s + i.weightClp, 0);
  const weightedBasketInflationPct =
    totalWeightAll > 0
      ? Number(
          (
            itemChanges.reduce((s, i) => s + i.changePct * i.weightClp, 0) / totalWeightAll
          ).toFixed(1)
        )
      : basketInflationPct;

  // Inflación por supermercado (ponderada por gasto estimado de canasta)
  const storeInflation = {};
  for (const [sId, entries] of Object.entries(storeDeltas)) {
    if (entries.length > 0) {
      const simpleAvg = Number(
        (entries.reduce((a, b) => a + b.pct, 0) / entries.length).toFixed(1)
      );
      const sWeight = entries.reduce((a, b) => a + b.weightClp, 0);
      const weightedAvg =
        sWeight > 0
          ? Number(
              (entries.reduce((a, b) => a + b.pct * b.weightClp, 0) / sWeight).toFixed(1)
            )
          : simpleAvg;
      storeInflation[sId] = {
        store: sId,
        inflationPct: weightedAvg,
        simpleInflationPct: simpleAvg,
        productsEvaluated: entries.length,
      };
    }
  }

  const categoryBreakdown = Object.values(categoryStats)
    .map((c) => ({
      category: c.category,
      changePct:
        c.totalWeight > 0 ? Number((c.weightedSum / c.totalWeight).toFixed(1)) : 0,
      itemCount: c.itemCount,
      totalWeightClp: c.totalWeight,
    }))
    .sort((a, b) => b.changePct - a.changePct);

  itemChanges.sort((a, b) => b.changePct - a.changePct);
  const topIncreases = itemChanges.filter((i) => i.changePct > 0).slice(0, 5);
  const topDecreases = [...itemChanges].reverse().filter((i) => i.changePct < 0).slice(0, 5);

  return {
    basketInflationPct,
    weightedBasketInflationPct,
    totalTrackedCount: items.length,
    weightedItemsCount: itemChanges.filter((i) => i.inCart).length,
    storeInflation,
    categoryBreakdown,
    itemChanges,
    topIncreases,
    topDecreases,
  };
}
