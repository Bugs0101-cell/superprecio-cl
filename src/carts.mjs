import { db, listTrackedItems } from "./db.mjs";
import {
  calculateDiscountedPricing,
  getTodayDayIndex,
  getWeekdayName,
} from "./discounts.mjs";
import {
  checkProductPurity,
  estimateProteinMetrics,
  extractQuantityFromText,
  inferBrand,
  normalizeProductUrl,
  parseBundle,
} from "./normalizer.mjs";
import { searchAllStores, STORES } from "./scrapers.mjs";

const ALL_STORES = ["jumbo", "santaisabel", "unimarc", "tottus", "lider"];
const AUTO_STORES = ["jumbo", "santaisabel", "unimarc", "tottus"];

// Crear tablas para Carritos de Compra
db.exec(`
  CREATE TABLE IF NOT EXISTS shopping_carts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    criteria TEXT NOT NULL DEFAULT 'unit_price',
    delivery_cost INTEGER DEFAULT 3500,
    free_delivery_threshold INTEGER DEFAULT 35000,
    enable_friction INTEGER DEFAULT 1,
    active_programs TEXT DEFAULT '["cmr","cencosud","unimarc_club","lider_bci"]',
    day_of_week INTEGER DEFAULT -1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    search_query TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    preferred_unit TEXT NOT NULL DEFAULT 'auto',
    options_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (cart_id) REFERENCES shopping_carts(id) ON DELETE CASCADE
  );
`);

// Migraciones de columnas para bases existentes
try { db.exec("ALTER TABLE shopping_carts ADD COLUMN delivery_cost INTEGER DEFAULT 3500;"); } catch {}
try { db.exec("ALTER TABLE shopping_carts ADD COLUMN free_delivery_threshold INTEGER DEFAULT 35000;"); } catch {}
try { db.exec("ALTER TABLE shopping_carts ADD COLUMN enable_friction INTEGER DEFAULT 1;"); } catch {}
try { db.exec("ALTER TABLE shopping_carts ADD COLUMN active_programs TEXT DEFAULT '[\"cmr\",\"cencosud\",\"unimarc_club\",\"lider_bci\"]';"); } catch {}
try { db.exec("ALTER TABLE shopping_carts ADD COLUMN day_of_week INTEGER DEFAULT -1;"); } catch {}

function detectDominantUnit(products, preferredUnit) {
  if (preferredUnit && preferredUnit !== "auto") return preferredUnit;
  const counts = { kg: 0, lt: 0, un: 0 };
  for (const p of products) {
    if (p.unit && counts[p.unit] !== undefined) counts[p.unit]++;
  }
  if (counts.kg >= counts.lt && counts.kg > 0) return "kg";
  if (counts.lt > counts.kg && counts.lt > 0) return "lt";
  return "un";
}

function toCartCandidate(p, storeOverride = null) {
  const store = storeOverride || p.store;
  const spec = extractQuantityFromText(p.name, p.formatLabel);
  const unit = p.unit || spec?.unit || "un";
  const baseAmount = p.baseAmount || spec?.baseAmount || 1;
  const brand = inferBrand(p.name, p.brand);
  const nut = estimateProteinMetrics(p.name, unit, baseAmount, p.price, brand);

  const bundle = p.promoText ? parseBundle(p.promoText) : null;
  const promoUnitPrice =
    p.bundlePricePerItem ||
    (bundle?.unitPriceInBundle && bundle.unitPriceInBundle < p.price
      ? bundle.unitPriceInBundle
      : null);
  const promoMinQty = promoUnitPrice ? bundle?.minQuantity || 2 : null;
  const effectiveUnitPrice =
    promoUnitPrice && baseAmount > 0
      ? Math.round(promoUnitPrice / baseAmount)
      : p.effectiveUnitPrice || p.unitPrice;

  return {
    externalId: String(p.externalId || p.sku),
    sku: String(p.sku || p.externalId),
    store,
    name: p.name,
    brand,
    price: p.price,
    listPrice: p.listPrice || null,
    bundlePricePerItem: promoUnitPrice,
    promoMinQty,
    promoBundlePrice: bundle?.bundlePrice || null,
    promoText: p.promoText || null,
    unit,
    unitPrice: p.unitPrice,
    effectiveUnitPrice,
    baseAmount,
    formatLabel: p.formatLabel || `1 ${unit}`,
    pricePer100: p.pricePer100 || Math.round(p.unitPrice / 10),
    hasProteinData: nut.hasProteinData,
    proteinGramsTotal: nut.proteinGramsTotal,
    proteinPer100g: nut.proteinPer100g,
    pricePer10gProtein: nut.pricePer10gProtein,
    nutritionScore: nut.nutritionScore,
    nutritionGrade: nut.nutritionGrade,
    nutritionBadge: nut.nutritionBadge,
    linkStatus: p.linkStatus || "unknown",
    url: normalizeProductUrl(p.url || "", store),
    imageUrl: p.imageUrl || "",
  };
}

