import { randomUUID } from "node:crypto";
import {
  buildCrossStoreSearchQuery,
  checkProductPurity,
  detectPackTraps,
  enrichUnitMetrics,
  estimateProteinMetrics,
  inferBrand,
  matchScore,
  normalizeProductUrl,
  normalizeUnit,
  parseBundle,
  parseClpString,
  parseUnitPriceString,
  toClp,
} from "./normalizer.mjs";

const URL_CHECK_CACHE = new Map();
const URL_CACHE_TTL_MS = 30 * 60 * 1000;

export async function verifyProductUrl(rawUrl, store = "", { force = false } = {}) {
  const verifiedAt = new Date().toISOString();
  const url = normalizeProductUrl(rawUrl, store);
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, status: "broken", httpStatus: 0, url: "", verifiedAt };
  }

  if (!force) {
    const cached = URL_CHECK_CACHE.get(url);
    if (cached && Date.now() - cached.checkedAt < URL_CACHE_TTL_MS) {
      return cached.result;
    }
  }

  const recordResult = (result) => {
    const withTime = { verifiedAt, ...result };
    if (URL_CHECK_CACHE.size > 600) URL_CHECK_CACHE.clear();
    URL_CHECK_CACHE.set(url, { checkedAt: Date.now(), result: withTime });
    return withTime;
  };

  // Unimarc y Lider usan WAF (Akamai / PerimeterX que redirige a /blocked con HTTP 404 en servidor aunque el link funcione en navegador)
  if (
    store === "unimarc" ||
    store === "lider" ||
    /unimarc\.cl|lider\.cl/i.test(url)
  ) {
    return recordResult({ ok: true, status: "protected", httpStatus: 200, url, verifiedAt });
  }

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-CL,es;q=0.9",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(4500),
    });

    if (res.status === 404 || res.status === 410) {
      return recordResult({ ok: false, status: "broken", httpStatus: res.status, url, verifiedAt });
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") || "";
      if (/\/blocked|queue-it|challenge|captcha|perimeterx/i.test(loc)) {
        return recordResult({ ok: true, status: "protected", httpStatus: 200, url, verifiedAt });
      }
      if (/\/404(?:$|[/?#])/i.test(loc)) {
        return recordResult({ ok: false, status: "broken", httpStatus: 404, url, verifiedAt });
      }
      if (loc) {
        const nextUrl = loc.startsWith("http") ? loc : new URL(loc, url).href;
        const r2 = await fetch(nextUrl, {
          method: "GET",
          headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
          redirect: "manual",
          signal: AbortSignal.timeout(4000),
        });
        if (r2.status === 404 || r2.status === 410) {
          return recordResult({ ok: false, status: "broken", httpStatus: r2.status, url, verifiedAt });
        }
        if (r2.status === 200) {
          const fullHtml2 = await r2.text();
          let liveOffer = null;
          if (store === "santaisabel" || store === "jumbo") {
            liveOffer = extractCencosudPdpLiveOffer(fullHtml2, store, nextUrl);
          }
          return recordResult({ ok: true, status: "ok", httpStatus: 200, url: nextUrl, liveOffer, verifiedAt });
        }
      }
    }

    if (res.status === 403 || res.status === 412 || res.status === 429) {
      return recordResult({ ok: true, status: "protected", httpStatus: res.status, url, verifiedAt });
    }

    if (res.status === 200) {
      const fullHtml = await res.text();
      const snippet = fullHtml.slice(0, 12000);
      if (/robot or human|perimeterx|px-captcha/i.test(snippet)) {
        return recordResult({ ok: true, status: "protected", httpStatus: 200, url, verifiedAt });
      }
      if (/<title>[^<]*404|p[áa]gina\s+no\s+encontrada|product(?:o)?\s+no\s+(?:encontrado|disponible)/i.test(snippet)) {
        return recordResult({ ok: false, status: "broken", httpStatus: 404, url, verifiedAt });
      }
      let liveOffer = null;
      if (store === "santaisabel" || store === "jumbo") {
        liveOffer = extractCencosudPdpLiveOffer(fullHtml, store, url);
      }
      return recordResult({ ok: true, status: "ok", httpStatus: 200, url, liveOffer, verifiedAt });
    }

    return recordResult({ ok: true, status: "unknown", httpStatus: res.status, url, verifiedAt });
  } catch {
    return recordResult({ ok: true, status: "unknown", httpStatus: 0, url, verifiedAt });
  }
}

function resolveBrandAndNutrition(name, rawBrand, unitMetrics, price, description = "") {
  const brand = inferBrand(name, rawBrand);
  const nutrition = estimateProteinMetrics(
    name,
    unitMetrics.unit,
    unitMetrics.baseAmount,
    price,
    brand,
    description
  );
  return {
    brand,
    inferredCategory: nutrition.inferredCategory,
    nutritionSeals: nutrition.nutritionSeals || [],
    hasProteinData: nutrition.hasProteinData,
    hasNutritionData: nutrition.hasNutritionData,
    proteinGramsTotal: nutrition.proteinGramsTotal,
    proteinPer100g: nutrition.proteinPer100g,
    pricePer10gProtein: nutrition.pricePer10gProtein,
    nutritionScore: nutrition.nutritionScore,
    nutritionGrade: nutrition.nutritionGrade,
    nutritionBadge: nutrition.nutritionBadge,
  };
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CLIENT_ID = randomUUID();
const CIO_VERSION = "ciojs-2.1436.4";

export const STORES = {
  jumbo: {
    id: "jumbo",
    name: "Jumbo",
    color: "#16a34a",
    bgLight: "rgba(22, 163, 74, 0.14)",
    domain: "jumbo.cl",
    autoSupported: true,
  },
  santaisabel: {
    id: "santaisabel",
    name: "Santa Isabel",
    color: "#dc2626",
    bgLight: "rgba(220, 38, 38, 0.14)",
    domain: "santaisabel.cl",
    autoSupported: true,
  },
  unimarc: {
    id: "unimarc",
    name: "Unimarc",
    color: "#ea580c",
    bgLight: "rgba(234, 88, 12, 0.14)",
    domain: "unimarc.cl",
    autoSupported: true,
  },
  tottus: {
    id: "tottus",
    name: "Tottus",
    color: "#65a30d",
    bgLight: "rgba(101, 163, 13, 0.14)",
    domain: "tottus.cl",
    autoSupported: true,
  },
  lider: {
    id: "lider",
    name: "Lider",
    color: "#2563eb",
    bgLight: "rgba(37, 99, 235, 0.14)",
    domain: "super.lider.cl",
    autoSupported: false, // Protegido por PerimeterX / Queue-it antibot en HTTP plano
  },
};

// --- 1. Adaptador Cencosud (Jumbo y Santa Isabel vía Constructor.io) ---

const CENCOSUD_CONFIGS = {
  jumbo: {
    storeId: "jumbo",
    host: "pwcdauseo-zone.cnstrc.com",
    key: "key_JopvNXKS61kwGkBe",
    siteBaseUrl: "https://www.jumbo.cl",
  },
  santaisabel: {
    storeId: "santaisabel",
    host: "ac.cnstrc.com",
    key: "key_c73M3GMIWJ8AcNnd",
    siteBaseUrl: "https://www.santaisabel.cl",
  },
};

function parseCencosudSkuData(data) {
  const raw = Array.isArray(data?.SkuData) ? data.SkuData[0] : undefined;
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return Object.values(parsed)[0] ?? null;
  } catch {
    return null;
  }
}

function extractBalancedObject(str, startIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      return str.slice(startIdx, i + 1);
    }
  }
  return null;
}

function extractNextFlightFullText(html) {
  if (!html || typeof html !== "string") return "";
  const chunks = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[\d+,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try {
      chunks.push(JSON.parse('"' + m[1] + '"'));
    } catch {}
  }
  return chunks.join("\n");
}

