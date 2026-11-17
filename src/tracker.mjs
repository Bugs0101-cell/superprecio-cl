import {
  createTrackedItem,
  getSetting,
  getTrackedItemById,
  insertSnapshot,
  listTrackedItems,
  setSetting,
} from "./db.mjs";
import { checkProductPurity } from "./normalizer.mjs";
import { searchAllStores, STORES } from "./scrapers.mjs";
import { formatPriceAlertMessage, sendTelegramNotification } from "./telegram.mjs";

const AUTO_STORES = ["jumbo", "santaisabel", "unimarc", "tottus"];

/**
 * Determina la unidad dominante ('kg', 'lt', 'un') de un conjunto de productos
 * para comparar peras con peras cuando preferred_unit === 'auto'.
 */
function detectDominantUnit(products, preferredUnit) {
  if (preferredUnit && preferredUnit !== "auto") return preferredUnit;
  const counts = { kg: 0, lt: 0, un: 0 };
  for (const p of products) {
    if (p.unit && counts[p.unit] !== undefined) {
      counts[p.unit]++;
    }
  }
  if (counts.kg >= counts.lt && counts.kg > 0) return "kg";
  if (counts.lt > counts.kg && counts.lt > 0) return "lt";
  return "un";
}

/**
 * Actualiza los precios de un item seguido (tanto productos fijados como búsqueda genérica)
 * y guarda los nuevos snapshots en SQLite.
 */
export async function refreshTrackedItem(trackedItemId) {
  const item = getTrackedItemById(trackedItemId);
  if (!item) throw new Error(`Producto seguido #${trackedItemId} no existe`);

  const now = new Date().toISOString();
  const coveredStores = new Set();
  const savedSnapshots = [];

  // 1. Actualizar primero los productos fijados específicos (pinnedProducts)
  for (const pinned of item.pinnedProducts || []) {
    if (!STORES[pinned.store]?.autoSupported) continue;
    try {
      const searchQ = `${pinned.name} ${pinned.brand || ""}`.trim();
      const res = await searchAllStores(searchQ, {
        stores: [pinned.store],
        limitPerStore: 10,
        minRelevance: 0.2,
      });

      const match =
        res.products.find(
          (p) =>
            String(p.externalId) === String(pinned.external_id) ||
            String(p.sku) === String(pinned.sku)
        ) || res.products[0];

      if (match) {
        insertSnapshot({
          trackedItemId: item.id,
          pinnedProductId: pinned.id,
          product: match,
          recordedAt: now,
        });
        coveredStores.add(pinned.store);
        savedSnapshots.push(match);
      }
    } catch {
      // Continuar con las demás tiendas si una falla
    }
  }

  // 2. Si el modo es 'mixed' o 'query' y hay search_query, buscar el mejor precio por unidad en las tiendas restantes
  if ((item.mode === "mixed" || item.mode === "query") && item.search_query) {
    const remainingStores = AUTO_STORES.filter((s) => !coveredStores.has(s));
    if (remainingStores.length > 0) {
      const res = await searchAllStores(item.search_query, {
        stores: remainingStores,
        limitPerStore: 15,
        minRelevance: 0.5,
      });

      const targetUnit = detectDominantUnit(res.products, item.preferred_unit);
      const qCheck = item.search_query || item.title;

      for (const storeId of remainingStores) {
        const storeItems = res.products.filter((p) => p.store === storeId);
        if (storeItems.length === 0) continue;

        const pureItems = storeItems.filter(
          (p) =>
            p.isPure !== false &&
            checkProductPurity(qCheck, p.name, p.brand).isPure !== false
        );
        if (pureItems.length === 0) continue;

        // Priorizar productos 100% puros (no mezclas) si existen en esa tienda
        const nonBlend = pureItems.filter((p) => !p.isBlend);
        const preferredPool = nonBlend.length > 0 ? nonBlend : pureItems;

        // Filtrar por la misma unidad (kg o lt) para comparar justamente $/kg o $/L
        const unitMatched = preferredPool.filter((p) => p.unit === targetUnit);
        const candidates = unitMatched.length > 0 ? unitMatched : preferredPool;

        // Elegir el más económico por unidad ($/kg, $/L, $/un)
        candidates.sort((a, b) => a.unitPrice - b.unitPrice);
        const best = candidates[0];

        if (best) {
          insertSnapshot({
            trackedItemId: item.id,
            pinnedProductId: null,
            product: best,
            recordedAt: now,
          });
          savedSnapshots.push(best);
        }
      }
    }
  }

  const updatedItem = getTrackedItemById(item.id);

  // Comprobar alertas de Telegram si está habilitado
  try {
    const telegramEnabled = getSetting("telegram_enabled") === "1";
    const token = getSetting("telegram_token");
    const chatId = getSetting("telegram_chat_id");
    const thresholdPct = Number(getSetting("telegram_threshold_pct", "12"));

    if (telegramEnabled && token && chatId && updatedItem) {
      for (const [storeId, vStat] of Object.entries(updatedItem.variabilityByStore || {})) {
        if (vStat && vStat.deltaPrevPct <= -thresholdPct) {
          const latestSnap = updatedItem.latestByStore?.[storeId];
          if (latestSnap) {
            const oldPrice = Math.round(latestSnap.price / (1 + vStat.deltaPrevPct / 100));
            const msg = formatPriceAlertMessage({
              item: updatedItem,
              storeName: STORES[storeId]?.name || storeId,
              oldPrice,
              newPrice: latestSnap.price,
              unitPrice: latestSnap.unit_price,
              unit: latestSnap.unit,
              savingsPct: Math.abs(Math.round(vStat.deltaPrevPct)),
              productUrl: latestSnap.product_url,
            });
            sendTelegramNotification({ token, chatId, text: msg }).catch(() => {});
          }
        }
      }
    }
  } catch {}

  return updatedItem;
}