function enrichCartCandidate(c, searchQuery, storeOverride = null) {
  getCandidateSpec(c);
  const store = storeOverride || c.store;
  const brand = inferBrand(c.name, c.brand);
  const nut = estimateProteinMetrics(c.name, c.unit, c.baseAmount, c.price, brand);
  const purity = checkProductPurity(searchQuery, c.name, brand);
  const bundle = c.promoText ? parseBundle(c.promoText) : null;
  const promoUnitPrice =
    c.bundlePricePerItem ||
    (bundle?.unitPriceInBundle && bundle.unitPriceInBundle < c.price
      ? bundle.unitPriceInBundle
      : null);
  const promoMinQty = c.promoMinQty || (promoUnitPrice ? bundle?.minQuantity || 2 : null);
  const effectiveUnitPrice =
    promoUnitPrice && c.baseAmount > 0
      ? Math.round(promoUnitPrice / c.baseAmount)
      : c.effectiveUnitPrice || c.unitPrice;

  return {
    ...c,
    store,
    brand,
    bundlePricePerItem: promoUnitPrice,
    promoMinQty,
    promoBundlePrice: c.promoBundlePrice || bundle?.bundlePrice || null,
    effectiveUnitPrice,
    url: normalizeProductUrl(c.url || "", store),
    hasProteinData: nut.hasProteinData,
    proteinGramsTotal: nut.proteinGramsTotal,
    proteinPer100g: nut.proteinPer100g,
    pricePer10gProtein: nut.pricePer10gProtein,
    nutritionScore: nut.nutritionScore,
    nutritionGrade: nut.nutritionGrade,
    nutritionBadge: nut.nutritionBadge,
    isPure: purity.isPure,
    isBlend: purity.isBlend,
    purityWarning: purity.purityWarning,
  };
}

function getCandidateSpec(c) {
  const spec = extractQuantityFromText(c.name || "", c.formatLabel || "");
  const fallbackUnit = ["kg", "lt", "un"].includes(c.unit) ? c.unit : "un";
  const unit = spec?.unit || fallbackUnit;
  const baseAmount =
    spec?.baseAmount > 0 ? spec.baseAmount : c.baseAmount > 0 ? c.baseAmount : 1;
  if (spec?.baseAmount > 0 && c.price > 0) {
    c.unit = spec.unit;
    c.baseAmount = spec.baseAmount;
    c.unitPrice = Math.round(c.price / spec.baseAmount);
  } else {
    c.unit = unit;
    c.baseAmount = baseAmount;
  }
  return { unit, baseAmount };
}

/**
 * Busca candidatos por tienda para un ítem del carrito.
 * Guarda hasta 6 opciones por supermercado para que el usuario pueda
 * dejar la selección automática o elegir una marca/formato específico.
 */
export async function fetchCandidatesForCartQuery(searchQuery, preferredUnit = "auto") {
  const res = await searchAllStores(searchQuery, {
    stores: AUTO_STORES,
    limitPerStore: 14,
    minRelevance: 0.4,
    verifyLinks: true,
  });

  const targetUnit = detectDominantUnit(res.products, preferredUnit);
  const candidatesByStore = {};

  for (const storeId of AUTO_STORES) {
    const storeProds = res.products.filter((p) => p.store === storeId);
    const unitMatched = storeProds.filter((p) => p.unit === targetUnit);
    const list = (unitMatched.length > 0 ? unitMatched : storeProds).slice(0, 6);
    candidatesByStore[storeId] = list.map((p) => toCartCandidate(p));
  }

  return { targetUnit, candidatesByStore };
}

/**
 * Calcula el subtotal para `quantity` envases de un producto,
 * aplicando promociones multi-compra (ej. 2 x $3.000) si la cantidad cumple el mínimo.
 */
function computeLinePricing(candidate, quantity) {
  const qty = Math.max(1, Number(quantity) || 1);
  const unitPackagePrice = candidate.price;
  const normalPackagePrice = candidate.listPrice || candidate.price;

  let lineTotal = unitPackagePrice * qty;
  let appliedPromo = false;

  const minQty = candidate.promoMinQty || 2;
  if (
    candidate.bundlePricePerItem &&
    candidate.bundlePricePerItem < unitPackagePrice &&
    qty >= minQty
  ) {
    if (candidate.promoBundlePrice && minQty >= 2) {
      const packs = Math.floor(qty / minQty);
      const rem = qty % minQty;
      lineTotal = packs * candidate.promoBundlePrice + rem * unitPackagePrice;
    } else {
      lineTotal = candidate.bundlePricePerItem * qty;
    }
    appliedPromo = true;
  }

  const normalLineTotal = normalPackagePrice * qty;
  const effectivePackagePrice = Math.round(lineTotal / qty);

  return {
    qty,
    unitPackagePrice,
    effectivePackagePrice,
    lineTotal,
    normalLineTotal,
    lineSavings: Math.max(0, normalLineTotal - lineTotal),
    appliedPromo,
    promoText: candidate.promoText || null,
  };
}