function parseCencosudLiveItemOffer(item) {
  if (!item) return null;
  const price = toClp(item.price);
  if (!price) return null;

  let listPrice = toClp(item.listPrice);
  if (listPrice !== undefined && listPrice <= price) listPrice = undefined;

  const pillName =
    typeof item.pill === "object" && item.pill?.name
      ? String(item.pill.name).trim()
      : null;
  const isAgotadoPill = Boolean(pillName && /agotado/i.test(pillName));
  const inStock = item.stock !== false && !isAgotadoPill;
  const stockStatus = inStock ? "in_stock" : "out_of_stock";

  let bundleText = null;
  let bundlePricePerItem = null;
  let memberPrice = null;
  let memberPromoNote = null;

  const promos = Array.isArray(item.promotions) ? item.promotions : [];
  for (const pr of promos) {
    if (!pr || typeof pr !== "object") continue;
    const pay = String(pr.paymentMethods || "ALL").toUpperCase();
    const isCardOnly = /CENCOSUD/.test(pay) && pay !== "ALL";
    const mQty = Number(pr.mQuantity) || 0;
    const prUnit = toClp(pr.unitPrice);
    const prTotal = toClp(pr.val ?? pr.value) || (prUnit && mQty > 1 ? prUnit * mQty : undefined);

    if (!isCardOnly) {
      if (pr.type === "mx" && mQty > 1 && prTotal && prUnit && prUnit < price && !bundlePricePerItem) {
        bundlePricePerItem = prUnit;
        bundleText = `${mQty} x $${prTotal}`;
      }
    } else {
      if (pr.type === "nominal" && prUnit && prUnit < price && (!memberPrice || prUnit < memberPrice)) {
        memberPrice = prUnit;
      } else if (pr.type === "mx" && mQty > 1 && prTotal && !memberPromoNote) {
        memberPromoNote = `Tarjeta Cencosud ${mQty} x $${prTotal}`;
      }
    }
  }

  const promoParts = [];
  if (bundleText) promoParts.push(bundleText);
  if (pillName && !isAgotadoPill && !promoParts.includes(pillName)) promoParts.push(pillName);
  if (memberPromoNote) promoParts.push(memberPromoNote);
  if (promoParts.length === 0 && (listPrice || promos.length > 0)) {
    promoParts.push("Oferta");
  }

  return {
    skuId: String(item.skuId || ""),
    name: item.name ? String(item.name).trim() : "",
    price,
    listPrice: listPrice ?? null,
    memberPrice,
    promoText: promoParts.length > 0 ? promoParts.join(" · ") : null,
    bundlePricePerItem,
    hasPromotions: promos.length > 0,
    inStock,
    stockStatus,
    storeUnit: item.measurementUnitUn ? normalizeUnit(item.measurementUnitUn) : undefined,
    storeMultiplier: typeof item.unitMultiplierUn === "number" ? item.unitMultiplierUn : undefined,
    imageUrl: Array.isArray(item.images) ? item.images[0] || "" : "",
  };
}

function extractCencosudFlightEntries(html) {
  const full = extractNextFlightFullText(html);
  if (!full) return [];
  const entries = [];
  const seen = new Set();
  const token = '"product":{"productId":';
  let pos = 0;

  while (true) {
    const idx = full.indexOf(token, pos);
    if (idx < 0) break;
    const objStr = extractBalancedObject(full, idx + '"product":'.length);
    pos = idx + token.length;
    if (!objStr) continue;
    try {
      const prodObj = JSON.parse(objStr);
      const firstItem = prodObj?.items?.[0];
      const offer = parseCencosudLiveItemOffer(firstItem);
      if (!offer || !offer.skuId || seen.has(offer.skuId)) continue;
      seen.add(offer.skuId);
      entries.push({
        ...offer,
        productId: String(prodObj.productId || offer.skuId),
        reference: prodObj.reference ? String(prodObj.reference) : offer.skuId,
        slug: prodObj.slug ? String(prodObj.slug) : "",
        brand: prodObj.brand ? String(prodObj.brand) : "",
        name: offer.name || prodObj.name || prodObj.slug?.replace(/-/g, " ") || "",
      });
    } catch {}
  }

  return entries;
}

function extractCencosudPdpLiveOffer(html, storeId, pageUrl = "") {
  if (!html) return null;
  let ldProduct = null;
  for (const m of html.matchAll(LD_JSON_REGEX)) {
    try {
      const parsed = JSON.parse(m[1]);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const hit = arr.find((x) => x && x["@type"] === "Product");
      if (hit) {
        ldProduct = hit;
        break;
      }
    } catch {}
  }

  const flightFull = extractNextFlightFullText(html);
  const targetSku = ldProduct?.sku ? String(ldProduct.sku) : null;
  let flightOffer = null;

  if (flightFull) {
    // Buscar el objeto items:[{skuId:...}] correspondiente al producto de la PDP
    const skuNeedle = targetSku ? `"skuId":"${targetSku}"` : '"skuId":"';
    let pos = 0;
    while (true) {
      const idx = flightFull.indexOf(skuNeedle, pos);
      if (idx < 0) break;
      const braceStart = flightFull.lastIndexOf("{", idx);
      if (braceStart >= 0 && idx - braceStart < 40) {
        const objStr = extractBalancedObject(flightFull, braceStart);
        if (objStr) {
          try {
            const itemObj = JSON.parse(objStr);
            const parsedOffer = parseCencosudLiveItemOffer(itemObj);
            if (parsedOffer && (!targetSku || parsedOffer.skuId === targetSku)) {
              if (
                !flightOffer ||
                (parsedOffer.hasPromotions && !flightOffer.hasPromotions) ||
                (parsedOffer.listPrice && !flightOffer.listPrice)
              ) {
                flightOffer = parsedOffer;
              }
              if (flightOffer.hasPromotions && flightOffer.listPrice) break;
            }
          } catch {}
        }
      }
      pos = idx + skuNeedle.length;
    }
  }

  if (flightOffer) {
    return {
      ...flightOffer,
      brand: ldProduct?.brand?.name || "",
      name: flightOffer.name || ldProduct?.name || "",
      url: normalizeProductUrl(ldProduct?.url || pageUrl, storeId),
    };
  }

  if (ldProduct?.offers) {
    const offerObj = Array.isArray(ldProduct.offers) ? ldProduct.offers[0] : ldProduct.offers;
    const ldPrice = toClp(offerObj?.price);
    if (ldPrice) {
      const availStr = String(offerObj?.availability || "");
      const inStock = !/OutOfStock/i.test(availStr);
      return {
        skuId: targetSku || "",
        name: ldProduct.name || "",
        brand: ldProduct.brand?.name || "",
        price: ldPrice,
        listPrice: null,
        memberPrice: null,
        promoText: null,
        bundlePricePerItem: null,
        inStock,
        stockStatus: inStock ? "in_stock" : "out_of_stock",
        url: normalizeProductUrl(ldProduct.url || pageUrl, storeId),
      };
    }
  }

  return null;
}

function applyCencosudLiveOffer(prod, liveOffer, { preserveStoreStock = false } = {}) {
  if (!prod || !liveOffer || !(liveOffer.price > 0)) return prod;
  const oldPrice = prod.price;
  const nextPrice = liveOffer.price;
  let nextListPrice =
    liveOffer.listPrice && liveOffer.listPrice > nextPrice
      ? liveOffer.listPrice
      : prod.listPrice && prod.listPrice > nextPrice
      ? prod.listPrice
      : oldPrice > nextPrice
      ? oldPrice
      : null;

  const nextUnitMetrics = enrichUnitMetrics({
    price: nextPrice,
    storeUnit: prod.unit,
    storeMultiplier: prod.baseAmount > 0 ? prod.baseAmount : undefined,
    name: prod.name,
    description: "",
  });

  const bundlePrice = liveOffer.bundlePricePerItem ?? prod.bundlePricePerItem ?? null;
  const nextEffUnit =
    bundlePrice && nextUnitMetrics.baseAmount > 0
      ? Math.round(bundlePrice / nextUnitMetrics.baseAmount)
      : nextUnitMetrics.unitPrice;

  const nextBrand = prod.brand || liveOffer.brand || "";
  const nutFields = resolveBrandAndNutrition(prod.name, nextBrand, nextUnitMetrics, nextPrice);

  const nextInStock = preserveStoreStock ? prod.inStock : liveOffer.inStock;
  const nextStockStatus = preserveStoreStock
    ? prod.stockStatus
    : liveOffer.stockStatus || (nextInStock ? "in_stock" : "out_of_stock");

  const prodHasBundle = prod.promoText && parseBundle(prod.promoText)?.type === "bundle";
  const liveHasBundle = liveOffer.promoText && parseBundle(liveOffer.promoText)?.type === "bundle";
  const mergedPromoText =
    liveHasBundle || !prodHasBundle
      ? liveOffer.promoText || prod.promoText || (nextListPrice ? "Oferta" : null)
      : prod.promoText;

  return {
    ...prod,
    price: nextPrice,
    listPrice: nextListPrice,
    memberPrice: liveOffer.memberPrice ?? prod.memberPrice ?? null,
    promoText: mergedPromoText,
    bundlePricePerItem: bundlePrice,
    unit: nextUnitMetrics.unit,
    unitPrice: nextUnitMetrics.unitPrice,
    effectiveUnitPrice: nextEffUnit,
    baseAmount: nextUnitMetrics.baseAmount,
    formatLabel: nextUnitMetrics.formatLabel,
    pricePer100: nextUnitMetrics.pricePer100,
    per100UnitName: nextUnitMetrics.per100UnitName,
    pricePerSmallUnit: nextUnitMetrics.pricePerSmallUnit,
    smallUnitName: nextUnitMetrics.smallUnitName,
    ...nutFields,
    inStock: nextInStock,
    stockStatus: nextStockStatus,
  };
}

