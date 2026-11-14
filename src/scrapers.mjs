import { randomUUID } from "node:crypto";
import {
  detectPackTraps,
  enrichUnitMetrics,
  estimateProteinMetrics,
  matchScore,
  normalizeUnit,
  parseBundle,
  parseClpString,
  parseUnitPriceString,
  toClp,
} from "./normalizer.mjs";

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

export async function searchCencosud(storeId, query, limit = 18) {
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

  const url = `https://${cfg.host}/search/${encodeURIComponent(query)}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Accept-Language": "es-CL,es;q=0.9",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`${STORES[storeId].name} HTTP ${res.status}`);
  }

  const json = await res.json();
  const results = json?.response?.results ?? [];

  return results
    .map((r) => mapCencosudItem(cfg, r))
    .filter((item) => item !== null && item.inStock);
}

function mapCencosudItem(cfg, result) {
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

  const rawUrl = data.url;
  const detailUrl = data.DetailUrl;
  const productUrl =
    rawUrl || (detailUrl ? `${cfg.siteBaseUrl}${detailUrl}` : `${cfg.siteBaseUrl}`);

  const protein = estimateProteinMetrics(
    name,
    unitMetrics.unit,
    unitMetrics.baseAmount,
    price
  );

  return {
    store: cfg.storeId,
    storeName: STORES[cfg.storeId].name,
    externalId: String(data.id),
    sku: data.ProductRefId ? String(data.ProductRefId) : String(data.id),
    name: String(name).trim(),
    brand: data.BrandName ? String(data.BrandName).trim() : "",
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
    hasProteinData: protein.hasProteinData,
    proteinGramsTotal: protein.proteinGramsTotal,
    proteinPer100g: protein.proteinPer100g,
    pricePer10gProtein: protein.pricePer10gProtein,
    imageUrl: data.image_url || "",
    url: productUrl,
    inStock,
    fetchedAt: new Date().toISOString(),
  };
}

// --- 2. Adaptador Unimarc (BFF Ecommerce VTEX) ---

export async function searchUnimarc(query, limit = 18) {
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
  const products = json?.availableProducts ?? [];
  return products.map(mapUnimarcItem).filter(Boolean);
}

function mapUnimarcItem(p) {
  const item = p?.item;
  const priceInfo = p?.price;
  if (!item?.name || !item?.sku || !priceInfo) return null;

  const price = parseClpString(priceInfo.price);
  if (!price) return null;

  let listPrice = parseClpString(priceInfo.listPrice);
  if (listPrice !== undefined && listPrice <= price) listPrice = undefined;

  const ppu = parseUnitPriceString(priceInfo.ppum);
  const tag = p?.priceDetail?.promotionalTag?.text;
  const isClub = typeof tag === "string" && /club/i.test(tag);
  const memberPrice = isClub ? price : null;

  const promo = p?.promotion;
  const promoDesc =
    promo?.hasSavings && promo?.descriptionMessage
      ? promo.descriptionMessage
      : isClub
      ? tag
      : listPrice
      ? "Oferta"
      : null;

  const bundle = promoDesc ? parseBundle(promoDesc) : undefined;
  const bundleUnitPrice = promo?.price ?? bundle?.unitPriceInBundle ?? null;

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

  const productUrl = item.slug
    ? `https://www.unimarc.cl/product${item.slug.startsWith("/") ? item.slug : "/" + item.slug}`
    : "https://www.unimarc.cl";

  const protein = estimateProteinMetrics(
    item.name,
    unitMetrics.unit,
    unitMetrics.baseAmount,
    price
  );

  return {
    store: "unimarc",
    storeName: "Unimarc",
    externalId: String(item.sku),
    sku: String(item.sku),
    ean: item.ean || null,
    name: String(item.name).trim(),
    brand: item.brand ? String(item.brand).trim() : "",
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
    hasProteinData: protein.hasProteinData,
    proteinGramsTotal: protein.proteinGramsTotal,
    proteinPer100g: protein.proteinPer100g,
    pricePer10gProtein: protein.pricePer10gProtein,
    imageUrl: item.images?.[0] || "",
    url: productUrl,
    inStock: true,
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

  const protein = estimateProteinMetrics(
    p.displayName,
    unitMetrics.unit,
    unitMetrics.baseAmount,
    price
  );

  return {
    store: "tottus",
    storeName: "Tottus",
    externalId: String(p.skuId ?? p.productId),
    sku: String(p.productId ?? p.skuId),
    name: String(p.displayName).trim(),
    brand: p.brand ? String(p.brand).trim() : "",
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
    hasProteinData: protein.hasProteinData,
    proteinGramsTotal: protein.proteinGramsTotal,
    proteinPer100g: protein.proteinPer100g,
    pricePer10gProtein: protein.pricePer10gProtein,
    imageUrl: p.mediaUrls?.[0] || "",
    url: p.url || "https://www.tottus.cl",
    inStock: true,
    fetchedAt: new Date().toISOString(),
  };
}

// --- 4. Adaptador Lider (Parser de __NEXT_DATA__ + detección de bloqueo Antibot) ---

const NEXT_DATA_REGEX = /<script[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i;

function findLiderProductsInTree(node, depth = 0) {
  if (depth > 14 || !node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    if (
      node.length > 0 &&
      node[0] &&
      typeof node[0] === "object" &&
      (node[0].__typename === "Product" || node[0].usItemId || node[0].priceInfo)
    ) {
      return node;
    }
    for (const child of node) {
      const found = findLiderProductsInTree(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(node)) {
    const found = findLiderProductsInTree(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function parseLiderRawInput(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  let jsonStr = rawText.trim();
  const match = NEXT_DATA_REGEX.exec(jsonStr);
  if (match) {
    jsonStr = match[1];
  }
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  const arr = findLiderProductsInTree(data, 0) ?? [];
  return arr.map(mapLiderItem).filter(Boolean);
}

function mapLiderItem(p) {
  const id = p?.usItemId ?? p?.id;
  if (!id || !p?.name || !p?.priceInfo) return null;

  const info = p.priceInfo;
  const price = parseClpString(info.linePrice) ?? parseClpString(info.itemPrice);
  if (!price) return null;

  let listPrice = parseClpString(info.wasPrice);
  if (listPrice !== undefined && listPrice <= price) listPrice = undefined;

  const memberPrice = parseClpString(info.memberPriceString) ?? null;
  const ppu = parseUnitPriceString(info.unitPrice);

  const unitMetrics = enrichUnitMetrics({
    price,
    storeUnitPrice: ppu?.unitPrice,
    storeUnit: ppu?.unit,
    name: p.name,
    description: p.shortDescription || "",
  });

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

  const protein = estimateProteinMetrics(
    p.name,
    unitMetrics.unit,
    unitMetrics.baseAmount,
    price
  );

  return {
    store: "lider",
    storeName: "Lider",
    externalId: String(id),
    sku: String(id),
    name: String(p.name).trim(),
    brand: p.brand ? String(p.brand).trim() : "",
    price,
    listPrice: listPrice ?? null,
    memberPrice,
    promoText: bundlePromo?.description || (listPrice ? "Rollback / Oferta" : null),
    bundlePricePerItem: bundlePromo?.unitPriceInBundle ?? null,
    unit: unitMetrics.unit,
    unitPrice: unitMetrics.unitPrice,
    effectiveUnitPrice: unitMetrics.unitPrice,
    baseAmount: unitMetrics.baseAmount,
    formatLabel: unitMetrics.formatLabel,
    pricePer100: unitMetrics.pricePer100,
    per100UnitName: unitMetrics.per100UnitName,
    pricePerSmallUnit: unitMetrics.pricePerSmallUnit,
    smallUnitName: unitMetrics.smallUnitName,
    hasProteinData: protein.hasProteinData,
    proteinGramsTotal: protein.proteinGramsTotal,
    proteinPer100g: protein.proteinPer100g,
    pricePer10gProtein: protein.pricePer10gProtein,
    imageUrl:
      p.imageInfo?.thumbnailUrl || p.imageInfo?.allImages?.[0]?.url || "",
    url: p.canonicalUrl
      ? `https://super.lider.cl${p.canonicalUrl}`
      : "https://super.lider.cl",
    inStock: p.availabilityStatus ? p.availabilityStatus === "IN_STOCK" : true,
    fetchedAt: new Date().toISOString(),
  };
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
  } = options;

  const adapters = {
    jumbo: (q) => searchCencosud("jumbo", q, limitPerStore),
    santaisabel: (q) => searchCencosud("santaisabel", q, limitPerStore),
    unimarc: (q) => searchUnimarc(q, limitPerStore),
    tottus: (q) => searchTottus(q, limitPerStore),
    lider: (q) => searchLider(q, limitPerStore),
  };

  const storeStatus = {};
  const allProducts = [];

  await Promise.all(
    stores.map(async (storeId) => {
      const fn = adapters[storeId];
      if (!fn) return;
      const t0 = Date.now();
      try {
        const items = await fn(query);
        const scored = items
          .map((item) => ({
            ...item,
            relevance: matchScore(query, `${item.name} ${item.brand || ""} ${item.formatLabel || ""}`),
          }))
          .filter((item) => item.relevance >= minRelevance);

        // Si el filtro estricto deja 0 pero la tienda devolvió productos, mantenemos los primeros 5
        const finalItems = scored.length > 0 ? scored : items.slice(0, 5).map((i) => ({ ...i, relevance: 0.4 }));
        allProducts.push(...finalItems);
        storeStatus[storeId] = {
          ok: true,
          count: finalItems.length,
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

  // Ordenar por mejor precio por unidad (kg/lt/un) por defecto
  allProducts.sort((a, b) => a.unitPrice - b.unitPrice);

  // Detectar Falsos Packs Ahorro entre los resultados encontrados
  const packTraps = detectPackTraps(allProducts);

  return {
    query,
    fetchedAt: new Date().toISOString(),
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
