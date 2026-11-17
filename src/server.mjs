import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  addPinnedProduct,
  calculatePersonalIpc,
  createTrackedItem,
  deleteTrackedItem,
  getAllSnapshotsForExport,
  getSetting,
  getTrackedItemById,
  insertSnapshot,
  listTrackedItems,
  removePinnedProduct,
  setSetting,
  touchOrInsertSnapshot,
  updateTrackedItem,
} from "./db.mjs";
import {
  addCartItem,
  createCart,
  deleteCart,
  getCartById,
  importCartFromLiderItems,
  listCarts,
  refreshCartPrices,
  removeCartItem,
  seedDefaultCartIfNeeded,
  syncBrowserOffersToCarts,
  updateCartCriteria,
  updateCartItem,
  updateCartItemLiderOffer,
  updateCartSettings,
} from "./carts.mjs";
import {
  DISCOUNT_PROGRAMS,
  WEEKDAY_RULES,
  getTodayDayIndex,
  getWeekdayName,
} from "./discounts.mjs";
import {
  buildCrossStoreSearchQuery,
  enrichUnitMetrics,
  matchScore,
} from "./normalizer.mjs";
import {
  fetchProductByUrl,
  parseLiderCartPayload,
  parseLiderRawInput,
  parseStoreBrowserPayload,
  searchAllStores,
  STORES,
  verifyProductUrl,
} from "./scrapers.mjs";
import { sendTelegramNotification } from "./telegram.mjs";
import {
  refreshAllTrackedItems,
  refreshTrackedItem,
  seedInitialDataIfNeeded,
} from "./tracker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3456);
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_PASSWORD = (process.env.ACCESS_PASSWORD || "").trim();

function signToken(purpose) {
  if (!ACCESS_PASSWORD) return "";
  return createHmac("sha256", ACCESS_PASSWORD).update(purpose).digest("hex");
}

function safeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader = "") {
  const out = {};
  for (const part of String(cookieHeader).split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isHttpsRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return proto === "https" || Boolean(req.socket?.encrypted);
}

function isAuthenticated(req) {
  if (!ACCESS_PASSWORD) return true;
  const cookies = parseCookies(req.headers.cookie || "");
  if (safeEqualStr(cookies.sp_session, signToken("session"))) return true;

  const headerKey = req.headers["x-access-key"];
  if (headerKey && safeEqualStr(headerKey, ACCESS_PASSWORD)) return true;

  const authHeader = String(req.headers.authorization || "");
  if (authHeader.startsWith("Bearer ")) {
    if (safeEqualStr(authHeader.slice(7).trim(), ACCESS_PASSWORD)) return true;
  }
  return false;
}

function getImportToken() {
  if (!ACCESS_PASSWORD) return "";
  const ver = getSetting("import_token_version", "1");
  return signToken(`import-lider:v${ver}`);
}

function isImportAuthorized(req, urlObj) {
  if (isAuthenticated(req)) return true;
  const token = urlObj.searchParams.get("token") || "";
  if (safeEqualStr(token, getImportToken())) return true;
  const ver = getSetting("import_token_version", "1");
  return ver === "1" && safeEqualStr(token, signToken("import-lider"));
}

function maskSecret(val = "") {
  const s = String(val || "").trim();
  if (!s) return "";
  if (s.length <= 10) return "••••••••";
  return `${s.slice(0, 5)}••••••${s.slice(-4)}`;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error("Payload demasiado grande"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Parsea líneas de lista de compras rápidas:
 * Ej: "3 x Leche entera 1L", "2 Arroz grado 1", "Aceite maravilla"
 */
function parseShoppingListLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 1)
    .map((line) => {
      const m = line.match(/^(\d{1,3})\s*(?:x|un|unidades|\*)?\s+(.+)$/i);
      if (m) {
        return {
          quantity: Math.max(1, Number(m[1])),
          label: m[2].trim(),
          searchQuery: m[2].trim(),
        };
      }
      return {
        quantity: 1,
        label: line,
        searchQuery: line,
      };
    });
}

// --- Programador automático en segundo plano (Scheduler) ---
let autoTimer = null;

function setupAutoScheduler() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  const minutes = Number(getSetting("auto_interval_minutes", "360"));
  if (minutes > 0 && Number.isFinite(minutes)) {
    const ms = Math.max(minutes, 5) * 60 * 1000;
    autoTimer = setInterval(async () => {
      console.log(
        `[Auto-Tracker] Ejecutando actualización programada (${new Date().toISOString()})...`
      );
      try {
        await refreshAllTrackedItems();
      } catch (err) {
        console.error("[Auto-Tracker] Error:", err.message);
      }
    }, ms);
  }
}