function buildCencosudProductFromLiveEntry(cfg, entry) {
  const unitMetrics = enrichUnitMetrics({
    price: entry.price,
    storeUnit: entry.storeUnit,
    storeMultiplier: entry.storeMultiplier,
    name: entry.name,
    description: "",
  });
  const effectiveUnitPrice =
    entry.bundlePricePerItem && unitMetrics.baseAmount > 0
      ? Math.round(entry.bundlePricePerItem / unitMetrics.baseAmount)
      : unitMetrics.unitPrice;
  const rawUrl = entry.slug ? `${cfg.siteBaseUrl}/${entry.slug}/p` : cfg.siteBaseUrl;
  const nutFields = resolveBrandAndNutrition(entry.name, entry.brand, unitMetrics, entry.price);

  return {
    store: cfg.storeId,
    storeName: STORES[cfg.storeId].name,
    externalId: String(entry.skuId),
    sku: String(entry.reference || entry.skuId),
    name: String(entry.name).trim(),
    price: entry.price,
    listPrice: entry.listPrice ?? null,
    memberPrice: entry.memberPrice ?? null,
    promoText: entry.promoText || (entry.listPrice ? "Oferta" : null),
    bundlePricePerItem: entry.bundlePricePerItem ?? null,
    unit: unitMetrics.unit,
    unitPrice: unitMetrics.unitPrice,
    effectiveUnitPrice,
    baseAmount: unitMetrics.baseAmount,
    formatLabel: unitMetrics.formatLabel,
    pricePer100: unitMetrics.pricePer100,
    per100UnitName: unitMetrics.per100UnitName,
    pricePerSmallUnit: unitMetrics.pricePerSmallUnit,
    smallUnitName: unitMetrics.smallUnitName,
    ...nutFields,
    imageUrl: entry.imageUrl || "",
    url: normalizeProductUrl(rawUrl, cfg.storeId),
    inStock: entry.inStock,
    stockStatus: entry.stockStatus,
    storeZone: "",
    availableStores: [],
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchCencosudLiveSearch(cfg, query) {
  try {
    const searchUrl = `${cfg.siteBaseUrl}/busca?ft=${encodeURIComponent(query)}`;
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-CL,es;q=0.9",
      },
      signal: AbortSignal.timeout(5500),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return extractCencosudFlightEntries(html);
  } catch {
    return [];
  }
}

export async function searchCencosud(storeId, query, limit = 18, options = {}) {
  const cfg = CENCOSUD_CONFIGS[storeId];
  if (!cfg) throw new Error(`Banner Cencosud desconocido: ${storeId}`);

  const params = new URLSearchParams({
    key: cfg.key,
    i: CLIENT_ID,
    s: "1",
    c: CIO_VERSION,
    page: "1",
    num_results_per_page: String(Math.min(limit, 40)),
    _dt: String(Date.now()),
  });

  const hasJumboStoreFilter = Boolean(storeId === "jumbo" && options.jumboStore);
  if (hasJumboStoreFilter) {
    params.append("filters[SellerVSS]", String(options.jumboStore).trim());
  }

  const cnUrl = `https://${cfg.host}/search/${encodeURIComponent(query)}?${params.toString()}`;
  const [cnRes, liveEntries] = await Promise.all([
    fetch(cnUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        "Accept-Language": "es-CL,es;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    }).catch((err) => ({ ok: false, _err: err })),
    fetchCencosudLiveSearch(cfg, query),
  ]);

  if (!cnRes.ok && liveEntries.length === 0) {
    throw new Error(
      cnRes._err ? cnRes._err.message : `${STORES[storeId].name} HTTP ${cnRes.status}`
    );
  }

  let mapped = [];
  if (cnRes.ok) {
    const json = await cnRes.json();
    const results = json?.response?.results ?? [];
    mapped = results
      .map((r) => mapCencosudItem(cfg, r, options.jumboStore || ""))
      .filter(Boolean);
  }

  if (liveEntries.length > 0) {
    const liveBySkuId = new Map();
    const liveByRef = new Map();
    for (const le of liveEntries) {
      if (le.skuId) liveBySkuId.set(le.skuId, le);
      if (le.reference) liveByRef.set(le.reference, le);
    }

    const seenIds = new Set();
    mapped = mapped.map((prod) => {
      seenIds.add(prod.externalId);
      const liveMatch = liveBySkuId.get(prod.externalId) || liveByRef.get(prod.sku);
      return liveMatch
        ? applyCencosudLiveOffer(prod, liveMatch, { preserveStoreStock: hasJumboStoreFilter })
        : prod;
    });

    if (!hasJumboStoreFilter) {
      for (const le of liveEntries) {
        if (mapped.length >= limit) break;
        if (seenIds.has(le.skuId)) continue;
        seenIds.add(le.skuId);
        mapped.push(buildCencosudProductFromLiveEntry(cfg, le));
      }
    }
  }

  return options.includeOutOfStock === false
    ? mapped.filter((item) => item.inStock)
    : mapped;
}

function mapCencosudItem(cfg, result, selectedStoreCode = "") {
  const data = result?.data;
  const name = result?.value ?? data?.ProductName;
  if (!data || !name || !data.id) return null;

  const price = toClp(data.sellingPrice) ?? toClp(data.price);
  if (!price) return null;

  let listPrice = toClp(data.listPrice) ?? toClp(data.originalPrice);
  if (listPrice !== undefined && listPrice <= price) listPrice = undefined;

  const inStock =
    data.stockLevel !== undefined
      ? data.stockLevel === "in-stock"
      : data.outOfStock !== true;
  const stockStatus = inStock ? "in_stock" : "out_of_stock";
  const availableStores = Array.isArray(data.SellerVSS) ? data.SellerVSS : [];
  const storeZone = selectedStoreCode || (data.storeId ? String(data.storeId) : "");

  const sku = parseCencosudSkuData(data);
  const storeUnit = sku?.measurement_unit_un
    ? normalizeUnit(sku.measurement_unit_un)
    : undefined;
  const storeMultiplier =
    typeof sku?.unit_multiplier_un === "number" ? sku.unit_multiplier_un : undefined;

  const unitMetrics = enrichUnitMetrics({
    price,
    storeUnit,
    storeMultiplier,
    name,
    description: "",
  });

  const promoName =
    sku?.promotionData?.promotionName ||
    sku?.promotionData?.promotionShortDescription ||
    undefined;

  const bundle = promoName ? parseBundle(promoName) : undefined;
  const effectiveUnitPrice =
    bundle?.unitPriceInBundle && unitMetrics.baseAmount > 0
      ? Math.round(bundle.unitPriceInBundle / unitMetrics.baseAmount)
      : unitMetrics.unitPrice;

  const rawUrl = data.DetailUrl ? `${cfg.siteBaseUrl}${data.DetailUrl}` : data.url || cfg.siteBaseUrl;
  const productUrl = normalizeProductUrl(rawUrl, cfg.storeId);

  const nutFields = resolveBrandAndNutrition(name, data.BrandName, unitMetrics, price);

  return {
    store: cfg.storeId,
    storeName: STORES[cfg.storeId].name,
    externalId: String(data.id),
    sku: data.ProductRefId ? String(data.ProductRefId) : String(data.id),
    name: String(name).trim(),
    price,
    listPrice: listPrice ?? null,
    memberPrice: null,
    promoText: promoName || (listPrice ? "Oferta" : null),
    bundlePricePerItem: bundle?.unitPriceInBundle ?? null,
    unit: unitMetrics.unit,
    unitPrice: unitMetrics.unitPrice,
    effectiveUnitPrice,
    baseAmount: unitMetrics.baseAmount,
    formatLabel: unitMetrics.formatLabel,
    pricePer100: unitMetrics.pricePer100,
    per100UnitName: unitMetrics.per100UnitName,
    pricePerSmallUnit: unitMetrics.pricePerSmallUnit,
    smallUnitName: unitMetrics.smallUnitName,
    ...nutFields,
    imageUrl: data.image_url || "",
    url: productUrl,
    inStock,
    stockStatus,
    storeZone,
    availableStores,
    fetchedAt: new Date().toISOString(),
  };
}

// --- 2. Adaptador Unimarc (BFF Ecommerce VTEX) ---

export async function searchUnimarc(query, limit = 18, options = {}) {
  const res = await fetch(
    "https://bff-unimarc-ecommerce.unimarc.cl/catalog/product/search",
    {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        "Content-Type": "application/json",
        channel: "UNIMARC",
        source: "web",
        version: "1.0.0",
      },
      body: JSON.stringify({
        from: "0",
        to: String(Math.min(limit, 40) - 1),
        searching: query,
        promotionsOnly: false,
        orderBy: "",
        userTriggered: true,
      }),
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!res.ok) {
    throw new Error(`Unimarc HTTP ${res.status}`);
  }

  const json = await res.json();
  const avail = (json?.availableProducts ?? []).map((p) => mapUnimarcItem(p, true)).filter(Boolean);
  if (options.includeOutOfStock === false) {
    return avail.filter((i) => i.inStock);
  }
  const notAvail = (json?.notAvailableProducts ?? [])
    .map((p) => mapUnimarcItem(p, false))
    .filter(Boolean);
  return [...avail, ...notAvail];
}

function mapUnimarcItem(p, isAvailableList = true) {
  const item = p?.item;
  const priceInfo = p?.price;
  if (!item?.name || !item?.sku || !priceInfo) return null;

  const price = parseClpString(priceInfo.price);
  if (!price) return null;

  let listPrice = parseClpString(priceInfo.listPrice);
  if (listPrice !== undefined && listPrice <= price) listPrice = undefined;

  const ppu = parseUnitPriceString(priceInfo.ppum);
  const tag = p?.priceDetail?.promotionalTag?.text
    ? String(p.priceDetail.promotionalTag.text).trim()
    : null;
  const isClub = Boolean(tag && /club/i.test(tag));
  const memberPrice = isClub ? price : null;

  const promo = p?.promotion;
  const pdPromoMsg =
    p?.priceDetail?.promotionType === "mx$" && p?.priceDetail?.discountPrice
      ? String(p.priceDetail.discountPrice).trim()
      : null;
  const promoDesc =
    promo?.hasSavings && promo?.descriptionMessage
      ? promo.descriptionMessage
      : pdPromoMsg || tag || (listPrice ? "Oferta" : null);

  const bundle = promoDesc ? parseBundle(promoDesc) : undefined;
  const rawPromoUnit =
    promo?.hasSavings && Number(promo?.price) > 0 ? Math.round(Number(promo.price)) : null;
  const bundleUnitPrice =
    (rawPromoUnit && rawPromoUnit < price ? rawPromoUnit : null) ??
    (bundle?.unitPriceInBundle && bundle.unitPriceInBundle < price
      ? bundle.unitPriceInBundle
      : null);

  const unitMetrics = enrichUnitMetrics({
    price,
    storeUnitPrice: ppu?.unitPrice,
    storeUnit: ppu?.unit,
    name: item.name,
    description: item.description || item.netContent || "",
  });

  const effectiveUnitPrice =
    bundleUnitPrice && unitMetrics.baseAmount > 0
      ? Math.round(bundleUnitPrice / unitMetrics.baseAmount)
      : unitMetrics.unitPrice;

  const rawUrl = item.slug
    ? `https://www.unimarc.cl/product${item.slug.startsWith("/") ? item.slug : "/" + item.slug}`
    : "https://www.unimarc.cl";
  const productUrl = normalizeProductUrl(rawUrl, "unimarc");

  const nutFields = resolveBrandAndNutrition(item.name, item.brand, unitMetrics, price);

  const qtyAvail = priceInfo.availableQuantity;
  const hasStockQty = qtyAvail === undefined || qtyAvail === null || Number(qtyAvail) > 0;
  const inStock = Boolean(isAvailableList && hasStockQty);

  return {
    store: "unimarc",
    storeName: "Unimarc",
    externalId: String(item.sku),
    sku: String(item.sku),
    ean: item.ean || null,
    name: String(item.name).trim(),
    price,
    listPrice: listPrice ?? null,
    memberPrice,
    promoText: promoDesc,
    bundlePricePerItem: bundleUnitPrice,
    unit: unitMetrics.unit,
    unitPrice: unitMetrics.unitPrice,
    effectiveUnitPrice,
    baseAmount: unitMetrics.baseAmount,
    formatLabel: unitMetrics.formatLabel,
    pricePer100: unitMetrics.pricePer100,
    per100UnitName: unitMetrics.per100UnitName,
    pricePerSmallUnit: unitMetrics.pricePerSmallUnit,
    smallUnitName: unitMetrics.smallUnitName,
    ...nutFields,
    imageUrl: item.images?.[0] || "",
    url: productUrl,
    inStock,
    stockStatus: inStock ? "in_stock" : "out_of_stock",
    storeZone: "",
    fetchedAt: new Date().toISOString(),
  };
}

// --- 3. Adaptador Tottus (Falabella Browse Search JSON API) ---

export async function searchTottus(query, limit = 18) {
  const url = `https://www.tottus.cl/s/browse/v1/search/cl?Ntt=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "es-CL,es;q=0.9",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Tottus HTTP ${res.status}`);
  }

  const json = await res.json();
  const results = json?.data?.results ?? [];
  return results.slice(0, limit).map(mapTottusItem).filter(Boolean);
}