/**
 * Evalúa un carrito completo:
 * - Resuelve qué producto aplica en cada tienda para cada ítem
 * - Calcula el ranking de supermercados (todo en 1 tienda)
 * - Calcula la mejor combinación de 2 supermercados
 * - Calcula el carrito óptimo dividido (cada producto donde es más barato)
 */
function compareByCartCriteria(prodA, prodB, lineA, lineB, criteria) {
  const pureA = prodA.isPure !== false ? 0 : 1;
  const pureB = prodB.isPure !== false ? 0 : 1;
  if (pureA !== pureB) return pureA - pureB;

  if (criteria === "effective_unit_price") {
    const eA = prodA.effectiveUnitPrice || prodA.unitPrice || 0;
    const eB = prodB.effectiveUnitPrice || prodB.unitPrice || 0;
    return eA - eB || lineA - lineB;
  }
  if (criteria === "protein_price") {
    const pA = prodA.pricePer10gProtein || 9999999;
    const pB = prodB.pricePer10gProtein || 9999999;
    return pA - pB || (prodA.unitPrice || 0) - (prodB.unitPrice || 0);
  }
  if (criteria === "nutrition_score") {
    const sA = prodA.nutritionScore || 0;
    const sB = prodB.nutritionScore || 0;
    return sB - sA || (prodA.unitPrice || 0) - (prodB.unitPrice || 0);
  }
  if (criteria === "total_price") {
    return lineA - lineB || (prodA.unitPrice || 0) - (prodB.unitPrice || 0);
  }
  return (prodA.unitPrice || 0) - (prodB.unitPrice || 0) || lineA - lineB;
}