// --- Servidor HTTP ---

const server = http.createServer(async (req, res) => {
  try {
    // Permitir llamadas CORS para el Bookmarklet de 1 Clic desde cualquier navegador
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Access-Key");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const proto = isHttpsRequest(req) ? "https" : "http";
    const urlObj = new URL(req.url, `${proto}://${req.headers.host || "localhost"}`);
    const pathname = urlObj.pathname;
    const method = req.method || "GET";

    // 0. Healthcheck público (Railway / Docker)
    if (pathname === "/health" && method === "GET") {
      return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    }

    // 0.1 Autenticación opcional mediante ACCESS_PASSWORD
    if (pathname === "/api/auth/status" && method === "GET") {
      return sendJson(res, 200, {
        authEnabled: Boolean(ACCESS_PASSWORD),
        authenticated: isAuthenticated(req),
      });
    }

    if (pathname === "/api/auth/login" && method === "POST") {
      if (!ACCESS_PASSWORD) {
        return sendJson(res, 200, { ok: true, authEnabled: false });
      }
      const body = await readJsonBody(req);
      if (!safeEqualStr(body.password, ACCESS_PASSWORD)) {
        return sendJson(res, 401, { error: "Contraseña incorrecta." });
      }
      const secureFlag = isHttpsRequest(req) ? "; Secure" : "";
      res.setHeader(
        "Set-Cookie",
        `sp_session=${signToken("session")}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secureFlag}`
      );
      return sendJson(res, 200, { ok: true, authenticated: true });
    }

    if (pathname === "/api/auth/logout" && method === "POST") {
      res.setHeader(
        "Set-Cookie",
        "sp_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
      );
      return sendJson(res, 200, { ok: true });
    }

    // Importador Multi-Supermercado desde navegador: Lider, Tottus, Jumbo, Santa Isabel, Unimarc
    if ((pathname === "/api/import-lider" || pathname === "/api/import-browser") && method === "POST") {
      if (!isImportAuthorized(req, urlObj)) {
        return sendJson(res, 401, {
          error: "Token de Bookmarklet inválido o sesión no autenticada.",
        });
      }
      const body = await readJsonBody(req);
      let cartItems = Array.isArray(body.cartItems) ? body.cartItems : [];
      const browserItems = Array.isArray(body.browserItems) ? body.browserItems : [];
      if (cartItems.length === 0 && browserItems.length === 0 && typeof body.rawContent === "string") {
        const trimmedRaw = body.rawContent.trim();
        if (trimmedRaw.startsWith("{") || trimmedRaw.startsWith("[")) {
          try {
            const parsedJson = JSON.parse(trimmedRaw);
            if (Array.isArray(parsedJson) && parsedJson.some((x) => x?.name)) {
              cartItems = parsedJson;
            } else if (Array.isArray(parsedJson?.cartItems)) {
              cartItems = parsedJson.cartItems;
            }
          } catch {}
        }
      }

      const products =
        browserItems.length > 0
          ? parseStoreBrowserPayload({
              rawContent: body.rawContent || "",
              cartItems,
              browserItems,
              url: body.url || "",
              storeZone: body.storeZone || "",
            })
          : parseLiderCartPayload({
              rawContent: body.rawContent || "",
              cartItems,
              url: body.url || "",
              storeZone: body.storeZone || "",
            });

      if (products.length === 0) {
        return sendJson(res, 400, {
          error:
            "No se encontraron productos en la página o texto pegado. Abre una búsqueda, carrito (/cart) o ficha de producto.",
        });
      }

      // Sincronizar disponibilidad/stock por zona en carritos existentes (ej. Tottus agotado en Viña del Mar)
      syncBrowserOffersToCarts(products);

      const isCartMode =
        body.mode === "cart" ||
        String(body.url || "").includes("/cart") ||
        cartItems.length > 0 ||
        products.some((p) => Number(p.cartQuantity) > 0);

      let trackedItem = null;
      const matchedTitles = [];

      if (isCartMode && !body.trackedItemId) {
        const cartRes = await importCartFromLiderItems({
          name:
            body.cartName ||
            `🟦 Carrito Lider (${new Date().toLocaleDateString("es-CL")})`,
          items: products,
        });

        // Sincronizar también snapshots en productos seguidos que coincidan
        const trackedItems = listTrackedItems();
        for (const item of trackedItems) {
          const query = item.search_query || item.title;
          let candidates = products.filter(
            (p) => matchScore(query, p.name) >= 0.5 || matchScore(p.name, query) >= 0.5
          );
          if (item.preferred_unit && item.preferred_unit !== "auto") {
            const unitFiltered = candidates.filter((p) => p.unit === item.preferred_unit);
            if (unitFiltered.length > 0) candidates = unitFiltered;
          }
          if (candidates.length > 0) {
            candidates.sort((a, b) => a.unitPrice - b.unitPrice);
            touchOrInsertSnapshot({ trackedItemId: item.id, product: candidates[0] });
            matchedTitles.push(item.title);
          }
        }

        return sendJson(res, 200, {
          isCartImport: true,
          count: products.length,
          importedItemsCount: cartRes.importedItemsCount,
          cartId: cartRes.cartId,
          cart: cartRes.cart,
          matchedTrackedCount: matchedTitles.length,
          matchedTitles,
          products,
        });
      }

      if (body.trackedItemId) {
        products.sort((a, b) => a.unitPrice - b.unitPrice);
        touchOrInsertSnapshot({
          trackedItemId: Number(body.trackedItemId),
          product: products[0],
        });
        trackedItem = getTrackedItemById(Number(body.trackedItemId));
        if (trackedItem) matchedTitles.push(trackedItem.title);
      } else {
        const trackedItems = listTrackedItems();
        for (const item of trackedItems) {
          const query = item.search_query || item.title;
          let candidates = products.filter(
            (p) => matchScore(query, p.name) >= 0.5 || matchScore(p.name, query) >= 0.5
          );
          if (item.preferred_unit && item.preferred_unit !== "auto") {
            const unitFiltered = candidates.filter((p) => p.unit === item.preferred_unit);
            if (unitFiltered.length > 0) candidates = unitFiltered;
          }
          if (candidates.length > 0) {
            candidates.sort((a, b) => a.unitPrice - b.unitPrice);
            touchOrInsertSnapshot({ trackedItemId: item.id, product: candidates[0] });
            matchedTitles.push(item.title);
          }
        }

        if (matchedTitles.length === 0 && products.length > 0) {
          const bestProd = products[0];
          const cleanQuery = buildCrossStoreSearchQuery(bestProd.name) || bestProd.name;
          const newId = createTrackedItem({
            title: bestProd.name,
            searchQuery: cleanQuery,
            mode: "mixed",
            preferredUnit: bestProd.unit || "auto",
            category: "Despensa",
          });
          touchOrInsertSnapshot({ trackedItemId: newId, product: bestProd });
          trackedItem = await refreshTrackedItem(newId);
          matchedTitles.push(bestProd.name);
        }
      }

      return sendJson(res, 200, {
        isCartImport: false,
        count: products.length,
        matchedTrackedCount: matchedTitles.length,
        matchedTitles,
        products,
        trackedItem,
      });
    }

    // Bloquear rutas /api/* restantes si ACCESS_PASSWORD está configurada
    if (pathname.startsWith("/api/") && !isAuthenticated(req)) {
      return sendJson(res, 401, {
        error: "Acceso restringido. Inicia sesión para acceder a SuperPrecio CL.",
        code: "UNAUTHORIZED",
      });
    }

    if (pathname === "/api/bookmarklet-info" && method === "GET") {
      return sendJson(res, 200, {
        authEnabled: Boolean(ACCESS_PASSWORD),
        importToken: ACCESS_PASSWORD ? getImportToken() : null,
        tokenVersion: getSetting("import_token_version", "1"),
      });
    }

    if (pathname === "/api/bookmarklet-rotate" && method === "POST") {
      const curVer = Number(getSetting("import_token_version", "1")) || 1;
      const nextVer = String(curVer + 1);
      setSetting("import_token_version", nextVer);
      return sendJson(res, 200, {
        ok: true,
        authEnabled: Boolean(ACCESS_PASSWORD),
        importToken: ACCESS_PASSWORD ? getImportToken() : null,
        tokenVersion: nextVer,
      });
    }

    // Verificador en vivo de links de productos (detecta 404 vs 200 OK vs Antibot)
    if (pathname === "/api/verify-links" && method === "POST") {
      const body = await readJsonBody(req);
      const links = Array.isArray(body.links) ? body.links.slice(0, 60) : [];
      const results = {};
      await Promise.all(
        links.map(async (entry) => {
          const key = entry?.key || entry?.url;
          if (!key || !entry?.url) return;
          results[key] = await verifyProductUrl(entry.url, entry.store || "");
        })
      );
      return sendJson(res, 200, { results });
    }

    // 1. Metadata de tiendas y configuración
    if (pathname === "/api/stores" && method === "GET") {
      return sendJson(res, 200, {
        stores: STORES,
        settings: {
          autoIntervalMinutes: Number(getSetting("auto_interval_minutes", "360")),
          lastAutoRunAt: getSetting("last_auto_run_at", null),
          preferredJumboStore: getSetting("preferred_jumbo_store", ""),
          preferredCommuneLabel: getSetting("preferred_commune_label", "Viña del Mar"),
        },
      });
    }

    // 2. Búsqueda en vivo multi-supermercado
    if (pathname === "/api/search" && method === "GET") {
      const q = (urlObj.searchParams.get("q") || "").trim();
      if (!q) {
        return sendJson(res, 400, { error: "Ingresa un término de búsqueda." });
      }
      const storesParam = urlObj.searchParams.get("stores");
      const stores = storesParam
        ? storesParam
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : ["jumbo", "santaisabel", "unimarc", "tottus"];

      const jumboStore =
        urlObj.searchParams.get("jumboStore") !== null
          ? urlObj.searchParams.get("jumboStore").trim()
          : getSetting("preferred_jumbo_store", "");

      const limit = Number(urlObj.searchParams.get("limit") || 18);
      const data = await searchAllStores(q, {
        stores,
        limitPerStore: limit,
        minRelevance: 0.35,
        jumboStore,
        includeOutOfStock: true,
      });
      return sendJson(res, 200, data);
    }

    // 3. Listar productos seguidos e historial
    if (pathname === "/api/tracked" && method === "GET") {
      const items = listTrackedItems();
      return sendJson(res, 200, {
        items,
        settings: {
          autoIntervalMinutes: Number(getSetting("auto_interval_minutes", "360")),
          lastAutoRunAt: getSetting("last_auto_run_at", null),
        },
      });
    }

    // 4. Crear nuevo producto/búsqueda en seguimiento
    if (pathname === "/api/tracked" && method === "POST") {
      const body = await readJsonBody(req);
      const title = (body.title || body.searchQuery || "").trim();
      if (!title) {
        return sendJson(res, 400, { error: "El nombre del producto es obligatorio." });
      }

      const id = createTrackedItem({
        title,
        searchQuery: body.searchQuery ?? title,
        mode: body.mode || "mixed",
        preferredUnit: body.preferredUnit || "auto",
        category: body.category || "Despensa",
        targetPriceClp: body.targetPriceClp ?? null,
      });

      if (body.initialProduct) {
        addPinnedProduct(id, body.initialProduct);
      }

      const updated = await refreshTrackedItem(id);
      return sendJson(res, 201, { item: updated });
    }

    // 5. Actualizar todos los productos seguidos ahora
    if (pathname === "/api/tracked/refresh-all" && method === "POST") {
      const items = await refreshAllTrackedItems();
      return sendJson(res, 200, {
        items,
        lastAutoRunAt: getSetting("last_auto_run_at", null),
      });
    }

    // 6. Operaciones sobre un producto seguido específico (/api/tracked/:id...)
    const trackedMatch = pathname.match(/^\/api\/tracked\/(\d+)(?:\/([a-z-]+))?$/);
    if (trackedMatch) {
      const itemId = Number(trackedMatch[1]);
      const action = trackedMatch[2];

      if (!action && method === "DELETE") {
        deleteTrackedItem(itemId);
        return sendJson(res, 200, { ok: true });
      }

      if (!action && method === "GET") {
        const item = getTrackedItemById(itemId);
        if (!item) return sendJson(res, 404, { error: "No encontrado" });
        return sendJson(res, 200, { item });
      }

      if (!action && method === "PATCH") {
        const body = await readJsonBody(req);
        const item = updateTrackedItem(itemId, body);
        if (!item) return sendJson(res, 404, { error: "No encontrado" });
        return sendJson(res, 200, { item });
      }

      if (action === "refresh" && method === "POST") {
        const item = await refreshTrackedItem(itemId);
        return sendJson(res, 200, { item });
      }

      if (action === "pin" && method === "POST") {
        const body = await readJsonBody(req);
        if (!body.product) {
          return sendJson(res, 400, { error: "Falta objeto product" });
        }
        addPinnedProduct(itemId, body.product);
        const item = getTrackedItemById(itemId);
        return sendJson(res, 200, { item });
      }

      if (action === "manual-snapshot" && method === "POST") {
        const body = await readJsonBody(req);
        const price = Number(body.price);
        if (!price || price <= 0) {
          return sendJson(res, 400, { error: "Precio inválido" });
        }
        const metrics = enrichUnitMetrics({
          price,
          name: body.name || "Producto",
          description: body.formatLabel || "",
        });
        const product = {
          store: body.store || "lider",
          externalId: body.externalId || `manual-${Date.now()}`,
          sku: body.sku || `manual-${Date.now()}`,
          name: body.name || "Producto",
          brand: body.brand || "",
          price,
          listPrice: body.listPrice ? Number(body.listPrice) : null,
          memberPrice: body.memberPrice ? Number(body.memberPrice) : null,
          promoText: body.promoText || null,
          unit: metrics.unit,
          unitPrice: metrics.unitPrice,
          effectiveUnitPrice: metrics.unitPrice,
          baseAmount: metrics.baseAmount,
          formatLabel: metrics.formatLabel,
          pricePer100: metrics.pricePer100,
          url: body.url || "",
          imageUrl: body.imageUrl || "",
        };
        if (body.pinProduct) {
          addPinnedProduct(itemId, product);
        } else {
          insertSnapshot({ trackedItemId: itemId, product });
        }
        const item = getTrackedItemById(itemId);
        return sendJson(res, 200, { item });
      }
    }

    // 7. Eliminar un producto fijado (/api/pinned/:id)
    const pinnedMatch = pathname.match(/^\/api\/pinned\/(\d+)$/);
    if (pinnedMatch && method === "DELETE") {
      removePinnedProduct(Number(pinnedMatch[1]));
      return sendJson(res, 200, { ok: true });
    }

    // =========================================================================
    // 8. ENDPOINTS DE CARRITOS DE COMPRA (/api/carts...)
    // =========================================================================

    if (pathname === "/api/carts" && method === "GET") {
      return sendJson(res, 200, { carts: listCarts() });
    }

    if (pathname === "/api/carts" && method === "POST") {
      const body = await readJsonBody(req);
      const cartId = createCart({
        name: body.name || "Nuevo Carrito de Compras",
        criteria: body.criteria || "unit_price",
      });

      if (body.batchText) {
        const parsedLines = parseShoppingListLines(body.batchText);
        for (const line of parsedLines) {
          await addCartItem(cartId, line);
        }
      }

      return sendJson(res, 201, { cart: getCartById(cartId), carts: listCarts() });
    }

    const cartItemMatch = pathname.match(/^\/api\/carts\/(\d+)\/items\/(\d+)(?:\/([a-z-]+))?$/);
    if (cartItemMatch) {
      const cartId = Number(cartItemMatch[1]);
      const itemId = Number(cartItemMatch[2]);
      const itemAction = cartItemMatch[3];

      if (!itemAction && method === "PATCH") {
        const body = await readJsonBody(req);
        const cart = updateCartItem(cartId, itemId, body);
        return sendJson(res, 200, { cart, carts: listCarts() });
      }

      if (!itemAction && method === "DELETE") {
        const cart = removeCartItem(cartId, itemId);
        return sendJson(res, 200, { cart, carts: listCarts() });
      }

      if (itemAction === "lider" && method === "POST") {
        const body = await readJsonBody(req);
        const payload = body.product || body.rawContent || "";
        const resUpdate = updateCartItemLiderOffer(cartId, itemId, payload);
        return sendJson(res, 200, { ...resUpdate, carts: listCarts() });
      }
    }

    const cartActionMatch = pathname.match(/^\/api\/carts\/(\d+)(?:\/([a-z-]+))?$/);
    if (cartActionMatch) {
      const cartId = Number(cartActionMatch[1]);
      const action = cartActionMatch[2];

      if (!action && method === "GET") {
        const cart = getCartById(cartId);
        if (!cart) return sendJson(res, 404, { error: "Carrito no encontrado" });
        return sendJson(res, 200, { cart });
      }

      if (!action && method === "PATCH") {
        const body = await readJsonBody(req);
        const cart = updateCartSettings(cartId, body);
        return sendJson(res, 200, { cart, carts: listCarts() });
      }

      if (!action && method === "DELETE") {
        deleteCart(cartId);
        return sendJson(res, 200, { carts: listCarts() });
      }

      if (action === "items" && method === "POST") {
        const body = await readJsonBody(req);
        if (body.batchText) {
          const lines = parseShoppingListLines(body.batchText);
          for (const line of lines) {
            await addCartItem(cartId, line);
          }
          const cart = getCartById(cartId);
          return sendJson(res, 200, { cart, carts: listCarts() });
        }

        const cart = await addCartItem(cartId, {
          label: body.label || body.searchQuery,
          searchQuery: body.searchQuery || body.label,
          quantity: body.quantity || 1,
          preferredUnit: body.preferredUnit || "auto",
          initialProduct: body.initialProduct || null,
        });
        return sendJson(res, 200, { cart, carts: listCarts() });
      }

      if (action === "refresh" && method === "POST") {
        const cart = await refreshCartPrices(cartId);
        return sendJson(res, 200, { cart, carts: listCarts() });
      }
    }

    // 9. Resolver un producto por URL directa (Jumbo, Santa Isabel, Unimarc, Tottus)
    if (pathname === "/api/lookup-url" && method === "POST") {
      const body = await readJsonBody(req);
      if (!body.url) {
        return sendJson(res, 400, { error: "Ingresa una URL de producto." });
      }
      const product = await fetchProductByUrl(body.url);

      let trackedItem = null;
      if (body.trackedItemId) {
        addPinnedProduct(Number(body.trackedItemId), product);
        trackedItem = getTrackedItemById(Number(body.trackedItemId));
      } else if (body.createNew) {
        const newId = createTrackedItem({
          title: body.title || product.name,
          searchQuery: body.searchQuery || product.name,
          mode: body.mode || "mixed",
          preferredUnit: product.unit || "auto",
          category: body.category || "Despensa",
        });
        addPinnedProduct(newId, product);
        trackedItem = await refreshTrackedItem(newId);
      }

      return sendJson(res, 200, { product, trackedItem });
    }

    // 10. (Manejado arriba en /api/import-lider para soportar token firmado)

    // 11. Endpoint IPC Personal (Inflación de tu canasta)
    if (pathname === "/api/ipc" && method === "GET") {
      return sendJson(res, 200, calculatePersonalIpc());
    }

    // 12. Endpoint Descuentos y Calendario Bancario
    if (pathname === "/api/discounts" && method === "GET") {
      return sendJson(res, 200, {
        programs: DISCOUNT_PROGRAMS,
        weekdayRules: WEEKDAY_RULES,
        todayIndex: getTodayDayIndex(),
        todayName: getWeekdayName(getTodayDayIndex()),
      });
    }

    // 13. Endpoints de Telegram (Configuración y Prueba)
    if (pathname === "/api/telegram" && method === "GET") {
      const rawToken = getSetting("telegram_token", "");
      return sendJson(res, 200, {
        token: maskSecret(rawToken),
        hasToken: Boolean(rawToken),
        chatId: getSetting("telegram_chat_id", ""),
        enabled: getSetting("telegram_enabled", "0") === "1",
        thresholdPct: Number(getSetting("telegram_threshold_pct", "12")),
        cartTargetTotalClp: Number(getSetting("telegram_cart_target_clp", "0")),
        weeklySummaryEnabled: getSetting("telegram_weekly_enabled", "0") === "1",
      });
    }

    if (pathname === "/api/telegram" && method === "POST") {
      const body = await readJsonBody(req);
      if (body.clearToken === true) {
        setSetting("telegram_token", "");
      } else if (body.token !== undefined) {
        const candidate = String(body.token).trim();
        if (candidate && !candidate.includes("••")) {
          setSetting("telegram_token", candidate);
        }
      }
      if (body.chatId !== undefined) setSetting("telegram_chat_id", String(body.chatId).trim());
      if (body.enabled !== undefined) setSetting("telegram_enabled", body.enabled ? "1" : "0");
      if (body.thresholdPct !== undefined) setSetting("telegram_threshold_pct", String(body.thresholdPct));
      if (body.cartTargetTotalClp !== undefined) {
        const cVal = Math.max(0, Math.round(Number(body.cartTargetTotalClp) || 0));
        setSetting("telegram_cart_target_clp", String(cVal));
      }
      if (body.weeklySummaryEnabled !== undefined) {
        setSetting("telegram_weekly_enabled", body.weeklySummaryEnabled ? "1" : "0");
      }
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/telegram/test" && method === "POST") {
      const body = await readJsonBody(req);
      const rawBodyToken = String(body.token || "").trim();
      const token =
        rawBodyToken && !rawBodyToken.includes("••")
          ? rawBodyToken
          : getSetting("telegram_token");
      const chatId = body.chatId || getSetting("telegram_chat_id");
      const resTele = await sendTelegramNotification({
        token,
        chatId,
        text: "🛒 <b>SuperPrecio CL</b>\n¡Prueba de alerta exitosa! Tu bot de Telegram está conectado correctamente y te enviará notificaciones cuando tus productos bajen a su piso histórico o alcancen tu precio objetivo.",
      });
      return sendJson(res, resTele.ok ? 200 : 400, resTele);
    }

    // 11. Guardar ajustes del programador automático y tienda geográfica
    if (pathname === "/api/settings" && method === "POST") {
      const body = await readJsonBody(req);
      if (body.autoIntervalMinutes !== undefined) {
        setSetting("auto_interval_minutes", String(Number(body.autoIntervalMinutes)));
        setupAutoScheduler();
      }
      if (body.preferredJumboStore !== undefined) {
        setSetting("preferred_jumbo_store", String(body.preferredJumboStore || "").trim());
      }
      if (body.preferredCommuneLabel !== undefined) {
        setSetting("preferred_commune_label", String(body.preferredCommuneLabel || "").trim());
      }
      return sendJson(res, 200, {
        autoIntervalMinutes: Number(getSetting("auto_interval_minutes", "360")),
        lastAutoRunAt: getSetting("last_auto_run_at", null),
        preferredJumboStore: getSetting("preferred_jumbo_store", ""),
        preferredCommuneLabel: getSetting("preferred_commune_label", "Viña del Mar"),
      });
    }

    // 12. Exportar historial completo a CSV (compatible con Excel en español)
    if (pathname === "/api/export.csv" && method === "GET") {
      const rows = getAllSnapshotsForExport();
      const headers = [
        "ID",
        "Producto Seguido",
        "Categoria",
        "Supermercado",
        "Nombre Producto",
        "Marca",
        "Formato",
        "Precio Total (CLP)",
        "Precio Normal (CLP)",
        "Precio Socio (CLP)",
        "Precio por Unidad Base (CLP)",
        "Unidad Base",
        "Precio por 100g/100ml (CLP)",
        "Promocion",
        "Fecha Registro",
        "URL",
      ];

      const escapeCsv = (val) => {
        if (val === null || val === undefined) return "";
        const str = String(val).replace(/"/g, '""');
        return /[;"\n,]/.test(str) ? `"${str}"` : str;
      };

      const lines = [
        headers.join(";"),
        ...rows.map((r) =>
          [
            r.id,
            r.tracked_title,
            r.category,
            STORES[r.store]?.name || r.store,
            r.product_name,
            r.brand,
            r.format_label,
            r.price,
            r.list_price || "",
            r.member_price || "",
            r.unit_price,
            r.unit,
            r.price_per_100,
            r.promo_text || "",
            r.recorded_at,
            r.product_url,
          ]
            .map(escapeCsv)
            .join(";")
        ),
      ];

      const csvContent = "\uFEFF" + lines.join("\r\n");
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="historial-precios-supermercados-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      return res.end(csvContent);
    }

    // 13. Archivos estáticos del Frontend
    let filePath = pathname === "/" ? "/index.html" : pathname;
    const resolvedPath = path.normalize(path.join(PUBLIC_DIR, filePath));
    if (!resolvedPath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      const ext = path.extname(resolvedPath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      return fs.createReadStream(resolvedPath).pipe(res);
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Ruta no encontrada");
  } catch (err) {
    console.error("Server error:", err);
    sendJson(res, 500, { error: err.message || "Error interno del servidor" });
  }
});

function start() {
  server.listen(PORT, HOST, () => {
    console.log(`🚀 SuperPrecio CL ejecutándose en http://${HOST}:${PORT}`);
    if (ACCESS_PASSWORD) {
      console.log("🔒 Protección con contraseña (ACCESS_PASSWORD) ACTIVADA.");
    }
    (async () => {
      await seedInitialDataIfNeeded();
      seedDefaultCartIfNeeded();
      setupAutoScheduler();
    })().catch((err) => {
      console.error("[startup] Error en inicialización/seeding en segundo plano:", err);
    });
  });
}

start();