function mapTottusItem(p) {
  if (!p?.displayName || !(p.skuId || p.productId)) return null;

  const prices = Array.isArray(p.prices) ? p.prices : [];
  const internet = prices.find((x) => x.type === "internetPrice");
  const cmr = prices.find((x) => x.type === "cmrPrice");
  const normal = prices.find((x) => x.type === "normalPrice" || x.crossed);

  const price =
    parseClpString(internet?.price?.[0]) ??
    parseClpString(prices[0]?.price?.[0]);
  if (!price) return null;

  let listPrice = parseClpString(normal?.price?.[0]);
  if (listPrice !== undefined && listPrice <= price) listPrice = undefined;

  const memberPrice = parseClpString(cmr?.price?.[0]) ?? null;

  const pumPrice =
    parseClpString(internet?.pum?.price?.[0]) ??
    parseClpString(cmr?.pum?.price?.[0]);
  const pumUnit = internet?.pum?.label
    ? normalizeUnit(internet.pum.label)
    : undefined;

  const formatStr = p.measurements?.format || "";
  const unitMetrics = enrichUnitMetrics({
    price,
    storeUnitPrice: pumPrice,
    storeUnit: pumUnit,
    name: p.displayName,
    description: formatStr,
  });

  let bundlePromo = null;
  for (const b of p.multipurposeBadges ?? []) {
    if (b?.label) {
      const parsed = parseBundle(b.label);
      if (parsed && parsed.type === "bundle") {
        bundlePromo = parsed;
        break;
      }
    }
  }

  const promoText =
    bundlePromo?.description ||
    p.discountBadge?.label ||
    (listPrice ? "Oferta" : null);

  const effectiveUnitPrice =
    bundlePromo?.unitPriceInBundle && unitMetrics.baseAmount > 0
      ? Math.round(bundlePromo.unitPriceInBundle / unitMetrics.baseAmount)
      : unitMetrics.unitPrice;

  const nutFields = resolveBrandAndNutrition(p.displayName, p.brand, unitMetrics, price);

  const availObj = p.availability || {};
  const hasZoneAvailability = Boolean(
    availObj.homeDeliveryShipping ||
      availObj.pickUpFromStoreShipping ||
      availObj.expressShipping ||
      availObj.primeShipping
  );
  const badgeText = JSON.stringify(p.multipurposeBadges || []);
  const explicitOut =
    p.isOutOfStock === true ||
    p.sellable === false ||
    /agotad|sin stock/i.test(badgeText);

  const inStock = !explicitOut;
  const stockStatus = explicitOut ? "out_of_stock" : "in_stock";

  return {
    store: "tottus",
    storeName: "Tottus",
    externalId: String(p.skuId ?? p.productId),
    sku: String(p.productId ?? p.skuId),
    name: String(p.displayName).trim(),
    price,
    listPrice: listPrice ?? null,
    memberPrice,
    promoText,
    bundlePricePerItem: bundlePromo?.unitPriceInBundle ?? null,
    unit: unitMetrics.unit,
    unitPrice: unitMetrics.unitPrice,
    effectiveUnitPrice,
    baseAmount: unitMetrics.baseAmount,
    formatLabel: unitMetrics.formatLabel,
    pricePer100: unitMetrics.pricePer100,
    per100UnitName: unitMetrics.per100UnitName,
    pricePerSmallUnit: unitMetrics.pricePerSmallUnit,
    smallUnitName: unitMetrics.smallUnitName,
    ...nutFields,
    imageUrl: p.mediaUrls?.[0] || "",
    url: p.url || "https://www.tottus.cl",
    inStock,
    stockStatus,
    storeZone: "",
    fetchedAt: new Date().toISOString(),
  };
}