export function evaluateCart(cartRow) {
  const rawItems = db
    .prepare("SELECT * FROM cart_items WHERE cart_id = ? ORDER BY id ASC")
    .all(cartRow.id);

  // Criterio global del carrito: 'unit_price' ($/kg o $/L más barato) o 'total_price' (envase más barato)
  const criteria = cartRow.criteria || "unit_price";
  const deliveryCost = Number(cartRow.delivery_cost ?? 3500);
  const freeDeliveryThreshold = Number(cartRow.free_delivery_threshold ?? 35000);
  const enableFriction = cartRow.enable_friction !== 0;

  let activePrograms = ["cmr", "cencosud", "unimarc_club", "lider_bci"];
  try {
    if (cartRow.active_programs) {
      activePrograms = JSON.parse(cartRow.active_programs);
    }
  } catch {}

  const dayOfWeek =
    cartRow.day_of_week !== undefined && cartRow.day_of_week >= 0
      ? Number(cartRow.day_of_week)
      : getTodayDayIndex();
  const weekdayName = getWeekdayName(dayOfWeek);

  const items = rawItems.map((row) => {
    let parsed = {};
    try {
      parsed = JSON.parse(row.options_json || "{}");
    } catch {
      parsed = {};
    }

    const candidatesByStore = parsed.candidatesByStore || {};
    const selectedByStore = parsed.selectedByStore || {};
    const qty = Math.max(1, Number(row.quantity) || 1);

    let refSpec = null;
    if (candidatesByStore.lider?.[0]) {
      refSpec = getCandidateSpec(candidatesByStore.lider[0]);
    } else {
      const labelSpec = extractQuantityFromText(row.label, "");
      refSpec = labelSpec || {
        unit: row.preferred_unit && row.preferred_unit !== "auto" ? row.preferred_unit : "un",
        baseAmount: 1,
      };
    }
    const targetTotalAmount = qty * refSpec.baseAmount;

    const getScaledQty = (cand) => {
      const candSpec = getCandidateSpec(cand);
      if (candSpec.unit === refSpec.unit && refSpec.baseAmount > 0 && candSpec.baseAmount > 0) {
        const ratio = targetTotalAmount / candSpec.baseAmount;
        const singleRatio = candSpec.baseAmount / refSpec.baseAmount;
        if (singleRatio >= 0.65 && singleRatio <= 1.35) return qty;
        return Math.max(1, Math.round(ratio));
      }
      return qty;
    };

    const getSizeRatio = (cand) => {
      const candSpec = getCandidateSpec(cand);
      if (candSpec.unit !== refSpec.unit || refSpec.baseAmount <= 0 || candSpec.baseAmount <= 0) {
        return 999;
      }
      return Math.max(candSpec.baseAmount / refSpec.baseAmount, refSpec.baseAmount / candSpec.baseAmount);
    };

    const storeOffers = {};
    const qCheck = row.search_query || row.label;

    for (const storeId of ALL_STORES) {
      const rawCandidates = Array.isArray(candidatesByStore[storeId])
        ? candidatesByStore[storeId]
        : [];
      if (rawCandidates.length === 0) continue;

      const candidates = rawCandidates.map((c) => enrichCartCandidate(c, qCheck, storeId));

      // Ordenar priorizando equivalencia de pureza, formatos equivalentes (sizeRatio <= 2.2) y el criterio elegido
      candidates.sort((a, b) => {
        const pureA = a.isPure !== false ? 0 : 1;
        const pureB = b.isPure !== false ? 0 : 1;
        if (pureA !== pureB) return pureA - pureB;

        const closeA = getSizeRatio(a) <= 2.2 ? 0 : 1;
        const closeB = getSizeRatio(b) <= 2.2 ? 0 : 1;
        if (closeA !== closeB) return closeA - closeB;

        const lineA = (a.price || 0) * getScaledQty(a);
        const lineB = (b.price || 0) * getScaledQty(b);
        return compareByCartCriteria(a, b, lineA, lineB, criteria);
      });

      const manualSku = selectedByStore[storeId];
      const chosen =
        (manualSku &&
          candidates.find((c) => String(c.externalId) === String(manualSku))) ||
        candidates[0];

      if (chosen) {
        const scaledQty = getScaledQty(chosen);
        const pricing = computeLinePricing(chosen, scaledQty);
        const cardDiscount = calculateDiscountedPricing({
          store: storeId,
          price: pricing.unitPackagePrice,
          memberPrice: chosen.memberPrice,
          activePrograms,
          dayOfWeek,
        });

        const discountedLineTotal = cardDiscount.finalPrice * scaledQty;

        storeOffers[storeId] = {
          store: storeId,
          product: chosen,
          isManualSelection: Boolean(manualSku),
          ...pricing,
          baseQty: qty,
          isScaledQty: scaledQty !== qty,
          cardDiscount,
          discountedLineTotal,
          candidates,
        };
      }
    }

    // Determinar qué supermercado gana en este ítem del carrito
    const availableOffers = Object.values(storeOffers);
    availableOffers.sort((a, b) =>
      compareByCartCriteria(a.product, b.product, a.lineTotal, b.lineTotal, criteria)
    );

    const bestOffer = availableOffers[0] || null;
    const worstOffer =
      availableOffers.length > 1 ? availableOffers[availableOffers.length - 1] : null;

    return {
      id: row.id,
      cartId: row.cart_id,
      label: row.label,
      searchQuery: row.search_query,
      quantity: qty,
      preferredUnit: row.preferred_unit,
      storeOffers,
      bestStore: bestOffer?.store || null,
      bestOffer,
      worstOffer,
      maxItemSavingsClp:
        bestOffer && worstOffer
          ? Math.max(0, worstOffer.lineTotal - bestOffer.lineTotal)
          : 0,
    };
  });

  const totalItemsCount = items.length;

  // 1. Ranking Comprar Todo en 1 Solo Supermercado
  const singleStoreRanking = [];
  for (const storeId of ALL_STORES) {
    let totalClp = 0;
    let normalTotalClp = 0;
    let discountedTotalClp = 0;
    let foundCount = 0;
    let totalProteinGramsRaw = 0;
    let proteinSpendClp = 0;
    let scoreSum = 0;
    let scoreCount = 0;
    const missingItems = [];

    for (const item of items) {
      const offer = item.storeOffers[storeId];
      if (offer) {
        totalClp += offer.lineTotal;
        normalTotalClp += offer.normalLineTotal;
        discountedTotalClp += offer.discountedLineTotal;
        foundCount++;
        const protGrams = (offer.product?.proteinGramsTotal || 0) * (offer.qty || 1);
        if (protGrams > 0) {
          totalProteinGramsRaw += protGrams;
          proteinSpendClp += offer.lineTotal;
        }
        if (offer.product?.nutritionScore > 0) {
          scoreSum += offer.product.nutritionScore;
          scoreCount++;
        }
      } else {
        missingItems.push(item.label);
      }
    }

    if (foundCount > 0) {
      const deliveryFee =
        enableFriction && totalClp < freeDeliveryThreshold ? deliveryCost : 0;
      const netTotalClp = totalClp + deliveryFee;
      const totalProteinGrams = Math.round(totalProteinGramsRaw);
      const avgCostPer10gProtein =
        totalProteinGrams > 0 ? Math.round(proteinSpendClp / (totalProteinGrams / 10)) : null;
      const avgNutritionScore = scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null;

      singleStoreRanking.push({
        store: storeId,
        storeName: STORES[storeId]?.name || storeId,
        totalClp,
        normalTotalClp,
        discountedTotalClp,
        deliveryFee,
        netTotalClp,
        offerSavingsClp: Math.max(0, normalTotalClp - totalClp),
        cardSavingsClp: Math.max(0, totalClp - discountedTotalClp),
        foundCount,
        totalItemsCount,
        missingCount: totalItemsCount - foundCount,
        missingItems,
        isComplete: foundCount === totalItemsCount,
        totalProteinGrams,
        proteinSpendClp,
        avgCostPer10gProtein,
        avgNutritionScore,
      });
    }
  }

  // Priorizar tiendas con más productos encontrados, y luego menor costo total
  singleStoreRanking.sort((a, b) => {
    if (b.foundCount !== a.foundCount) return b.foundCount - a.foundCount;
    return a.totalClp - b.totalClp;
  });

  const winnerSingleStore = singleStoreRanking[0] || null;
  const comparableStores = singleStoreRanking.filter(
    (s) => winnerSingleStore && s.foundCount === winnerSingleStore.foundCount
  );
  const mostExpensiveComparable =
    comparableStores.length > 1
      ? comparableStores[comparableStores.length - 1]
      : winnerSingleStore;

  const singleStoreMaxSavingsClp =
    winnerSingleStore && mostExpensiveComparable
      ? Math.max(0, mostExpensiveComparable.totalClp - winnerSingleStore.totalClp)
      : 0;

  // Añadir diferencia vs el ganador a cada tienda del ranking
  for (const s of singleStoreRanking) {
    s.diffVsWinnerClp = winnerSingleStore ? s.totalClp - winnerSingleStore.totalClp : 0;
    s.diffVsWinnerPct =
      winnerSingleStore && winnerSingleStore.totalClp > 0
        ? Number(
            (((s.totalClp - winnerSingleStore.totalClp) / winnerSingleStore.totalClp) * 100).toFixed(1)
          )
        : 0;
  }

  // 2. Carrito Óptimo Dividido (Cada producto donde es más barato)
  let splitTotalClp = 0;
  let splitFoundCount = 0;
  const splitByStore = {};

  for (const item of items) {
    const offers = Object.values(item.storeOffers);
    if (offers.length === 0) continue;

    offers.sort((a, b) =>
      compareByCartCriteria(a.product, b.product, a.lineTotal, b.lineTotal, criteria)
    );
    const chosen = offers[0];
    splitTotalClp += chosen.lineTotal;
    splitFoundCount++;

    if (!splitByStore[chosen.store]) {
      splitByStore[chosen.store] = {
        store: chosen.store,
        storeName: STORES[chosen.store]?.name || chosen.store,
        subtotalClp: 0,
        items: [],
      };
    }
    splitByStore[chosen.store].subtotalClp += chosen.lineTotal;
    splitByStore[chosen.store].items.push({
      itemId: item.id,
      label: item.label,
      quantity: item.quantity,
      productName: chosen.product.name,
      brand: chosen.product.brand,
      formatLabel: chosen.product.formatLabel,
      unitPackagePrice: chosen.unitPackagePrice,
      lineTotal: chosen.lineTotal,
      unitPrice: chosen.product.unitPrice,
      unit: chosen.product.unit,
      pricePer10gProtein: chosen.product.pricePer10gProtein || null,
      url: chosen.product.url,
    });
  }

  // Despacho / Fricción por tienda en carrito dividido
  let splitTotalDeliveryFees = 0;
  for (const grp of Object.values(splitByStore)) {
    const fee =
      enableFriction && grp.subtotalClp < freeDeliveryThreshold ? deliveryCost : 0;
    grp.deliveryFee = fee;
    grp.netTotalClp = grp.subtotalClp + fee;
    splitTotalDeliveryFees += fee;
  }
  const splitNetTotalClp = splitTotalClp + splitTotalDeliveryFees;

  const splitSavingsVsBestSingleClp =
    winnerSingleStore && splitFoundCount === winnerSingleStore.foundCount
      ? Math.max(0, winnerSingleStore.totalClp - splitTotalClp)
      : 0;

  // Veredicto de Costo Neto (considerando despachos)
  const bestSingleNet = winnerSingleStore ? winnerSingleStore.netTotalClp : 0;
  let frictionVerdict = "tie";
  let frictionVerdictMsg = "Ambas opciones tienen un costo neto similar.";
  let netSavingsClp = 0;

  if (winnerSingleStore) {
    if (splitNetTotalClp < bestSingleNet) {
      netSavingsClp = bestSingleNet - splitNetTotalClp;
      frictionVerdict = "split_cheaper";
      frictionVerdictMsg = `✅ ¡Conviene dividir la compra! Incluso pagando los envíos/traslados de cada tienda ($${splitTotalDeliveryFees.toLocaleString("es-CL")}), ahorras $${netSavingsClp.toLocaleString("es-CL")} netos frente a comprar todo en ${winnerSingleStore.storeName}.`;
    } else if (splitNetTotalClp > bestSingleNet) {
      netSavingsClp = splitNetTotalClp - bestSingleNet;
      frictionVerdict = "single_cheaper";
      frictionVerdictMsg = `⚠️ ¡Cuidado con el despacho/traslado! Aunque ahorras $${splitSavingsVsBestSingleClp.toLocaleString("es-CL")} en productos, pagarías $${splitTotalDeliveryFees.toLocaleString("es-CL")} en ${Object.keys(splitByStore).length} despachos. Comprar todo en ${winnerSingleStore.storeName} te ahorra $${netSavingsClp.toLocaleString("es-CL")} netos de bolsillo.`;
    } else {
      frictionVerdict = "tie";
      frictionVerdictMsg = "Ambas opciones tienen el mismo costo neto final.";
    }
  }

  // 3. Mejor Combinación de Máximo 2 Supermercados (incluyendo costo de despacho por tienda)
  let bestTwoCombo = null;
  const activeStoreIds = singleStoreRanking.map((s) => s.store);
  for (let i = 0; i < activeStoreIds.length; i++) {
    for (let j = i + 1; j < activeStoreIds.length; j++) {
      const sA = activeStoreIds[i];
      const sB = activeStoreIds[j];
      let pairTotal = 0;
      let subA = 0;
      let subB = 0;
      let pairFound = 0;
      for (const item of items) {
        const oA = item.storeOffers[sA];
        const oB = item.storeOffers[sB];
        if (!oA && !oB) continue;
        pairFound++;
        if (oA && oB) {
          if (oA.lineTotal <= oB.lineTotal) {
            subA += oA.lineTotal;
            pairTotal += oA.lineTotal;
          } else {
            subB += oB.lineTotal;
            pairTotal += oB.lineTotal;
          }
        } else if (oA) {
          subA += oA.lineTotal;
          pairTotal += oA.lineTotal;
        } else {
          subB += oB.lineTotal;
          pairTotal += oB.lineTotal;
        }
      }
      const feeA =
        enableFriction && subA > 0 && subA < freeDeliveryThreshold ? deliveryCost : 0;
      const feeB =
        enableFriction && subB > 0 && subB < freeDeliveryThreshold ? deliveryCost : 0;
      const deliveryFeesClp = feeA + feeB;
      const netPairTotal = pairTotal + deliveryFeesClp;
      if (
        !bestTwoCombo ||
        pairFound > bestTwoCombo.foundCount ||
        (pairFound === bestTwoCombo.foundCount && netPairTotal < bestTwoCombo.netTotalClp)
      ) {
        bestTwoCombo = {
          stores: [sA, sB],
          storeNames: `${STORES[sA]?.name} + ${STORES[sB]?.name}`,
          totalClp: pairTotal,
          deliveryFeesClp,
          netTotalClp: netPairTotal,
          foundCount: pairFound,
        };
      }
    }
  }

  const storesWithProtein = singleStoreRanking.filter((s) => s.totalProteinGrams > 0);
  storesWithProtein.sort(
    (a, b) =>
      (a.avgCostPer10gProtein || 999999) - (b.avgCostPer10gProtein || 999999) ||
      b.totalProteinGrams - a.totalProteinGrams
  );
  const bestProteinStore = storesWithProtein[0]
    ? {
        store: storesWithProtein[0].store,
        storeName: storesWithProtein[0].storeName,
        totalProteinGrams: storesWithProtein[0].totalProteinGrams,
        avgCostPer10gProtein: storesWithProtein[0].avgCostPer10gProtein,
      }
    : null;

  const topProteinItems = items
    .map((item) => {
      const proteinOffers = Object.values(item.storeOffers)
        .filter((o) => (o.product?.proteinGramsTotal || 0) > 0)
        .sort(
          (a, b) =>
            (a.product.pricePer10gProtein || 999999) -
            (b.product.pricePer10gProtein || 999999)
        );
      if (proteinOffers.length === 0) return null;
      const bestProt = proteinOffers[0];
      const totalGrams = Math.round(
        (bestProt.product.proteinGramsTotal || 0) * (bestProt.qty || 1)
      );
      return {
        label: item.label,
        totalProteinGrams: totalGrams,
        bestProteinStore: STORES[bestProt.store]?.name || bestProt.store,
        bestPricePer10g: bestProt.product.pricePer10gProtein,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.totalProteinGrams - a.totalProteinGrams)
    .slice(0, 5);

  const cartNutritionSummary = {
    bestProteinStore,
    topProteinItems,
  };

  return {
    id: cartRow.id,
    name: cartRow.name,
    criteria,
    deliveryCost,
    freeDeliveryThreshold,
    enableFriction,
    activePrograms,
    dayOfWeek,
    weekdayName,
    createdAt: cartRow.created_at,
    updatedAt: cartRow.updated_at,
    items,
    singleStoreRanking,
    winnerSingleStore,
    singleStoreMaxSavingsClp,
    bestTwoCombo,
    frictionVerdict,
    frictionVerdictMsg,
    netSavingsClp,
    cartNutritionSummary,
    optimalSplitCart: {
      totalClp: splitTotalClp,
      deliveryFeesClp: splitTotalDeliveryFees,
      netTotalClp: splitNetTotalClp,
      foundCount: splitFoundCount,
      savingsVsBestSingleClp: splitSavingsVsBestSingleClp,
      storesUsedCount: Object.keys(splitByStore).length,
      byStore: Object.values(splitByStore).sort((a, b) => b.subtotalClp - a.subtotalClp),
    },
  };
}

export function updateCartSettings(cartId, settings = {}) {
  const now = new Date().toISOString();
  const current = db
    .prepare("SELECT * FROM shopping_carts WHERE id = ?")
    .get(Number(cartId));
  if (!current) throw new Error("Carrito no encontrado");

  const criteria = settings.criteria !== undefined ? settings.criteria : current.criteria;
  const deliveryCost = settings.deliveryCost !== undefined ? Number(settings.deliveryCost) : (current.delivery_cost ?? 3500);
  const freeThreshold = settings.freeDeliveryThreshold !== undefined ? Number(settings.freeDeliveryThreshold) : (current.free_delivery_threshold ?? 35000);
  const enableFriction = settings.enableFriction !== undefined ? (settings.enableFriction ? 1 : 0) : (current.enable_friction ?? 1);
  const activePrograms = settings.activePrograms !== undefined ? JSON.stringify(settings.activePrograms) : (current.active_programs || '["cmr","cencosud","unimarc_club","lider_bci"]');
  const dayOfWeek = settings.dayOfWeek !== undefined ? Number(settings.dayOfWeek) : (current.day_of_week ?? -1);

  db.prepare(`
    UPDATE shopping_carts
    SET criteria = ?, delivery_cost = ?, free_delivery_threshold = ?, enable_friction = ?, active_programs = ?, day_of_week = ?, updated_at = ?
    WHERE id = ?
  `).run(criteria, deliveryCost, freeThreshold, enableFriction, activePrograms, dayOfWeek, now, Number(cartId));

  return getCartById(cartId);
}

export function listCarts() {
  const rows = db.prepare("SELECT * FROM shopping_carts ORDER BY id ASC").all();
  return rows.map(evaluateCart);
}

export function getCartById(cartId) {
  const row = db
    .prepare("SELECT * FROM shopping_carts WHERE id = ?")
    .get(Number(cartId));
  if (!row) return null;
  return evaluateCart(row);
}

export function createCart({ name, criteria = "unit_price" }) {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      "INSERT INTO shopping_carts (name, criteria, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
    .run((name || "Mi Carrito").trim(), criteria, now, now);
  return Number(res.lastInsertRowid);
}

export function updateCartCriteria(cartId, criteria) {
  const now = new Date().toISOString();
  db.prepare("UPDATE shopping_carts SET criteria = ?, updated_at = ? WHERE id = ?").run(
    criteria,
    now,
    Number(cartId)
  );
  return getCartById(cartId);
}

export function deleteCart(cartId) {
  db.prepare("DELETE FROM shopping_carts WHERE id = ?").run(Number(cartId));
}

/**
 * Añade un ítem al carrito buscando sus candidatos en todos los supermercados.
 */
export async function addCartItem(
  cartId,
  { label, searchQuery, quantity = 1, preferredUnit = "auto", initialProduct = null }
) {
  const now = new Date().toISOString();
  const q = (searchQuery || label || "").trim();
  const lbl = (label || q).trim();

  const { targetUnit, candidatesByStore } = await fetchCandidatesForCartQuery(
    q,
    preferredUnit
  );

  const selectedByStore = {};
  if (initialProduct && initialProduct.store) {
    const st = initialProduct.store;
    if (!candidatesByStore[st]) candidatesByStore[st] = [];
    const exists = candidatesByStore[st].some(
      (c) => String(c.externalId) === String(initialProduct.externalId)
    );
    if (!exists) {
      candidatesByStore[st].unshift(toCartCandidate(initialProduct, st));
    }
    selectedByStore[st] = String(initialProduct.externalId || initialProduct.sku);
  }

  const optionsJson = JSON.stringify({ candidatesByStore, selectedByStore });

  db.prepare(
    `INSERT INTO cart_items (cart_id, label, search_query, quantity, preferred_unit, options_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Number(cartId),
    lbl,
    q,
    Math.max(1, Number(quantity) || 1),
    targetUnit || preferredUnit,
    optionsJson,
    now
  );

  db.prepare("UPDATE shopping_carts SET updated_at = ? WHERE id = ?").run(
    now,
    Number(cartId)
  );

  return getCartById(cartId);
}

/**
 * Actualiza cantidad o selección manual de marca/producto por supermercado en un ítem del carrito.
 */
export function updateCartItem(cartId, itemId, { quantity, selectStore, selectExternalId }) {
  const row = db
    .prepare("SELECT * FROM cart_items WHERE id = ? AND cart_id = ?")
    .get(Number(itemId), Number(cartId));
  if (!row) throw new Error("Ítem del carrito no encontrado");

  let newQty = row.quantity;
  if (quantity !== undefined) {
    newQty = Math.max(1, Number(quantity) || 1);
  }

  let parsed = {};
  try {
    parsed = JSON.parse(row.options_json || "{}");
  } catch {
    parsed = {};
  }

  if (selectStore) {
    parsed.selectedByStore = parsed.selectedByStore || {};
    if (!selectExternalId || selectExternalId === "auto") {
      delete parsed.selectedByStore[selectStore];
    } else {
      parsed.selectedByStore[selectStore] = String(selectExternalId);
    }
  }

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE cart_items SET quantity = ?, options_json = ? WHERE id = ?"
  ).run(newQty, JSON.stringify(parsed), Number(itemId));

  db.prepare("UPDATE shopping_carts SET updated_at = ? WHERE id = ?").run(
    now,
    Number(cartId)
  );

  return getCartById(cartId);
}

export function removeCartItem(cartId, itemId) {
  db.prepare("DELETE FROM cart_items WHERE id = ? AND cart_id = ?").run(
    Number(itemId),
    Number(cartId)
  );
  db.prepare("UPDATE shopping_carts SET updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    Number(cartId)
  );
  return getCartById(cartId);
}

export async function refreshCartPrices(cartId) {
  const items = db
    .prepare("SELECT * FROM cart_items WHERE cart_id = ?")
    .all(Number(cartId));

  for (const item of items) {
    let parsed = {};
    try {
      parsed = JSON.parse(item.options_json || "{}");
    } catch {
      parsed = {};
    }
    const { candidatesByStore } = await fetchCandidatesForCartQuery(
      item.search_query,
      item.preferred_unit
    );
    const existingLider = parsed.candidatesByStore?.lider;
    if (existingLider?.length && !candidatesByStore.lider?.length) {
      candidatesByStore.lider = existingLider;
    }
    parsed.candidatesByStore = candidatesByStore;
    db.prepare("UPDATE cart_items SET options_json = ? WHERE id = ?").run(
      JSON.stringify(parsed),
      item.id
    );
  }

  db.prepare("UPDATE shopping_carts SET updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    Number(cartId)
  );

  return getCartById(cartId);
}

/**
 * Crea un carrito inicial a partir de los productos seguidos si aún no existe ningún carrito,
 * sin hacer llamadas lentas adicionales porque aprovecha los snapshots ya guardados.
 */
export function seedDefaultCartIfNeeded() {
  const existing = db.prepare("SELECT COUNT(*) as cnt FROM shopping_carts").get();
  if (existing && existing.cnt > 0) return;

  const tracked = listTrackedItems();
  if (tracked.length === 0) return;

  const cartId = createCart({
    name: "🛒 Carrito Mensual Familiar",
    criteria: "unit_price",
  });

  const defaultQuantities = [4, 2, 1, 2];
  const now = new Date().toISOString();

  tracked.forEach((tItem, idx) => {
    const qty = defaultQuantities[idx] ?? 1;
    const candidatesByStore = {};
    for (const [storeId, snap] of Object.entries(tItem.latestByStore || {})) {
      candidatesByStore[storeId] = [
        {
          externalId: String(snap.external_id),
          sku: String(snap.external_id),
          store: storeId,
          name: snap.product_name,
          brand: snap.brand || "",
          price: snap.price,
          listPrice: snap.list_price || null,
          bundlePricePerItem: null,
          promoText: snap.promo_text || null,
          unit: snap.unit || "un",
          unitPrice: snap.unit_price,
          effectiveUnitPrice: snap.effective_unit_price || snap.unit_price,
          formatLabel: snap.format_label || `1 ${snap.unit || "un"}`,
          pricePer100: snap.price_per_100 || Math.round(snap.unit_price / 10),
          url: snap.product_url || "",
          imageUrl: snap.image_url || "",
        },
      ];
    }

    db.prepare(
      `INSERT INTO cart_items (cart_id, label, search_query, quantity, preferred_unit, options_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      cartId,
      tItem.title,
      tItem.search_query || tItem.title,
      qty,
      tItem.preferred_unit || "auto",
      JSON.stringify({ candidatesByStore, selectedByStore: {} }),
      now
    );
  });
}