/**
 * Actualiza todos los productos seguidos en la base de datos.
 */
export async function refreshAllTrackedItems() {
  const items = listTrackedItems();
  const updated = [];
  for (const item of items) {
    try {
      const refreshed = await refreshTrackedItem(item.id);
      updated.push(refreshed);
    } catch (err) {
      console.error(`Error actualizando item ${item.id}:`, err.message);
    }
  }
  setSetting("last_auto_run_at", new Date().toISOString());
  return updated;
}

/**
 * Si la base de datos está vacía, crea una canasta inicial de productos chilenos,
 * consulta sus precios reales en vivo en Jumbo, Santa Isabel, Unimarc y Tottus,
 * y genera puntos históricos previos para visualizar de inmediato las curvas de variabilidad.
 */
export async function seedInitialDataIfNeeded() {
  const existing = listTrackedItems();
  if (existing.length > 0) return;

  console.log("📦 Inicializando canasta base con precios reales en vivo de Chile...");

  const starterItems = [
    {
      title: "Leche Entera 1L",
      searchQuery: "leche entera 1 l",
      mode: "mixed",
      preferredUnit: "lt",
      category: "Lácteos",
    },
    {
      title: "Arroz Grado 1 (1 kg)",
      searchQuery: "arroz grado 1 1 kg",
      mode: "mixed",
      preferredUnit: "kg",
      category: "Despensa",
    },
    {
      title: "Aceite Maravilla",
      searchQuery: "aceite maravilla",
      mode: "mixed",
      preferredUnit: "lt",
      category: "Despensa",
    },
    {
      title: "Mantequilla con Sal",
      searchQuery: "mantequilla sal 250 g",
      mode: "mixed",
      preferredUnit: "kg",
      category: "Lácteos",
    },
  ];

  // Variaciones históricas realistas previas (hace 12, 8 y 4 días) basadas en el precio real actual
  const historicalFactors = [
    { daysAgo: 12, factors: { jumbo: 1.06, santaisabel: 1.04, unimarc: 0.97, tottus: 1.05 } },
    { daysAgo: 8, factors: { jumbo: 1.03, santaisabel: 1.08, unimarc: 1.02, tottus: 0.96 } },
    { daysAgo: 4, factors: { jumbo: 0.98, santaisabel: 1.02, unimarc: 1.05, tottus: 1.03 } },
  ];

  for (const s of starterItems) {
    const id = createTrackedItem(s);
    try {
      // Primero obtenemos los productos reales de hoy desde las APIs de los 4 supermercados
      const res = await searchAllStores(s.searchQuery, {
        stores: AUTO_STORES,
        limitPerStore: 15,
        minRelevance: 0.5,
      });

      const targetUnit = detectDominantUnit(res.products, s.preferredUnit);
      const bestByStoreToday = {};

      for (const storeId of AUTO_STORES) {
        const storeItems = res.products.filter((p) => p.store === storeId);
        const unitMatched = storeItems.filter((p) => p.unit === targetUnit);
        const candidates = unitMatched.length > 0 ? unitMatched : storeItems;
        candidates.sort((a, b) => a.unitPrice - b.unitPrice);
        if (candidates[0]) {
          bestByStoreToday[storeId] = candidates[0];
        }
      }

      // Insertar puntos históricos previos anclados al producto real
      for (const h of historicalFactors) {
        const pastDate = new Date(Date.now() - h.daysAgo * 24 * 3600 * 1000).toISOString();
        for (const [storeId, liveProd] of Object.entries(bestByStoreToday)) {
          const factor = h.factors[storeId] ?? 1.0;
          const pastPrice = Math.round((liveProd.price * factor) / 10) * 10;
          const pastUnitPrice = Math.round(liveProd.unitPrice * factor);
          insertSnapshot({
            trackedItemId: id,
            pinnedProductId: null,
            product: {
              ...liveProd,
              price: pastPrice,
              unitPrice: pastUnitPrice,
              effectiveUnitPrice: pastUnitPrice,
              pricePer100: Math.round(pastUnitPrice / 10),
            },
            recordedAt: pastDate,
          });
        }
      }

      // Finalmente insertar la medición real en vivo de hoy
      const now = new Date().toISOString();
      for (const liveProd of Object.values(bestByStoreToday)) {
        insertSnapshot({
          trackedItemId: id,
          pinnedProductId: null,
          product: liveProd,
          recordedAt: now,
        });
      }
    } catch (err) {
      console.error(`Error inicializando ${s.title}:`, err.message);
    }
  }

  setSetting("last_auto_run_at", new Date().toISOString());
  console.log("✅ Canasta inicial creada y actualizada con éxito.");
}