// --- 4. Adaptador Lider (Parser de __NEXT_DATA__ + detección de bloqueo Antibot) ---

const NEXT_DATA_REGEX = /<script[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;
const LD_JSON_REGEX = /<script[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractLiderPrice(val) {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "number") return toClp(val);
  if (typeof val === "string") return parseClpString(val);
  if (typeof val === "object") {
    return (
      toClp(val.price) ??
      parseClpString(val.priceString) ??
      parseClpString(val.priceDisplay) ??
      parseClpString(val.string) ??
      parseClpString(val.value)
    );
  }
  return undefined;
}

function collectLiderProductsInTree(node, out = [], seen = new Set(), depth = 0) {
  if (depth > 25 || !node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) {
      collectLiderProductsInTree(child, out, seen, depth + 1);
    }
    return out;
  }

  const rawId = node.usItemId ?? node.id ?? node.code;
  if (rawId && node.name && (node.priceInfo || node.price || node.offers)) {
    const key = String(rawId);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(node);
    }
  }

  for (const key of Object.keys(node)) {
    collectLiderProductsInTree(node[key], out, seen, depth + 1);
  }
  return out;
}

function buildNormalizedLiderProduct({
  id,
  name,
  brand = "",
  price,
  listPrice = null,
  memberPrice = null,
  ppu = null,
  description = "",
  promoText = null,
  bundlePricePerItem = null,
  imageUrl = "",
  url = "https://www.lider.cl",
  inStock = true,
}) {
  const unitMetrics = enrichUnitMetrics({
    price,
    storeUnitPrice: ppu?.unitPrice,
    storeUnit: ppu?.unit,
    name,
    description,
  });

  const nutFields = resolveBrandAndNutrition(
    name,
    brand,
    unitMetrics,
    price,
    `${description || ""} ${promoText || ""}`
  );
  const effectiveUnitPrice =
    bundlePricePerItem && unitMetrics.baseAmount > 0
      ? Math.round(bundlePricePerItem / unitMetrics.baseAmount)
      : unitMetrics.unitPrice;

  return {
    store: "lider",
    storeName: "Lider",
    externalId: String(id),
    sku: String(id),
    name: String(name).trim(),
    price,
    listPrice: listPrice ?? null,
    memberPrice: memberPrice ?? null,
    promoText: promoText || (listPrice ? "Rollback / Oferta" : null),
    bundlePricePerItem,
    unit: unitMetrics.unit,
    unitPrice: unitMetrics.unitPrice,
    effectiveUnitPrice,
    baseAmount: unitMetrics.baseAmount,
    formatLabel: unitMetrics.formatLabel,
    pricePer100: unitMetrics.pricePer100,
    per100UnitName: unitMetrics.per100UnitName,
    pricePerSmallUnit: unitMetrics.pricePerSmallUnit,
    smallUnitName: unitMetrics.smallUnitName,
    ...nutFields,
    imageUrl: imageUrl || "",
    url,
    inStock,
    fetchedAt: new Date().toISOString(),
  };
}

function collectLdJsonProducts(node, out = [], pageUrl = "") {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectLdJsonProducts(child, out, pageUrl);
    return out;
  }
  const typeVal = node["@type"];
  const isProduct =
    typeVal === "Product" ||
    (Array.isArray(typeVal) && typeVal.includes("Product"));
  if (isProduct && node.name && node.offers) {
    const offersObj = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    const price = extractLiderPrice(offersObj?.price ?? offersObj?.lowPrice);
    if (price) {
      const id = node.sku || node.productID || node.gtin13 || `ld-${Date.now()}`;
      const brand = typeof node.brand === "object" ? node.brand?.name : node.brand;
      const imageUrl = Array.isArray(node.image) ? node.image[0] : node.image;
      out.push(
        buildNormalizedLiderProduct({
          id,
          name: node.name,
          brand: brand || "",
          price,
          description: node.description || "",
          imageUrl: typeof imageUrl === "string" ? imageUrl : "",
          url: node.url || pageUrl || "https://www.lider.cl",
        })
      );
    }
  }
  if (node["@graph"]) {
    collectLdJsonProducts(node["@graph"], out, pageUrl);
  }
  return out;
}

