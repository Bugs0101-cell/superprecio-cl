import {
  createTrackedItem,
  getSetting,
  getTrackedItemById,
  listTrackedItems,
  setSetting,
  touchOrInsertSnapshot,
} from "./db.mjs";
import {
  buildCrossStoreSearchQuery,
  checkProductPurity,
  extractQuantityFromText,
} from "./normalizer.mjs";
import { fetchProductByUrl, searchAllStores, STORES } from "./scrapers.mjs";
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
  const preferredJumboStore = getSetting("preferred_jumbo_store", "");
  const coveredStores = new Set();
  const newlyInsertedStores = new Set();
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
        jumboStore: preferredJumboStore,
        includeOutOfStock: true,
      });

      let match = res.products.find(
        (p) =>
          String(p.externalId) === String(pinned.external_id) ||
          String(p.sku) === String(pinned.sku)
      );

      if (!match && pinned.url && ["jumbo", "santaisabel"].includes(pinned.store)) {
        try {
          match = await fetchProductByUrl(pinned.url);
        } catch {}
      }

      if (!match) {
        match = res.products[0];
      }

      if (match) {
        const snapRes = touchOrInsertSnapshot({
          trackedItemId: item.id,
          pinnedProductId: pinned.id,
          product: match,
          recordedAt: now,
        });
        if (snapRes?.inserted) newlyInsertedStores.add(pinned.store);
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
      const searchQ = buildCrossStoreSearchQuery(item.search_query) || item.search_query;
      const res = await searchAllStores(searchQ, {
        stores: remainingStores,
        limitPerStore: 15,
        minRelevance: 0.45,
        verifyLinks: true,
        jumboStore: preferredJumboStore,
        includeOutOfStock: true,
      });

      const targetUnit = detectDominantUnit(res.products, item.preferred_unit);
      const qCheck = item.search_query || item.title;
      const refSpec = extractQuantityFromText(qCheck, "");

      for (const storeId of remainingStores) {
        const storeItems = res.products.filter((p) => p.store === storeId);
        if (storeItems.length === 0) continue;

        const pureItems = storeItems.filter(
          (p) =>
            p.isPure !== false &&
            p.linkStatus !== "broken" &&
            checkProductPurity(qCheck, p.name, p.brand).isPure !== false
        );
        if (pureItems.length === 0) continue;

        // Priorizar productos CON STOCK (excluir agotados cuando exista alternativa disponible)
        const inStockPure = pureItems.filter(
          (p) => p.inStock !== false && p.stockStatus !== "out_of_stock"
        );
        const stockFiltered = inStockPure.length > 0 ? inStockPure : pureItems;

        // Priorizar productos 100% puros (no mezclas) si existen en esa tienda
        const nonBlend = stockFiltered.filter((p) => !p.isBlend);
        let preferredPool = nonBlend.length > 0 ? nonBlend : stockFiltered;

        // Si tenemos referencia de gramaje/volumen (ej. sobre 15g o 76g), evitar formatos 10x distintos
        if (refSpec && refSpec.baseAmount > 0) {
          const nearSize = preferredPool.filter((p) => {
            if (p.unit !== refSpec.unit || !p.baseAmount) return true;
            const ratio = Math.max(p.baseAmount / refSpec.baseAmount, refSpec.baseAmount / p.baseAmount);
            return ratio <= 4;
          });
          if (nearSize.length > 0) preferredPool = nearSize;
        }

        // Filtrar por la misma unidad (kg o lt) para comparar justamente $/kg o $/L
        const unitMatched = preferredPool.filter((p) => p.unit === targetUnit);
        const candidates = unitMatched.length > 0 ? unitMatched : preferredPool;

        // Elegir el más económico considerando stock primero y precio regular o efectivo por promo
        candidates.sort(
          (a, b) =>
            (a.inStock === false ? 1 : 0) - (b.inStock === false ? 1 : 0) ||
            Math.min(a.effectiveUnitPrice || a.unitPrice, a.unitPrice) -
              Math.min(b.effectiveUnitPrice || b.unitPrice, b.unitPrice)
        );
        const best = candidates[0];

        if (best) {
          // Respetar si el usuario ya reportó este mismo SKU agotado por zona en las últimas 24h cuando la API nacional viene sin ubicación
          const prevSnap = item.latestByStore?.[storeId];
          const prevOutRecent =
            prevSnap &&
            prevSnap.stock_status === "out_of_stock" &&
            String(prevSnap.external_id) === String(best.externalId) &&
            best.stockStatus === "unverified_zone" &&
            Date.now() - new Date(prevSnap.recorded_at).getTime() < 24 * 60 * 60 * 1000;

          if (!prevOutRecent) {
            const snapRes = touchOrInsertSnapshot({
              trackedItemId: item.id,
              pinnedProductId: null,
              product: best,
              recordedAt: now,
            });
            if (snapRes?.inserted) newlyInsertedStores.add(storeId);
          }
          savedSnapshots.push(best);
        }
      }
    }
  }

  const updatedItem = getTrackedItemById(item.id);

  // Comprobar alertas de Telegram si está habilitado (solo ante cambios nuevos)
  try {
    const telegramEnabled = getSetting("telegram_enabled") === "1";
    const token = getSetting("telegram_token");
    const chatId = getSetting("telegram_chat_id");
    const thresholdPct = Number(getSetting("telegram_threshold_pct", "12"));

    if (telegramEnabled && token && chatId && updatedItem && newlyInsertedStores.size > 0) {
      const targetPrice = Number(updatedItem.target_price_clp || 0);
      for (const [storeId, vStat] of Object.entries(updatedItem.variabilityByStore || {})) {
        if (!newlyInsertedStores.has(storeId)) continue;
        const latestSnap = updatedItem.latestByStore?.[storeId];
        if (!latestSnap || latestSnap.in_stock === false || latestSnap.stock_status === "out_of_stock") {
          continue;
        }

        const isPctDrop = vStat && vStat.deltaPrevPct <= -thresholdPct;
        const isTargetHit =
          targetPrice > 0 &&
          (latestSnap.price <= targetPrice || latestSnap.unit_price <= targetPrice);

        if (isPctDrop || isTargetHit) {
          const oldPrice =
            vStat && vStat.deltaPrevPct < 0
              ? Math.round(latestSnap.price / (1 + vStat.deltaPrevPct / 100))
              : latestSnap.price;
          let msg = formatPriceAlertMessage({
            item: updatedItem,
            storeName: STORES[storeId]?.name || storeId,
            oldPrice,
            newPrice: latestSnap.price,
            unitPrice: latestSnap.unit_price,
            unit: latestSnap.unit,
            savingsPct: Math.max(0, Math.abs(Math.round(vStat?.deltaPrevPct || 0))),
            productUrl: latestSnap.product_url,
          });
          if (isTargetHit) {
            msg = `🎯 <b>¡ALCANZÓ TU PRECIO OBJETIVO ($${targetPrice.toLocaleString("es-CL")})!</b>\n\n` + msg;
          }
          sendTelegramNotification({ token, chatId, text: msg }).catch(() => {});
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

  // Alerta opcional de carrito completo bajo presupuesto objetivo
  try {
    const telegramEnabled = getSetting("telegram_enabled") === "1";
    const token = getSetting("telegram_token");
    const chatId = getSetting("telegram_chat_id");
    const cartTargetClp = Number(getSetting("telegram_cart_target_clp", "0"));
    if (telegramEnabled && token && chatId && cartTargetClp > 0) {
      const { listCarts, evaluateCart } = await import("./carts.mjs");
      const carts = listCarts();
      for (const c of carts) {
        const ev = evaluateCart(c);
        const top = ev?.singleStoreRanking?.[0];
        const bestNet = top ? (top.netDiscountedTotalClp ?? top.netTotalClp ?? 0) : 0;
        if (bestNet > 0 && bestNet <= cartTargetClp) {
          const alertKey = `tg_cart_alert_${c.id}`;
          const prevSent = Number(getSetting(alertKey, "0"));
          if (prevSent !== bestNet) {
            setSetting(alertKey, String(bestNet));
            const text =
              `🛒🎯 <b>¡CARRITO BAJO TU PRESUPUESTO!</b>\n\n` +
              `<b>Carrito:</b> ${c.name}\n` +
              `<b>Mejor súper:</b> ${top.storeName}\n` +
              `<b>Total Neto:</b> $${bestNet.toLocaleString("es-CL")} <i>(Objetivo: $${cartTargetClp.toLocaleString("es-CL")})</i>\n\n` +
              `<i>Monitoreado por SuperPrecio CL</i>`;
            sendTelegramNotification({ token, chatId, text }).catch(() => {});
          }
        }
      }
    }
  } catch {}

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