export function parseLiderRawInput(rawText, pageUrl = "") {
  if (!rawText || typeof rawText !== "string") return [];
  let jsonStr = rawText.trim();
  const match = NEXT_DATA_REGEX.exec(jsonStr);
  if (match) {
    jsonStr = match[1];
  }

  let mapped = [];
  try {
    const data = JSON.parse(jsonStr);
    const arr = collectLiderProductsInTree(data);
    mapped = arr.map((p) => mapLiderItem(p, pageUrl)).filter(Boolean);
  } catch {
    mapped = [];
  }

  // Fallback 1: JSON-LD (<script type="application/ld+json">) cuando SPA no actualizó __NEXT_DATA__
  if (mapped.length === 0) {
    const ldMatches = rawText.matchAll(LD_JSON_REGEX);
    for (const m of ldMatches) {
      try {
        const parsedLd = JSON.parse(m[1]);
        collectLdJsonProducts(parsedLd, mapped, pageUrl);
      } catch {}
    }
  }

  // Fallback 2: URL de ficha /ip/<slug>/<id> + HTML visible con <h1> y precio CLP
  const ipMatch = String(pageUrl || "").match(/\/ip\/(?:([^/?#]+)\/)?(\d{6,20})/i);
  if (mapped.length === 0 && ipMatch) {
    const slugName = ipMatch[1] ? decodeURIComponent(ipMatch[1]).replace(/-/g, " ") : "Producto Lider";
    const id = ipMatch[2];
    const h1Match = rawText.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const titleFromHtml = h1Match ? h1Match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
    const sliceFromTitle = h1Match ? rawText.slice(h1Match.index) : rawText;
    const priceMatch =
      sliceFromTitle.match(/\$\s*([\d.]{3,7})/) || rawText.match(/\$\s*([\d.]{3,7})/);
    const price = priceMatch ? parseClpString(priceMatch[1]) : undefined;
    if (price) {
      mapped.push(
        buildNormalizedLiderProduct({
          id,
          name: titleFromHtml || slugName,
          price,
          url: pageUrl,
        })
      );
    }
  }

  // Si estamos en una URL /ip/.../<id>, priorizar el producto exacto de esa URL al inicio
  if (ipMatch && mapped.length > 1) {
    const urlItemId = ipMatch[2];
    const normUrlId = urlItemId.replace(/^0+/, "");
    const exactIdx = mapped.findIndex((p) => {
      const ext = String(p.externalId || "").replace(/^0+/, "");
      const sku = String(p.sku || "").replace(/^0+/, "");
      return (
        p.externalId === urlItemId ||
        p.sku === urlItemId ||
        (normUrlId && (ext === normUrlId || sku === normUrlId))
      );
    });
    if (exactIdx > 0) {
      const [exact] = mapped.splice(exactIdx, 1);
      mapped.unshift(exact);
    }
  }

  // Fallback 3: Bloques de carrito pegados en Markdown o DOM de lider.cl/cart
  if (mapped.length === 0 && /lider\.cl\/ip\//i.test(rawText)) {
    const linkRe = /###\s+([^\n\]]+)[\s\S]{0,120}?\((https:\/\/www\.lider\.cl\/ip\/[^\s)]+)\)/g;
    const matches = [...rawText.matchAll(linkRe)];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const name = m[1].replace(/\s+/g, " ").trim();
      const prodUrl = m[2].trim();
      const idMatch = prodUrl.match(/\/(\d{6,20})(?:$|\?)/);
      const id = idMatch ? idMatch[1] : `cart-${i}`;
      const blockStart = m.index + m[0].length;
      const blockEnd = i + 1 < matches.length ? matches[i + 1].index : Math.min(rawText.length, blockStart + 350);
      const tail = rawText.slice(blockStart, blockEnd);
      const prevChunk = rawText.slice(Math.max(0, m.index - 120), m.index);

      const prices = [...tail.matchAll(/\$\s*([\d.]+)/g)].map((p) => parseClpString(p[1])).filter(Boolean);
      const lineTotal = prices[0];
      const unitExplicit = tail.match(/\$\s*([\d.]+)\s*un\b/i);
      const costabaMatch = tail.match(/Costaba\s*\$\s*([\d.]+)\s*(un)?/i);
      const bundleMatch = prevChunk.match(/(\d+)\s*x\s*\$\s*([\d.]+)/i) || tail.match(/(\d+)\s*x\s*\$\s*([\d.]+)/i);
      const qtyLines = tail
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^\d{1,2}$/.test(l));
      const qty = qtyLines.length > 0 ? Math.max(1, Number(qtyLines[qtyLines.length - 1])) : 1;

      if (lineTotal) {
        const unitPricePkg = unitExplicit
          ? parseClpString(unitExplicit[1])
          : Math.round(lineTotal / qty);
        const listPrice = costabaMatch ? parseClpString(costabaMatch[1]) : undefined;
        const bundleParsed = bundleMatch ? parseBundle(`${bundleMatch[1]} x $${bundleMatch[2]}`) : null;
        const prod = buildNormalizedLiderProduct({
          id,
          name,
          price: unitPricePkg,
          listPrice,
          promoText: bundleParsed?.description || null,
          bundlePricePerItem: bundleParsed?.unitPriceInBundle ?? null,
          url: prodUrl,
        });
        prod.cartQuantity = qty;
        mapped.push(prod);
      }
    }
  }

  return mapped;
}

export function detectStoreFromUrl(rawUrl = "") {
  const u = String(rawUrl || "").toLowerCase();
  if (u.includes("tottus.cl") || u.includes("falabella.com")) return "tottus";
  if (u.includes("jumbo.cl")) return "jumbo";
  if (u.includes("santaisabel.cl") || u.includes("sisa.cl")) return "santaisabel";
  if (u.includes("unimarc.cl")) return "unimarc";
  return "lider";
}

export function buildNormalizedBrowserProduct({
  store = "lider",
  id,
  name,
  brand = "",
  price,
  listPrice,
  memberPrice = null,
  ppu = null,
  description = "",
  promoText = null,
  bundlePricePerItem = null,
  imageUrl = "",
  url = "",
  inStock = true,
  stockStatus = null,
  storeZone = "",
}) {
  const baseProd = buildNormalizedLiderProduct({
    id,
    name,
    brand,
    price,
    listPrice,
    memberPrice,
    ppu,
    description,
    promoText,
    bundlePricePerItem,
    imageUrl,
    url: url || (STORES[store]?.domain ? `https://www.${STORES[store].domain}` : "https://www.lider.cl"),
    inStock,
  });
  return {
    ...baseProd,
    store,
    storeName: STORES[store]?.name || store,
    url: normalizeProductUrl(url || baseProd.url, store),
    inStock: Boolean(inStock),
    stockStatus: stockStatus || (inStock ? "in_stock" : "out_of_stock"),
    storeZone: String(storeZone || "").trim(),
  };
}

export function parseStoreBrowserPayload({
  rawContent = "",
  cartItems = [],
  browserItems = [],
  url = "",
  storeZone = "",
}) {
  const defaultStore = detectStoreFromUrl(url);
  const itemsList =
    Array.isArray(browserItems) && browserItems.length > 0 ? browserItems : cartItems;

  if (Array.isArray(itemsList) && itemsList.length > 0) {
    const out = [];
    for (const ci of itemsList) {
      if (!ci?.name) continue;
      const qty = Math.max(1, Number(ci.qty) || 1);
      const rawLine = parseClpString(ci.linePrice);
      const rawUnit = parseClpString(ci.unitPrice) ?? parseClpString(ci.price);
      const pkgPrice = rawUnit || (rawLine ? Math.round(rawLine / qty) : undefined);
      const itemStore = ci.store || detectStoreFromUrl(ci.url || url) || defaultStore;
      const prodUrl = ci.url || url || `https://www.${STORES[itemStore]?.domain || "lider.cl"}`;
      const idMatch = String(prodUrl).match(/\/(\d{6,20})(?:$|\?|\/)/);
      const id = ci.externalId || (idMatch ? idMatch[1] : `${itemStore}-web-${Date.now()}-${out.length}`);
      const isAvail = ci.inStock !== false;
      // Si está agotado y no tiene precio en página, permitir guardar registro con 0 para marcar agotado si trae SKU/URL
      if (!pkgPrice && isAvail) continue;
      const bundleParsed = ci.promoText ? parseBundle(ci.promoText) : null;
      const prod = buildNormalizedBrowserProduct({
        store: itemStore,
        id,
        name: ci.name,
        brand: ci.brand || "",
        price: pkgPrice || 1,
        listPrice: parseClpString(ci.listPrice),
        promoText: bundleParsed?.description || ci.promoText || null,
        bundlePricePerItem: bundleParsed?.unitPriceInBundle ?? null,
        imageUrl: ci.imageUrl || "",
        url: prodUrl,
        inStock: isAvail,
        stockStatus: ci.stockStatus || (isAvail ? "in_stock" : "out_of_stock"),
        storeZone: ci.storeZone || storeZone || "",
      });
      if (!pkgPrice && !isAvail) prod.priceMissingBecauseOutOfStock = true;
      if (ci.fromCart) prod.cartQuantity = qty;
      out.push(prod);
    }
    if (out.length > 0) return out;
  }

  // Fallback para PDP/HTML de Tottus u otras tiendas con __NEXT_DATA__
  if (defaultStore === "tottus" && rawContent) {
    const outText = String(rawContent);
    const isOutDom = /justo se agot[oó]|producto agotado|sin stock disponible/i.test(outText);
    const nextMatch = outText.match(NEXT_DATA_REGEX);
    if (nextMatch) {
      try {
        const nd = JSON.parse(nextMatch[1]);
        const pd = nd?.props?.pageProps?.productData;
        if (pd?.displayName || pd?.name) {
          const pName = pd.displayName || pd.name;
          const v0 = pd.variants?.[0] || {};
          const priceArr = v0.prices || pd.prices || [];
          const pVal =
            parseClpString(priceArr.find((x) => x.type === "internetPrice")?.price?.[0]) ??
            parseClpString(priceArr[0]?.price?.[0]) ??
            1;
          const isAvail = !(isOutDom || pd.isOutOfStock === true || v0.isOutOfStock === true);
          return [
            buildNormalizedBrowserProduct({
              store: "tottus",
              id: v0.id || pd.id || pd.productId || "tottus-pdp",
              name: pName,
              brand: pd.brandName || pd.brand || "",
              price: pVal,
              url,
              inStock: isAvail,
              stockStatus: isAvail ? "in_stock" : "out_of_stock",
              storeZone,
            }),
          ];
        }
      } catch {}
    }
  }

  const parsedLider = parseLiderRawInput(rawContent, url);
  return parsedLider.map((p) => ({
    ...p,
    stockStatus: p.inStock === false ? "out_of_stock" : "in_stock",
    storeZone: storeZone || p.storeZone || "",
  }));
}

export function parseLiderCartPayload({ rawContent = "", cartItems = [], browserItems = [], url = "", storeZone = "" }) {
  const mappedCart = Array.isArray(cartItems)
    ? cartItems.map((c) => ({ ...c, fromCart: true }))
    : [];
  return parseStoreBrowserPayload({
    rawContent,
    cartItems: mappedCart,
    browserItems,
    url,
    storeZone,
  });
}

function mapLiderItem(p, pageUrl = "") {
  const id = p?.usItemId ?? p?.id ?? p?.code;
  if (!id || !p?.name) return null;

  const info = p.priceInfo || {};
  const price =
    extractLiderPrice(info.currentPrice) ??
    extractLiderPrice(info.linePrice) ??
    extractLiderPrice(info.itemPrice) ??
    extractLiderPrice(info.price) ??
    extractLiderPrice(p.price) ??
    extractLiderPrice(p.offers);
  if (!price) return null;

  let listPrice =
    extractLiderPrice(info.wasPrice) ?? extractLiderPrice(info.comparisonPrice);
  if (listPrice !== undefined && listPrice <= price) listPrice = undefined;

  const memberPrice =
    extractLiderPrice(info.memberPrice) ?? parseClpString(info.memberPriceString) ?? null;

  const unitPriceRaw =
    typeof info.unitPrice === "string"
      ? info.unitPrice
      : info.unitPrice?.priceString || info.unitPrice?.string || "";
  const ppu = parseUnitPriceString(unitPriceRaw);

  let bundlePromo = null;
  for (const f of p.badges?.flags ?? []) {
    if (f?.text && f.type !== "ICON") {
      const parsed = parseBundle(f.text);
      if (parsed && parsed.type === "bundle") {
        bundlePromo = parsed;
        break;
      }
    }
  }

  let url = pageUrl || "https://www.lider.cl";
  if (p.canonicalUrl) {
    url = String(p.canonicalUrl).startsWith("http")
      ? p.canonicalUrl
      : `https://www.lider.cl${String(p.canonicalUrl).startsWith("/") ? "" : "/"}${p.canonicalUrl}`;
  }

  return buildNormalizedLiderProduct({
    id,
    name: p.name,
    brand: p.brand || "",
    price,
    listPrice,
    memberPrice,
    ppu,
    description: p.shortDescription || "",
    promoText: bundlePromo?.description || (listPrice ? "Rollback / Oferta" : null),
    bundlePricePerItem: bundlePromo?.unitPriceInBundle ?? null,
    imageUrl: p.imageInfo?.thumbnailUrl || p.imageInfo?.allImages?.[0]?.url || "",
    url,
    inStock: p.availabilityStatus ? p.availabilityStatus === "IN_STOCK" : true,
  });
}

export async function searchLider(query, limit = 18) {
  const url = `https://super.lider.cl/search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-CL,es;q=0.9",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });

  if (res.status === 412 || res.status === 403 || res.status === 307 || res.status === 302) {
    throw new Error(
      `Protegido por antibot PerimeterX/Queue-It (HTTP ${res.status}). Puedes importar datos desde tu navegador o registrar manualmente.`
    );
  }

  const html = await res.text();
  if (html.includes("Robot or human") || !NEXT_DATA_REGEX.test(html)) {
    throw new Error(
      "Lider solicitó desafío antibot (PerimeterX). Usa el botón 'Importar Lider' si deseas cargarlo desde tu navegador."
    );
  }

  return parseLiderRawInput(html).slice(0, limit);
}

// --- 5. Orquestador de Búsqueda Multi-Supermercado ---

export async function searchAllStores(query, options = {}) {
  const {
    stores = ["jumbo", "santaisabel", "unimarc", "tottus"],
    limitPerStore = 15,
    minRelevance = 0.45,
    verifyLinks = true,
    jumboStore = "",
    includeOutOfStock = true,
  } = options;

  const translatedQuery = buildCrossStoreSearchQuery(query);
  const apiQuery = translatedQuery || query;

  const adapters = {
    jumbo: (q) => searchCencosud("jumbo", q, limitPerStore, { jumboStore, includeOutOfStock }),
    santaisabel: (q) => searchCencosud("santaisabel", q, limitPerStore, { includeOutOfStock }),
    unimarc: (q) => searchUnimarc(q, limitPerStore, { includeOutOfStock }),
    tottus: (q) => searchTottus(q, limitPerStore),
    lider: (q) => searchLider(q, limitPerStore),
  };

  const storeStatus = {};
  const allProducts = [];
  const discoveredJumboSet = new Set();

  await Promise.all(
    stores.map(async (storeId) => {
      const fn = adapters[storeId];
      if (!fn) return;
      const t0 = Date.now();
      try {
        let items = await fn(apiQuery);
        if (items.length === 0) {
          const relaxedQuery = apiQuery
            .replace(/\b\d+(?:[.,]\d+)?\s*(?:g|gr|grs|ml|cc|kg|lts|lt|l|un|und)\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (relaxedQuery && relaxedQuery !== apiQuery && relaxedQuery.length >= 4) {
            items = await fn(relaxedQuery);
          }
        }
        const enriched = items.map((item) => {
          if (item.store === "jumbo" && Array.isArray(item.availableStores)) {
            for (const sv of item.availableStores) {
              if (sv && String(sv).trim()) discoveredJumboSet.add(String(sv).trim());
            }
          }
          const purity = checkProductPurity(query, item.name, item.brand);
          const candText = `${item.name} ${item.brand || ""} ${item.formatLabel || ""}`;
          const relRaw = matchScore(query, candText);
          const relTrans = apiQuery !== query ? matchScore(apiQuery, candText) : relRaw;
          return {
            ...item,
            isPure: purity.isPure,
            isBlend: purity.isBlend,
            purityWarning: purity.purityWarning,
            relevance: Math.max(relRaw, relTrans),
          };
        });
        const scored = enriched.filter((item) => item.relevance >= minRelevance);

        // Fallback seguro: nunca inyectar productos impuros (ej. Maravilla cuando se busca Canola)
        const pureFallback = enriched
          .filter((i) => options.allowImpureFallback === true || i.isPure !== false)
          .slice(0, 5)
          .map((i) => ({ ...i, relevance: Math.max(0.4, i.relevance || 0) }));

        let finalItems = scored.length > 0 ? scored : pureFallback;

        // Verificar que los links de Jumbo, Santa Isabel y Unimarc existan realmente (sin 404 fantasma)
        if (verifyLinks && ["jumbo", "santaisabel", "unimarc"].includes(storeId) && finalItems.length > 0) {
          finalItems.sort(
            (a, b) =>
              (a.inStock === false ? 1 : 0) - (b.inStock === false ? 1 : 0) ||
              a.unitPrice - b.unitPrice
          );
          const toVerify = finalItems.slice(0, 12);
          await Promise.all(
            toVerify.map(async (p) => {
              const chk = await verifyProductUrl(p.url, p.store);
              p.linkStatus = chk.status;
              p.linkHttpStatus = chk.httpStatus;
              p.lastVerifiedAt = chk.verifiedAt || new Date().toISOString();
              p.priceVerified = true;
              if (chk.url) p.url = chk.url;
              if (chk.liveOffer && (storeId === "santaisabel" || storeId === "jumbo")) {
                const updated = applyCencosudLiveOffer(p, chk.liveOffer, {
                  preserveStoreStock: storeId === "jumbo" && Boolean(jumboStore),
                });
                Object.assign(p, updated);
              }
            })
          );
          if (!options.keepBrokenLinks) {
            finalItems = finalItems.filter((p) => p.linkStatus !== "broken");
          }
        } else {
          const nowIso = new Date().toISOString();
          for (const p of finalItems) {
            if (!p.linkStatus) p.linkStatus = storeId === "tottus" || storeId === "lider" ? "protected" : "unknown";
            if (!p.lastVerifiedAt) p.lastVerifiedAt = nowIso;
            if (p.priceVerified === undefined) p.priceVerified = storeId !== "lider";
          }
        }

        allProducts.push(...finalItems);
        storeStatus[storeId] = {
          ok: true,
          count: finalItems.length,
          inStockCount: finalItems.filter((p) => p.inStock !== false).length,
          outOfStockCount: finalItems.filter((p) => p.inStock === false).length,
          ms: Date.now() - t0,
        };
      } catch (err) {
        storeStatus[storeId] = {
          ok: false,
          count: 0,
          error: err.message,
          ms: Date.now() - t0,
        };
      }
    })
  );

  const getStockTier = (p) => {
    if (p.inStock === false || p.stockStatus === "out_of_stock") return 2;
    if (p.stockStatus === "unverified_zone") return 1;
    return 0;
  };

  // Ordenar: 0 = Stock confirmado, 1 = Stock sin validar en comuna (Tottus API), 2 = Agotado
  allProducts.sort(
    (a, b) => getStockTier(a) - getStockTier(b) || a.unitPrice - b.unitPrice
  );

  // Detectar Falsos Packs Ahorro entre los resultados encontrados
  const packTraps = detectPackTraps(allProducts.filter((p) => p.inStock !== false));

  return {
    query,
    fetchedAt: new Date().toISOString(),
    jumboStore: jumboStore || null,
    discoveredJumboStores: [...discoveredJumboSet].sort(),
    storeStatus,
    products: allProducts,
    packTraps,
  };
}

// --- 6. Resolución de Producto por Link / URL directa ---

export async function fetchProductByUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("URL inválida. Asegúrate de pegar el link completo (https://...).");
  }

  const host = parsed.hostname.toLowerCase();
  let storeId = null;
  if (host.includes("jumbo.cl")) storeId = "jumbo";
  else if (host.includes("santaisabel.cl") || host.includes("sisa.cl")) storeId = "santaisabel";
  else if (host.includes("unimarc.cl")) storeId = "unimarc";
  else if (host.includes("tottus.cl") || host.includes("falabella.com")) storeId = "tottus";
  else if (host.includes("lider.cl")) storeId = "lider";

  if (!storeId) {
    throw new Error(
      `Dominio "${host}" no reconocido. Usa links de Jumbo, Santa Isabel, Unimarc o Tottus.`
    );
  }

  // En Jumbo / Santa Isabel podemos leer directo la ficha PDP con precio y promo en vivo
  if (storeId === "santaisabel" || storeId === "jumbo") {
    try {
      const chk = await verifyProductUrl(rawUrl, storeId);
      if (chk.ok && chk.liveOffer?.price > 0 && chk.liveOffer?.name) {
        const mappedLive = buildCencosudProductFromLiveEntry(CENCOSUD_CONFIGS[storeId], {
          ...chk.liveOffer,
          skuId: chk.liveOffer.skuId || `pdp-${Date.now()}`,
          reference: chk.liveOffer.skuId || "",
          slug: "",
        });
        mappedLive.url = normalizeProductUrl(chk.url || rawUrl, storeId);
        mappedLive.linkStatus = "ok";
        return mappedLive;
      }
    } catch {}
  }

  // Extraer palabras clave o ID desde el pathname
  const pathParts = parsed.pathname
    .split("/")
    .filter((p) => p && p !== "p" && p !== "product" && p !== "tottus-cl" && p !== "articulo");

  const slug = pathParts[pathParts.length - 1] || "";
  const searchTerms = slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\d{7,}\b/g, "")
    .trim();

  if (!searchTerms) {
    throw new Error("No se pudo identificar el nombre del producto desde el link.");
  }

  const res = await searchAllStores(searchTerms, {
    stores: [storeId],
    limitPerStore: 10,
    minRelevance: 0.1,
  });

  const storeStat = res.storeStatus[storeId];
  if (storeStat && !storeStat.ok) {
    throw new Error(storeStat.error);
  }

  if (!res.products || res.products.length === 0) {
    throw new Error(`No se encontró el producto en ${STORES[storeId].name} para "${searchTerms}".`);
  }

  // Buscar coincidencia exacta de URL o SKU si existe, si no el de mayor relevancia
  const cleanTarget = parsed.pathname.toLowerCase().replace(/\/$/, "");
  const exactMatch = res.products.find((p) => {
    try {
      const pPath = new URL(p.url).pathname.toLowerCase().replace(/\/$/, "");
      return pPath === cleanTarget || cleanTarget.includes(p.sku?.toLowerCase());
    } catch {
      return false;
    }
  });

  if (exactMatch) return exactMatch;

  res.products.sort((a, b) => b.relevance - a.relevance);
  return res.products[0];
}

// --- 7. Rechequeo en Vivo de Link y Precio de un Producto Específico ---

export async function recheckLiveProductOffer(product, { force = true } = {}) {
  const verifiedAt = new Date().toISOString();
  if (!product || !product.store) {
    return {
      ok: false,
      linkStatus: "broken",
      verifiedAt,
      priceChanged: false,
      oldPrice: 0,
      newPrice: 0,
      product,
    };
  }

  const store = product.store;
  const oldPrice = Number(product.price) || 0;
  const updated = {
    ...product,
    url: normalizeProductUrl(product.url || "", store),
    lastVerifiedAt: verifiedAt,
  };

  try {
    if (store === "santaisabel" || store === "jumbo") {
      if (updated.url) {
        const chk = await verifyProductUrl(updated.url, store, { force });
        updated.linkStatus = chk.status || "ok";
        updated.linkHttpStatus = chk.httpStatus || 200;
        if (chk.url) updated.url = chk.url;

        if (chk.liveOffer?.price > 0) {
          const merged = applyCencosudLiveOffer(updated, chk.liveOffer);
          Object.assign(updated, merged, {
            linkStatus: chk.status || "ok",
            lastVerifiedAt: chk.verifiedAt || verifiedAt,
            priceVerified: true,
          });
          return {
            ok: chk.status !== "broken",
            linkStatus: updated.linkStatus,
            verifiedAt: updated.lastVerifiedAt,
            priceChanged: updated.price !== oldPrice,
            oldPrice,
            newPrice: updated.price,
            product: updated,
          };
        }
      }

      // Fallback al catálogo SSR en vivo de Cencosud si la URL no entregó liveOffer o tenía un slug antiguo
      if (updated.name) {
        const cfg = CENCOSUD_CONFIGS[store];
        const liveEntries = await fetchCencosudLiveSearch(cfg, updated.name);
        const matchedOffer =
          liveEntries.find(
            (entry) =>
              (updated.externalId && String(entry.skuId) === String(updated.externalId)) ||
              (updated.sku && String(entry.reference) === String(updated.sku)) ||
              (updated.externalId && String(entry.reference) === String(updated.externalId)) ||
              (updated.url && entry.slug && updated.url.includes(entry.slug))
          ) ||
          liveEntries
            .map((entry) => ({ entry, score: matchScore(updated.name, entry.name) }))
            .filter((x) => x.score >= 0.72)
            .sort((a, b) => b.score - a.score)[0]?.entry;

        if (matchedOffer && matchedOffer.price > 0) {
          const merged = applyCencosudLiveOffer(updated, matchedOffer);
          if (matchedOffer.slug) {
            merged.url = normalizeProductUrl(`${cfg.siteBaseUrl}/${matchedOffer.slug}/p`, store);
          }
          Object.assign(updated, merged, {
            linkStatus: "ok",
            lastVerifiedAt: verifiedAt,
            priceVerified: true,
          });
        }
      }
      return {
        ok: updated.linkStatus !== "broken",
        linkStatus: updated.linkStatus || "ok",
        verifiedAt,
        priceChanged: updated.price !== oldPrice,
        oldPrice,
        newPrice: updated.price,
        product: updated,
      };
    }

    if (store === "unimarc" || store === "tottus") {
      updated.linkStatus = "protected";
      const searchQ = buildCrossStoreSearchQuery(updated.name || "") || updated.name || "";
      if (searchQ) {
        const liveList =
          store === "unimarc"
            ? await searchUnimarc(searchQ, 12)
            : await searchTottus(searchQ, 12);

        const match =
          liveList.find(
            (p) =>
              (updated.externalId && String(p.externalId) === String(updated.externalId)) ||
              (updated.sku && String(p.sku) === String(updated.sku)) ||
              (updated.url && p.url && normalizeProductUrl(p.url, store) === updated.url)
          ) ||
          liveList
            .map((p) => ({ p, score: matchScore(updated.name, p.name) }))
            .filter((x) => x.score >= 0.72)
            .sort((a, b) => b.score - a.score)[0]?.p;

        if (match && match.price > 0) {
          updated.price = match.price;
          updated.listPrice = match.listPrice ?? null;
          updated.promoText = match.promoText ?? null;
          updated.bundlePricePerItem = match.bundlePricePerItem ?? null;
          updated.unitPrice = match.unitPrice || updated.unitPrice;
          updated.effectiveUnitPrice = match.effectiveUnitPrice || match.unitPrice || updated.effectiveUnitPrice;
          updated.inStock = match.inStock !== false;
          updated.stockStatus =
            updated.stockStatus === "out_of_stock"
              ? "out_of_stock"
              : match.inStock === false
              ? "out_of_stock"
              : "in_stock";
          if (match.url) updated.url = match.url;
          updated.priceVerified = true;
        }
      }
      return {
        ok: true,
        linkStatus: "protected",
        verifiedAt,
        priceChanged: updated.price !== oldPrice,
        oldPrice,
        newPrice: updated.price,
        product: updated,
      };
    }

    if (store === "lider") {
      updated.linkStatus = "protected";
      updated.priceVerified = Boolean(updated.priceVerified ?? true);
      return {
        ok: true,
        linkStatus: "protected",
        verifiedAt,
        priceChanged: false,
        oldPrice,
        newPrice: updated.price,
        product: updated,
      };
    }

    return {
      ok: true,
      linkStatus: updated.linkStatus || "ok",
      verifiedAt,
      priceChanged: false,
      oldPrice,
      newPrice: updated.price,
      product: updated,
    };
  } catch {
    return {
      ok: true,
      linkStatus: store === "lider" || store === "unimarc" || store === "tottus" ? "protected" : updated.linkStatus || "unknown",
      verifiedAt,
      priceChanged: false,
      oldPrice,
      newPrice: updated.price,
      product: updated,
    };
  }
}
