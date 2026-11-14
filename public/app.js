const STORE_META = {
  jumbo: { name: "Jumbo", color: "#16a34a" },
  santaisabel: { name: "Santa Isabel", color: "#dc2626" },
  unimarc: { name: "Unimarc", color: "#ea580c" },
  tottus: { name: "Tottus", color: "#65a30d" },
  lider: { name: "Lider", color: "#2563eb" },
};

const STORE_ORDER = ["jumbo", "santaisabel", "unimarc", "tottus", "lider"];
const CART_TABLE_STORES = ["jumbo", "santaisabel", "unimarc", "tottus"];

let state = {
  trackedItems: [],
  carts: [],
  activeCartId: null,
  selectedHistoryItemId: null,
  chartMode: "unit", // 'unit' | 'total'
  unitScale: "base", // 'base' ($/kg, $/lt) | 'per100' ($/100g, $/100ml) | 'small' ($/g, $/ml) | 'protein' ($/10g prot)
  liveSearchResults: [],
  liveSearchPackTraps: [],
  liveSearchQuery: "",
  liveStoreStatus: {},
  pendingPinProduct: null,
  settings: { autoIntervalMinutes: 360, lastAutoRunAt: null },
  ipcData: null,
  telegramSettings: { token: "", chatId: "", enabled: false, thresholdPct: 12 },
};

let historyChartInstance = null;

// --- Utilidades de Formato ---

function fmtClp(num) {
  if (num === null || num === undefined || !Number.isFinite(Number(num))) return "—";
  return "$" + Math.round(Number(num)).toLocaleString("es-CL");
}

function fmtUnitScaled(unitPrice, unit, scale = state.unitScale, proteinPrice = null) {
  if (scale === "protein") {
    if (proteinPrice && Number.isFinite(Number(proteinPrice))) {
      return `${fmtClp(proteinPrice)} / 10g prot`;
    }
  }

  if (!unitPrice || !Number.isFinite(Number(unitPrice))) return "—";
  const u = (unit || "un").toLowerCase();
  const isMass = u === "kg";
  const isVol = u === "lt" || u === "l";

  if (!isMass && !isVol) {
    return `${fmtClp(unitPrice)} / ${u}`;
  }

  if (scale === "per100") {
    const val = Math.round(unitPrice / 10);
    return `${fmtClp(val)} / ${isMass ? "100g" : "100ml"}`;
  }

  if (scale === "small") {
    const val = (unitPrice / 1000).toFixed(2).replace(".", ",");
    return `$${val} / ${isMass ? "g" : "ml"}`;
  }

  return `${fmtClp(unitPrice)} / ${isMass ? "kg" : "L"}`;
}

function fmtDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("es-CL", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showToast(msg) {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function getActiveCart() {
  if (!state.carts || state.carts.length === 0) return null;
  return (
    state.carts.find((c) => c.id === state.activeCartId) || state.carts[0]
  );
}

// --- Carga de Datos desde el Backend ---

async function loadTrackedData() {
  try {
    const [resTracked, resCarts] = await Promise.all([
      fetch("/api/tracked"),
      fetch("/api/carts"),
    ]);
    const data = await resTracked.json();
    const cartsData = await resCarts.json();

    state.trackedItems = data.items || [];
    state.carts = cartsData.carts || [];

    if (data.settings) {
      state.settings = data.settings;
    }

    if (!state.activeCartId && state.carts.length > 0) {
      state.activeCartId = state.carts[0].id;
    } else if (
      state.activeCartId &&
      !state.carts.some((c) => c.id === state.activeCartId)
    ) {
      state.activeCartId = state.carts[0]?.id || null;
    }

    if (!state.selectedHistoryItemId && state.trackedItems.length > 0) {
      state.selectedHistoryItemId = state.trackedItems[0].id;
    } else if (
      state.selectedHistoryItemId &&
      !state.trackedItems.some((i) => i.id === state.selectedHistoryItemId)
    ) {
      state.selectedHistoryItemId = state.trackedItems[0]?.id || null;
    }

    renderAll();
  } catch (err) {
    console.error("Error al cargar datos principales:", err);
  }
}

function renderAll() {
  renderKpis();
  renderTrackedCards();
  renderHistorySection();
  renderBasketComparison();
  populateSelectDropdowns();
}

// --- 1. Renderizar KPIs Superiores ---

function renderKpis() {
  const items = state.trackedItems;
  const activeCart = getActiveCart();

  const countBadge = document.getElementById("badgeTrackedCount");
  if (countBadge) countBadge.textContent = String(items.length);

  const cartCountBadge = document.getElementById("badgeCartItemsCount");
  if (cartCountBadge) cartCountBadge.textContent = String(activeCart?.items?.length || 0);

  const kpiTotal = document.getElementById("kpiTotalTracked");
  if (kpiTotal) kpiTotal.textContent = `${items.length} productos`;

  const totalSnaps = items.reduce((acc, it) => acc + (it.totalSnapshots || 0), 0);
  const kpiSnaps = document.getElementById("kpiTotalSnapshots");
  if (kpiSnaps) kpiSnaps.textContent = `${totalSnaps} mediciones en SQLite`;

  // KPI del Carrito Activo
  const kpiMax = document.getElementById("kpiMaxSavings");
  const kpiSub = document.getElementById("kpiSavingsSub");
  if (activeCart && activeCart.winnerSingleStore) {
    const win = activeCart.winnerSingleStore;
    const finalTotal = win.netTotalClp || win.totalClp;
    if (kpiMax) kpiMax.textContent = `${win.storeName}: ${fmtClp(finalTotal)}`;
    if (kpiSub) {
      const sav = activeCart.singleStoreMaxSavingsClp || 0;
      kpiSub.textContent =
        sav > 0
          ? `Ahorras ${fmtClp(sav)} en "${activeCart.name}" vs el más caro`
          : `Carrito "${activeCart.name}" (${win.foundCount} ítems)`;
    }
  } else {
    if (kpiMax) kpiMax.textContent = "—";
    if (kpiSub) kpiSub.textContent = "Arma tu carrito para comparar";
  }

  // Supermercado con más victorias por $/unidad
  const storeWins = { jumbo: 0, santaisabel: 0, unimarc: 0, tottus: 0, lider: 0 };
  for (const item of items) {
    const latestList = Object.values(item.latestByStore || {});
    if (latestList.length === 0) continue;
    latestList.sort((a, b) => a.unit_price - b.unit_price);
    const best = latestList[0];
    if (best && storeWins[best.store] !== undefined) {
      storeWins[best.store]++;
    }
  }

  const sortedStores = Object.entries(storeWins).sort((a, b) => b[1] - a[1]);
  const topStore = sortedStores[0];
  const kpiBest = document.getElementById("kpiBestStore");
  const kpiBestSub = document.getElementById("kpiBestStoreSub");
  if (topStore && topStore[1] > 0) {
    if (kpiBest) kpiBest.textContent = STORE_META[topStore[0]]?.name || topStore[0];
    if (kpiBestSub) kpiBestSub.textContent = `Gana en ${topStore[1]} de ${items.length} productos por $/unidad`;
  } else {
    if (kpiBest) kpiBest.textContent = "—";
  }

  const sel = document.getElementById("autoIntervalSelect");
  if (sel && state.settings.autoIntervalMinutes !== undefined) {
    sel.value = String(state.settings.autoIntervalMinutes);
  }

  const kpiLast = document.getElementById("kpiLastCheck");
  if (kpiLast) {
    kpiLast.textContent = state.settings.lastAutoRunAt
      ? `Último chequeo: ${fmtDateShort(state.settings.lastAutoRunAt)}`
      : "Actualizado hoy";
  }
}

// --- 2. Renderizar Tarjetas de Productos Seguidos ---

function renderTrackedCards() {
  const grid = document.getElementById("trackedItemsGrid");
  if (!grid) return;

  if (state.trackedItems.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        No tienes productos en seguimiento aún. Haz clic en <strong>"➕ Nuevo Producto a Seguir"</strong> o usa el <strong>Buscador en Vivo</strong>.
      </div>
    `;
    return;
  }

  grid.innerHTML = state.trackedItems
    .map((item) => {
      const best = item.bestByUnitPrice;
      const latestMap = item.latestByStore || {};
      const varMap = item.variabilityByStore || {};

      const storeRowsHtml = STORE_ORDER.map((storeId) => {
        const snap = latestMap[storeId];
        if (!snap) return "";

        const isWinner = best && best.store === storeId;
        const vStat = varMap[storeId];
        const deltaPct = vStat?.deltaPrevPct ?? 0;

        let deltaBadge = `<span class="delta-pill delta-same">= 0%</span>`;
        if (deltaPct < 0) {
          deltaBadge = `<span class="delta-pill delta-down" title="Bajó respecto a la medición anterior">▼ ${deltaPct}%</span>`;
        } else if (deltaPct > 0) {
          deltaBadge = `<span class="delta-pill delta-up" title="Subió respecto a la medición anterior">▲ +${deltaPct}%</span>`;
        }

        const minMaxText = vStat
          ? `Mín: ${fmtUnitScaled(vStat.minUnitPrice, snap.unit, state.unitScale)} · Máx: ${fmtUnitScaled(vStat.maxUnitPrice, snap.unit, state.unitScale)}`
          : "";

        const signalBadge = snap.signalLabel
          ? `<span class="signal-pill signal-${snap.signal || "normal"}" title="${snap.signalExplanation || ""}">${snap.signalLabel}</span>`
          : "";

        const proteinTag = snap.protein_price
          ? `<span class="protein-tag" title="Precio por cada 10g de proteína pura">🥩 ${fmtClp(snap.protein_price)}/10g prot</span>`
          : "";

        return `
          <div class="store-row ${isWinner ? "is-cheapest" : ""}">
            <div>
              <span class="store-badge store-${storeId}">${STORE_META[storeId]?.name || storeId}</span>
            </div>
            <div class="store-row-prod">
              <a href="${snap.product_url || "#"}" target="_blank" rel="noopener" title="${snap.product_name}">
                ${isWinner ? "🏆 " : ""}${snap.product_name}
              </a>
              <div class="store-row-meta">
                <span>📦 ${snap.format_label || `1 ${snap.unit}`}</span>
                ${snap.promo_text ? `<span style="color:#fbbf24;">🏷️ ${snap.promo_text}</span>` : ""}
                ${signalBadge}
                ${proteinTag}
                <span>${minMaxText}</span>
              </div>
            </div>
            <div class="store-row-prices">
              <div class="unit-price-main">
                ${fmtUnitScaled(snap.unit_price, snap.unit, state.unitScale, snap.protein_price)}
              </div>
              <div class="total-price-sub">
                Total: <strong>${fmtClp(snap.price)}</strong>
                ${snap.list_price ? `<span class="crossed-price">${fmtClp(snap.list_price)}</span>` : ""}
                ${deltaBadge}
              </div>
            </div>
          </div>
        `;
      })
        .filter(Boolean)
        .join("");

      const winnerHtml = best
        ? `
          <div class="winner-banner">
            <div class="winner-banner-left">
              <span>🏆 Mejor $/Unidad: <strong>${STORE_META[best.store]?.name}</strong></span>
              <span class="winner-price-big">${fmtUnitScaled(best.unit_price, best.unit, state.unitScale, best.protein_price)}</span>
              <span class="small-muted">(${fmtClp(best.price)} el envase de ${best.format_label || "1 " + best.unit})</span>
            </div>
            ${
              item.maxSavingsPct > 0
                ? `<span class="savings-badge">Ahorras hasta ${item.maxSavingsPct}% por ${best.unit === "kg" ? "kilo" : best.unit === "lt" ? "litro" : "unidad"}</span>`
                : ""
            }
          </div>
        `
        : `<div class="small-muted">Sin mediciones disponibles aún. Pulsa Actualizar.</div>`;

      // Detección de Reduflación en cualquiera de los supermercados
      const shrinkflations = Object.entries(varMap)
        .filter(([_, st]) => st.shrinkflation?.detected)
        .map(
          ([sId, st]) => `
          <div class="shrinkflation-pill" style="margin-bottom:0.5rem;">
            ⚠️ <strong>${STORE_META[sId]?.name || sId}</strong> redujo el envase de <strong>${st.shrinkflation.originalFormat}</strong> a <strong>${st.shrinkflation.currentFormat}</strong> (Reduflación detectada)
          </div>
        `
        )
        .join("");

      const pinnedCount = (item.pinnedProducts || []).length;

      return `
        <article class="tracked-card">
          <div class="tracked-card-top">
            <div>
              <span class="category-pill">${item.category || "Despensa"}</span>
              <div class="tracked-card-title">${item.title}</div>
              <div class="tracked-query-sub">
                🔍 Búsqueda auto: <code>${item.search_query || "Solo fijados"}</code>
                ${pinnedCount > 0 ? ` · 📌 ${pinnedCount} fijado(s)` : ""}
              </div>
            </div>
            <div style="display:flex; gap:0.4rem;">
              <button class="btn btn-accent btn-sm btn-add-tracked-to-cart" data-id="${item.id}" title="Añadir al Carrito de Compra">
                🛒 + Al Carrito
              </button>
              <button class="btn btn-secondary btn-sm btn-view-history" data-id="${item.id}" title="Ver curva histórica de variabilidad">
                📈 Historial (${item.totalSnapshots})
              </button>
              <button class="btn btn-secondary btn-sm btn-refresh-one" data-id="${item.id}" title="Consultar precios en vivo ahora">
                🔄
              </button>
              <button class="btn btn-danger-ghost btn-delete-one" data-id="${item.id}" title="Eliminar seguimiento">
                🗑️
              </button>
            </div>
          </div>

          ${winnerHtml}
          ${shrinkflations}

          <div class="store-rows">
            ${storeRowsHtml}
          </div>

          <div class="tracked-card-footer">
            <span class="small-muted">Última medición: ${fmtDateShort(item.last_checked_at)}</span>
            <button class="btn btn-secondary btn-sm btn-quick-search-item" data-q="${item.search_query || item.title}">
              🔍 Ver todas las marcas y formatos
            </button>
          </div>
        </article>
      `;
    })
    .join("");

  // Eventos de las tarjetas
  grid.querySelectorAll(".btn-add-tracked-to-cart").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = state.trackedItems.find((i) => i.id === Number(btn.dataset.id));
      const activeCart = getActiveCart();
      if (!item || !activeCart) return;

      btn.disabled = true;
      btn.textContent = "⏳...";
      try {
        const res = await fetch(`/api/carts/${activeCart.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: item.title,
            searchQuery: item.search_query || item.title,
            quantity: 1,
            preferredUnit: item.preferred_unit || "auto",
          }),
        });
        const data = await res.json();
        if (data.carts) state.carts = data.carts;
        renderAll();
        showToast(`"${item.title}" añadido a ${activeCart.name}.`);
      } finally {
        btn.disabled = false;
        btn.textContent = "🛒 + Al Carrito";
      }
    });
  });

  grid.querySelectorAll(".btn-view-history").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedHistoryItemId = Number(btn.dataset.id);
      renderHistorySection();
      document.getElementById("historySection").scrollIntoView({ behavior: "smooth" });
    });
  });

  grid.querySelectorAll(".btn-refresh-one").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      btn.disabled = true;
      btn.textContent = "⏳";
      try {
        await fetch(`/api/tracked/${id}/refresh`, { method: "POST" });
        await loadTrackedData();
        showToast("Precios actualizados y registrados en el historial.");
      } catch (e) {
        showToast("Error al actualizar: " + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "🔄";
      }
    });
  });

  grid.querySelectorAll(".btn-delete-one").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      await fetch(`/api/tracked/${id}`, { method: "DELETE" });
      await loadTrackedData();
      showToast("Producto eliminado del seguimiento.");
    });
  });

  grid.querySelectorAll(".btn-quick-search-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = btn.dataset.q;
      switchTab("tab-search");
      document.getElementById("liveSearchInput").value = q;
      executeLiveSearch(q);
    });
  });
}

// --- 3. Renderizar Gráfico de Variabilidad e Historial ---

function renderHistorySection() {
  const select = document.getElementById("historyProductSelect");
  if (!select) return;

  select.innerHTML = state.trackedItems
    .map(
      (it) =>
        `<option value="${it.id}" ${
          it.id === state.selectedHistoryItemId ? "selected" : ""
        }>${it.title}</option>`
    )
    .join("");

  const item = state.trackedItems.find((i) => i.id === state.selectedHistoryItemId);
  if (!item) return;

  const isUnitMode = state.chartMode === "unit";
  const sampleSnap = Object.values(item.latestByStore || {})[0];
  const unitName = sampleSnap?.unit === "kg" ? "kg" : sampleSnap?.unit === "lt" ? "L" : "un";

  document.getElementById("historyTitle").textContent = `${item.title} — Evolución de ${
    isUnitMode ? `Precio por Unidad ($/${unitName})` : "Precio Total ($)"
  }`;

  const history = item.history || [];
  const dateBuckets = [];
  const dateSet = new Set();

  for (const snap of history) {
    const key = snap.recorded_at.slice(0, 16);
    if (!dateSet.has(key)) {
      dateSet.add(key);
      dateBuckets.push(key);
    }
  }
  dateBuckets.sort();

  const labels = dateBuckets.map((k) => fmtDateShort(k + ":00Z"));
  const datasets = [];

  for (const storeId of STORE_ORDER) {
    const storeSnaps = history.filter((s) => s.store === storeId);
    if (storeSnaps.length === 0) continue;

    const pointsByBucket = {};
    for (const s of storeSnaps) {
      const k = s.recorded_at.slice(0, 16);
      pointsByBucket[k] = isUnitMode ? s.unit_price : s.price;
    }

    const dataPoints = dateBuckets.map((k) => pointsByBucket[k] ?? null);
    datasets.push({
      label: STORE_META[storeId]?.name || storeId,
      data: dataPoints,
      borderColor: STORE_META[storeId]?.color || "#38bdf8",
      backgroundColor: STORE_META[storeId]?.color || "#38bdf8",
      tension: 0.25,
      spanGaps: true,
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 2.5,
    });
  }

  const chartCanvas = document.getElementById("priceHistoryChart");
  if (chartCanvas) {
    const ctx = chartCanvas.getContext("2d");
    if (historyChartInstance) {
      historyChartInstance.destroy();
    }

    historyChartInstance = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            labels: { color: "#e2e8f0", font: { family: "Inter", weight: "600" } },
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                const val = context.parsed.y;
                if (val === null || val === undefined) return "";
                return `${context.dataset.label}: ${fmtClp(val)}${isUnitMode ? ` / ${unitName}` : ""}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#94a3b8" },
            grid: { color: "rgba(148, 163, 184, 0.1)" },
          },
          y: {
            ticks: {
              color: "#94a3b8",
              callback: (val) => "$" + Number(val).toLocaleString("es-CL"),
            },
            grid: { color: "rgba(148, 163, 184, 0.12)" },
          },
        },
      },
    });
  }

  // Tabla de estadísticas de variabilidad con Semáforo
  const tbodyVar = document.querySelector("#variabilityStatsTable tbody");
  const varMap = item.variabilityByStore || {};
  const latestMap = item.latestByStore || {};

  if (tbodyVar) {
    tbodyVar.innerHTML = STORE_ORDER.map((storeId) => {
      const st = varMap[storeId];
      const snap = latestMap[storeId];
      if (!st || !snap) return "";

      const dPrev = st.deltaPrevPct;

      return `
        <tr>
          <td><span class="store-badge store-${storeId}">${STORE_META[storeId]?.name}</span></td>
          <td>
            <span class="signal-pill signal-${st.signal || "normal"}" title="${st.signalExplanation || ""}">
              ${st.signalLabel || "🟡 Habitual"}
            </span>
          </td>
          <td><strong>${fmtUnitScaled(snap.unit_price, snap.unit, state.unitScale, snap.protein_price)}</strong> <span class="small-muted">(${fmtClp(snap.price)})</span></td>
          <td>${fmtUnitScaled(st.minUnitPrice, snap.unit, state.unitScale)}</td>
          <td>${fmtUnitScaled(st.maxUnitPrice, snap.unit, state.unitScale)}</td>
          <td>${fmtUnitScaled(st.avgUnitPrice, snap.unit, state.unitScale)}</td>
          <td><strong>${st.volatilityPct}%</strong> (${st.observations} med.)</td>
          <td>
            <span class="delta-pill ${dPrev < 0 ? "delta-down" : dPrev > 0 ? "delta-up" : "delta-same"}">
              ${dPrev > 0 ? "+" : ""}${dPrev}%
            </span>
          </td>
        </tr>
      `;
    })
      .filter(Boolean)
      .join("");
  }

  const snapCountLabel = document.getElementById("snapshotCountLabel");
  if (snapCountLabel) snapCountLabel.textContent = String(history.length);

  const tbodySnaps = document.querySelector("#snapshotsLogTable tbody");
  if (tbodySnaps) {
    const reversedHistory = [...history].reverse();
    tbodySnaps.innerHTML = reversedHistory
      .slice(0, 60)
      .map(
        (s) => `
        <tr>
          <td>${fmtDateShort(s.recorded_at)}</td>
          <td><span class="store-badge store-${s.store}">${STORE_META[s.store]?.name || s.store}</span></td>
          <td><a href="${s.product_url || "#"}" target="_blank" rel="noopener" style="color:#f1f5f9;">${s.product_name}</a></td>
          <td>${s.format_label || `1 ${s.unit}`}</td>
          <td><strong>${fmtClp(s.price)}</strong></td>
          <td style="color:#34d399; font-weight:700;">${fmtClp(s.unit_price)} / ${s.unit === "lt" ? "L" : s.unit}</td>
          <td>${fmtClp(s.price_per_100)} / ${s.unit === "kg" ? "100g" : s.unit === "lt" ? "100ml" : "un"}</td>
          <td>${s.promo_text || "—"}</td>
        </tr>
      `
      )
      .join("");
  }
}

// --- 4. Generador y Comparador de Carritos de Compra ---

function renderBasketComparison() {
  const cartSelect = document.getElementById("activeCartSelect");
  const criteriaSelect = document.getElementById("cartCriteriaSelect");
  const strategiesGrid = document.getElementById("cartStrategiesGrid");
  const summaryGrid = document.getElementById("basketSummaryCards");
  const tbody = document.querySelector("#basketComparisonTable tbody");
  const roadmapGrid = document.getElementById("splitCartRoadmapGrid");

  if (!cartSelect) return;

  cartSelect.innerHTML = state.carts
    .map(
      (c) =>
        `<option value="${c.id}" ${
          c.id === state.activeCartId ? "selected" : ""
        }>${c.name} (${c.items.length} prod.)</option>`
    )
    .join("");

  const cart = getActiveCart();
  if (!cart) {
    if (strategiesGrid) strategiesGrid.innerHTML = `<div class="empty-state">Crea un carrito para empezar a comparar precios.</div>`;
    if (summaryGrid) summaryGrid.innerHTML = "";
    if (tbody) tbody.innerHTML = "";
    if (roadmapGrid) roadmapGrid.innerHTML = "";
    return;
  }

  criteriaSelect.value = cart.criteria || "unit_price";

  // Sincronizar controles de fricción y tarjetas del carrito
  const chkFriction = document.getElementById("cartEnableFriction");
  const numDelivery = document.getElementById("cartDeliveryCost");
  const numFreeThresh = document.getElementById("cartFreeDeliveryThreshold");
  const selDayOfWeek = document.getElementById("cartDayOfWeekSelect");

  if (chkFriction) chkFriction.checked = cart.enableFriction !== false;
  if (numDelivery) numDelivery.value = cart.deliveryCost ?? 3500;
  if (numFreeThresh) numFreeThresh.value = cart.freeDeliveryThreshold ?? 35000;
  if (selDayOfWeek) selDayOfWeek.value = String(cart.dayOfWeek ?? -1);

  const programsWrap = document.getElementById("cartProgramsCheckboxes");
  if (programsWrap) {
    const activePrograms = new Set(cart.activePrograms || []);
    programsWrap.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = activePrograms.has(cb.value);
    });
  }

  // Renderizar Veredicto de Fricción
  const frictionBox = document.getElementById("cartFrictionVerdictBox");
  if (frictionBox) {
    if (cart.frictionVerdictMsg) {
      frictionBox.style.display = "block";
      frictionBox.className =
        "friction-verdict-banner " +
        (cart.frictionVerdict === "split_cheaper" ? "split-cheaper" : "single-cheaper");
      frictionBox.innerHTML = cart.frictionVerdictMsg;
    } else {
      frictionBox.style.display = "none";
    }
  }

  if (cart.items.length === 0) {
    if (strategiesGrid)
      strategiesGrid.innerHTML = `<div class="empty-state">Tu carrito está vacío. Agrega productos arriba para ver dónde es más barato.</div>`;
    if (summaryGrid) summaryGrid.innerHTML = "";
    if (tbody)
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;" class="small-muted">Sin productos en este carrito aún.</td></tr>`;
    if (roadmapGrid) roadmapGrid.innerHTML = "";
    return;
  }

  // 1. Renderizar las 3 Estrategias de Compra
  const winSingle = cart.winnerSingleStore;
  const twoCombo = cart.bestTwoCombo;
  const split = cart.optimalSplitCart;

  if (strategiesGrid) {
    const netSingle = winSingle?.netTotalClp ?? winSingle?.totalClp;
    const netSplit = split.netTotalClp ?? split.totalClp;

    strategiesGrid.innerHTML = `
      <div class="strategy-card winner-single">
        <div class="strategy-tag" style="color:#60a5fa;">🥇 OPCIÓN 1: COMPRAR TODO EN 1 SOLO LUGAR</div>
        <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.2rem;">
          ${winSingle ? `<span class="store-badge store-${winSingle.store}">${winSingle.storeName}</span>` : ""}
          <span class="strategy-price">${winSingle ? fmtClp(netSingle) : "—"}</span>
        </div>
        <div class="small-muted" style="margin-top:0.25rem;">
          ${
            winSingle
              ? `Cubre ${winSingle.foundCount} de ${winSingle.totalItemsCount} productos. ${
                  winSingle.deliveryFee > 0
                    ? `(${fmtClp(winSingle.totalClp)} prod. + ${fmtClp(winSingle.deliveryFee)} despacho).`
                    : `(${fmtClp(winSingle.totalClp)} prod. · Despacho Gratis).`
                } ${
                  cart.singleStoreMaxSavingsClp > 0
                    ? `<br/><strong style="color:#34d399;">Ahorras ${fmtClp(cart.singleStoreMaxSavingsClp)}</strong> vs el supermercado más caro.`
                    : ""
                }`
              : "Sin datos"
          }
        </div>
      </div>

      <div class="strategy-card">
        <div class="strategy-tag" style="color:#fbbf24;">🥈 OPCIÓN 2: COMBINAR MÁXIMO 2 SUPERMERCADOS</div>
        <div class="strategy-price">${twoCombo ? fmtClp(twoCombo.totalClp) : "—"}</div>
        <div class="small-muted" style="margin-top:0.25rem;">
          ${
            twoCombo
              ? `Comprando en <strong>${twoCombo.storeNames}</strong> (${twoCombo.foundCount} productos). ${
                  winSingle && winSingle.totalClp > twoCombo.totalClp
                    ? `Ahorras <strong>${fmtClp(winSingle.totalClp - twoCombo.totalClp)} extra</strong> en productos vs ir a 1 sola tienda.`
                    : "Mismo costo de productos que ir a 1 tienda."
                }`
              : "Requiere al menos 2 tiendas con stock."
          }
        </div>
      </div>

      <div class="strategy-card winner-split">
        <div class="strategy-tag" style="color:#34d399;">🏆 OPCIÓN 3: COMPRA DIVIDIDA ÓPTIMA (${split.storesUsedCount} TIENDAS)</div>
        <div class="strategy-price" style="color:#34d399;">${fmtClp(netSplit)}</div>
        <div class="small-muted" style="margin-top:0.25rem;">
          Comprar cada producto en su supermercado más barato.
          <br/>
          <span>(${fmtClp(split.totalClp)} en productos ${
            split.deliveryFeesClp > 0 ? `+ ${fmtClp(split.deliveryFeesClp)} en ${split.storesUsedCount} despachos` : ""
          })</span>
          ${
            split.savingsVsBestSingleClp > 0
              ? `<br/><strong style="color:#34d399;">Ahorras ${fmtClp(split.savingsVsBestSingleClp)} netos</strong> frente a comprar todo en ${winSingle?.storeName}.`
              : `<br/><span>No compensa dividir pedidos frente al mejor supermercado único.</span>`
          }
        </div>
      </div>
    `;
  }

  // 2. Renderizar el Ranking de todos los supermercados (Todo en 1 lugar con Despacho y Tarjetas)
  if (summaryGrid) {
    summaryGrid.innerHTML = cart.singleStoreRanking
      .map((st, idx) => {
        const isWinner = idx === 0;
        const netTotal = st.netTotalClp || st.totalClp;

        return `
          <div class="basket-store-card ${isWinner ? "optimal" : ""}">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span class="store-badge store-${st.store}">${st.storeName}</span>
              ${
                isWinner
                  ? `<span class="savings-badge">🥇 #1 MÁS BARATO</span>`
                  : `<span class="delta-pill delta-up">+${fmtClp(st.diffVsWinnerClp)} (+${st.diffVsWinnerPct}%)</span>`
              }
            </div>
            <div class="kpi-value" style="margin-top:0.45rem;">
              ${fmtClp(netTotal)}
            </div>
            <div class="kpi-sub" style="margin-top:0.25rem;">
              <span>📦 Productos: <strong>${fmtClp(st.totalClp)}</strong></span>
              ${
                st.deliveryFee > 0
                  ? ` · 🚚 Despacho: <strong>${fmtClp(st.deliveryFee)}</strong>`
                  : ` · <span style="color:#34d399; font-weight:700;">🚚 Despacho GRATIS</span>`
              }
              <br/>
              ✅ ${st.foundCount} de ${st.totalItemsCount} productos disponibles
              ${
                st.cardSavingsClp > 0
                  ? `<br/><span style="color:#60a5fa; font-weight:700;">💳 Ahorras ${fmtClp(st.cardSavingsClp)} con tus tarjetas/día</span>`
                  : ""
              }
              ${
                st.offerSavingsClp > 0
                  ? `<br/><span style="color:#34d399;">🏷️ Incluye ${fmtClp(st.offerSavingsClp)} de ahorro en promociones</span>`
                  : ""
              }
            </div>
          </div>
        `;
      })
      .join("");
  }

  // 3. Renderizar Tabla Interactiva de Ítems del Carrito
  if (tbody) {
    tbody.innerHTML = cart.items
      .map((item) => {
        const bestStore = item.bestStore;
        const bestOffer = item.bestOffer;

        const storeCellsHtml = CART_TABLE_STORES.map((storeId) => {
          const offer = item.storeOffers[storeId];
          if (!offer) {
            return `<td class="small-muted">—</td>`;
          }

          const isBest = bestStore === storeId;
          const p = offer.product;
          const candidates = offer.candidates || [];

          const selectorHtml =
            candidates.length > 1
              ? `
                <select class="cart-candidate-select" data-item-id="${item.id}" data-store="${storeId}" title="Cambiar marca o formato en ${STORE_META[storeId].name}">
                  ${candidates
                    .map(
                      (c) => `
                      <option value="${c.externalId}" ${
                        String(c.externalId) === String(p.externalId) ? "selected" : ""
                      }>
                        ${c.name.slice(0, 34)} (${fmtClp(c.price)} · ${fmtUnitScaled(c.unitPrice, c.unit, state.unitScale, c.pricePer10gProtein)})
                      </option>
                    `
                    )
                    .join("")}
                </select>
              `
              : "";

          return `
            <td style="${isBest ? "background:rgba(16,185,129,0.11); border-left:2px solid #10b981;" : ""}">
              <div style="font-size:0.98rem; font-weight:800; color:${isBest ? "#34d399" : "#f8fafc"};">
                ${fmtClp(offer.lineTotal)}
                ${
                  item.quantity > 1
                    ? `<span class="small-muted" style="font-weight:400;">(${item.quantity} × ${fmtClp(offer.effectivePackagePrice)})</span>`
                    : ""
                }
              </div>
              <div style="font-size:0.78rem; font-weight:600; color:#94a3b8;">
                ${fmtUnitScaled(p.unitPrice, p.unit, state.unitScale, p.pricePer10gProtein)} · 📦 ${p.formatLabel}
              </div>
              <div style="margin-top:0.2rem;">
                <a href="${p.url || "#"}" target="_blank" rel="noopener" style="color:#cbd5e1; font-size:0.76rem; text-decoration:none;">
                  ${p.name.slice(0, 42)}
                </a>
              </div>
              ${
                offer.appliedPromo
                  ? `<div style="font-size:0.7rem; color:#fbbf24; font-weight:700;">🏷️ Promo aplicada: ${offer.promoText}</div>`
                  : ""
              }
              ${selectorHtml}
            </td>
          `;
        }).join("");

        return `
          <tr>
            <td>
              <div style="font-weight:700; font-size:0.92rem;">${item.label}</div>
              <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.3rem;">
                <div class="qty-stepper">
                  <button type="button" class="btn-qty-minus" data-item-id="${item.id}" data-qty="${item.quantity}">−</button>
                  <span>${item.quantity} un.</span>
                  <button type="button" class="btn-qty-plus" data-item-id="${item.id}" data-qty="${item.quantity}">+</button>
                </div>
                <button type="button" class="btn btn-danger-ghost btn-remove-cart-item" data-item-id="${item.id}" title="Quitar del carrito">
                  🗑️
                </button>
              </div>
            </td>
            ${storeCellsHtml}
            <td>
              ${
                bestOffer
                  ? `
                    <span class="store-badge store-${bestStore}">${STORE_META[bestStore]?.name}</span>
                    <div style="font-weight:800; color:#34d399; margin-top:0.25rem;">
                      ${fmtClp(bestOffer.lineTotal)}
                    </div>
                    <div class="small-muted">${fmtUnitScaled(bestOffer.product.unitPrice, bestOffer.product.unit, state.unitScale, bestOffer.product.pricePer10gProtein)}</div>
                    ${
                      item.maxItemSavingsClp > 0
                        ? `<div style="font-size:0.72rem; color:#10b981;">Ahorras ${fmtClp(item.maxItemSavingsClp)} en esta línea</div>`
                        : ""
                    }
                  `
                  : "—"
              }
            </td>
          </tr>
        `;
      })
      .join("");

    // Eventos de cantidad (- / +), eliminación y cambio de marca en el carrito
    tbody.querySelectorAll(".btn-qty-minus").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const itemId = Number(btn.dataset.itemId);
        const currentQty = Number(btn.dataset.qty);
        if (currentQty <= 1) return;
        const res = await fetch(`/api/carts/${cart.id}/items/${itemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity: currentQty - 1 }),
        });
        const data = await res.json();
        if (data.carts) state.carts = data.carts;
        renderAll();
      });
    });

    tbody.querySelectorAll(".btn-qty-plus").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const itemId = Number(btn.dataset.itemId);
        const currentQty = Number(btn.dataset.qty);
        const res = await fetch(`/api/carts/${cart.id}/items/${itemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity: currentQty + 1 }),
        });
        const data = await res.json();
        if (data.carts) state.carts = data.carts;
        renderAll();
      });
    });

    tbody.querySelectorAll(".btn-remove-cart-item").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const itemId = Number(btn.dataset.itemId);
        const res = await fetch(`/api/carts/${cart.id}/items/${itemId}`, {
          method: "DELETE",
        });
        const data = await res.json();
        if (data.carts) state.carts = data.carts;
        renderAll();
        showToast("Producto quitado del carrito.");
      });
    });

    tbody.querySelectorAll(".cart-candidate-select").forEach((sel) => {
      sel.addEventListener("change", async () => {
        const itemId = Number(sel.dataset.itemId);
        const store = sel.dataset.store;
        const externalId = sel.value;
        const res = await fetch(`/api/carts/${cart.id}/items/${itemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selectStore: store, selectExternalId: externalId }),
        });
        const data = await res.json();
        if (data.carts) state.carts = data.carts;
        renderAll();
        showToast(`Marca actualizada en ${STORE_META[store].name}.`);
      });
    });
  }

  // 4. Renderizar Hoja de Ruta de Compra Dividida por Supermercado
  if (roadmapGrid) {
    roadmapGrid.innerHTML = (split.byStore || [])
      .map(
        (group) => `
        <div class="roadmap-store-card">
          <div class="roadmap-store-head">
            <span class="store-badge store-${group.store}">${group.storeName} (${group.items.length} prod.)</span>
            <strong style="font-size:1.05rem; color:#34d399;">Subtotal: ${fmtClp(group.subtotalClp)}</strong>
          </div>
          <ul class="roadmap-item-list">
            ${group.items
              .map(
                (it) => `
                <li>
                  <div>
                    <strong>${it.quantity}×</strong>
                    <a href="${it.url || "#"}" target="_blank" rel="noopener" style="color:#f1f5f9;">
                      ${it.productName}
                    </a>
                    <span class="small-muted">(${fmtUnitScaled(it.unitPrice, it.unit, state.unitScale, it.pricePer10gProtein)})</span>
                  </div>
                  <strong style="white-space:nowrap;">${fmtClp(it.lineTotal)}</strong>
                </li>
              `
              )
              .join("")}
          </ul>
        </div>
      `
      )
      .join("");
  }
}

// --- 5. Buscador y Comparador en Vivo ---

async function executeLiveSearch(query) {
  const q = query.trim();
  if (!q) return;

  state.liveSearchQuery = q;
  const container = document.getElementById("searchResultsContainer");
  const statusBar = document.getElementById("searchStoreStatusBar");
  const btnSearch = document.getElementById("btnRunSearch");
  const btnTrack = document.getElementById("btnTrackCurrentSearch");
  const trapsBanner = document.getElementById("searchPackTrapsBanner");

  if (btnSearch) {
    btnSearch.disabled = true;
    btnSearch.textContent = "⏳ Consultando supermercados...";
  }
  if (container) {
    container.innerHTML = `<div class="loading-state">Consultando catálogos en vivo de Jumbo, Santa Isabel, Unimarc y Tottus para <strong>"${q}"</strong>...</div>`;
  }
  if (trapsBanner) trapsBanner.style.display = "none";

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=18`);
    const data = await res.json();
    state.liveSearchResults = data.products || [];
    state.liveSearchPackTraps = data.packTraps || [];
    state.liveStoreStatus = data.storeStatus || {};
    if (btnTrack) btnTrack.style.display = "inline-flex";

    if (statusBar) {
      statusBar.innerHTML = Object.entries(state.liveStoreStatus)
        .map(([storeId, st]) => {
          const name = STORE_META[storeId]?.name || storeId;
          if (st.ok) {
            return `<span class="status-chip">✅ <strong>${name}</strong>: ${st.count} productos (${st.ms} ms)</span>`;
          }
          return `<span class="status-chip" style="border-color:#ef4444;">⚠️ <strong>${name}</strong>: ${st.error}</span>`;
        })
        .join("");
    }

    renderLiveSearchResults();
  } catch (err) {
    if (container) {
      container.innerHTML = `<div class="empty-state">Error al buscar: ${err.message}</div>`;
    }
  } finally {
    if (btnSearch) {
      btnSearch.disabled = false;
      btnSearch.textContent = "🔍 Comparar Ahora";
    }
  }
}

function renderLiveSearchResults() {
  const container = document.getElementById("searchResultsContainer");
  const sortMode = document.getElementById("searchSortSelect").value;
  const unitFilter = document.getElementById("searchUnitFilter").value;
  const storeFilter = document.getElementById("searchStoreFilter").value;
  const trapsBanner = document.getElementById("searchPackTrapsBanner");

  // Mostrar u ocultar alerta de Falsos Packs Ahorro
  if (trapsBanner) {
    if (state.liveSearchPackTraps && state.liveSearchPackTraps.length > 0) {
      trapsBanner.style.display = "block";
      trapsBanner.innerHTML = `
        <div class="pack-traps-banner">
          <div style="font-weight:800; font-size:0.95rem; color:#fef08a;">
            🚨 ¡Alerta de Falsos Packs Ahorro Detectados (${state.liveSearchPackTraps.length})!
          </div>
          ${state.liveSearchPackTraps
            .map(
              (t) => `
            <div class="pack-trap-item">
              <span>${t.message}</span>
            </div>
          `
            )
            .join("")}
        </div>
      `;
    } else {
      trapsBanner.style.display = "none";
    }
  }

  let filtered = [...state.liveSearchResults];

  if (unitFilter !== "all") {
    filtered = filtered.filter((p) => p.unit === unitFilter);
  }
  if (storeFilter !== "all") {
    filtered = filtered.filter((p) => p.store === storeFilter);
  }

  if (filtered.length === 0) {
    if (container) {
      container.innerHTML = `<div class="empty-state">No hay productos que coincidan con los filtros seleccionados.</div>`;
    }
    return;
  }

  filtered.sort((a, b) => {
    if (sortMode === "unit_asc") return a.unitPrice - b.unitPrice;
    if (sortMode === "protein_asc") {
      return (a.pricePer10gProtein || 9999999) - (b.pricePer10gProtein || 9999999);
    }
    if (sortMode === "effective_unit_asc")
      return (a.effectiveUnitPrice ?? a.unitPrice) - (b.effectiveUnitPrice ?? b.unitPrice);
    if (sortMode === "price_asc") return a.price - b.price;
    if (sortMode === "discount_desc") {
      const da = a.listPrice ? (a.listPrice - a.price) / a.listPrice : 0;
      const db = b.listPrice ? (b.listPrice - b.price) / b.listPrice : 0;
      return db - da;
    }
    return (b.relevance || 0) - (a.relevance || 0);
  });

  const bestUnitPrice = Math.min(...filtered.map((p) => p.unitPrice));

  if (container) {
    container.innerHTML = filtered
      .map((p, idx) => {
        const isBest = p.unitPrice === bestUnitPrice;
        const discountPct =
          p.listPrice && p.listPrice > p.price
            ? Math.round(((p.listPrice - p.price) / p.listPrice) * 100)
            : 0;

        const uLabel = p.unit === "kg" ? "kg" : p.unit === "lt" ? "L" : "un";
        const smallLabel = p.unit === "kg" ? "g" : p.unit === "lt" ? "ml" : "un";
        const per100Label = p.unit === "kg" ? "100g" : p.unit === "lt" ? "100ml" : "un";

        const proteinHtml = p.hasProteinData
          ? `
            <div class="protein-tag" title="Estimación nutricional basada en contenido proteico estándar">
              🥩 <strong>${fmtClp(p.pricePer10gProtein)}</strong> / 10g proteína
              <span style="font-weight:400; opacity:0.85;">(${p.proteinGramsTotal}g totales en envase · ${p.proteinPer100g}g/100g)</span>
            </div>
          `
          : "";

        return `
          <div class="product-card ${isBest ? "best-unit-deal" : ""}">
            <div>
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.55rem;">
                <span class="store-badge store-${p.store}">${p.storeName}</span>
                ${isBest ? `<span class="best-deal-ribbon">🏆 MEJOR $/UNIDAD</span>` : ""}
                ${!isBest && discountPct > 0 ? `<span class="savings-badge">-${discountPct}%</span>` : ""}
              </div>

              <div class="product-card-head">
                ${
                  p.imageUrl
                    ? `<img src="${p.imageUrl}" alt="${p.name}" class="product-thumb" loading="lazy" />`
                    : `<div class="product-thumb" style="display:flex;align-items:center;justify-content:center;color:#000;">🛒</div>`
                }
                <div>
                  <a href="${p.url || "#"}" target="_blank" rel="noopener" class="product-title" title="${p.name}">
                    ${p.name}
                  </a>
                  <div class="product-brand-format">
                    ${p.brand ? `<strong>${p.brand}</strong> · ` : ""}📦 Formato: <strong>${p.formatLabel}</strong>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div class="unit-price-box">
                <div style="display:flex; justify-content:space-between; align-items:baseline;">
                  <span class="small-muted">Precio por ${uLabel}:</span>
                  <span class="unit-price-big">${fmtUnitScaled(p.unitPrice, p.unit, state.unitScale, p.pricePer10gProtein)}</span>
                </div>
                ${
                  p.unit === "kg" || p.unit === "lt"
                    ? `
                    <div class="unit-Breakdown-row">
                      <span>Por ${per100Label}: <strong>${fmtClp(p.pricePer100)}</strong></span>
                      <span>Por 1 ${smallLabel}: <strong>$${p.pricePerSmallUnit}</strong></span>
                    </div>
                  `
                    : ""
                }
                ${
                  p.effectiveUnitPrice && p.effectiveUnitPrice < p.unitPrice
                    ? `<div class="unit-Breakdown-row" style="color:#fbbf24; font-weight:700;">
                        <span>🏷️ Con Promo (${p.promoText}):</span>
                        <span>${fmtClp(p.effectiveUnitPrice)} / ${uLabel}</span>
                      </div>`
                    : ""
                }
                ${proteinHtml}
              </div>

              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.65rem; gap:0.4rem;">
                <div>
                  <div class="small-muted">Precio envase:</div>
                  <div style="font-size:1.05rem; font-weight:800;">
                    ${fmtClp(p.price)}
                    ${p.listPrice ? `<span class="crossed-price" style="font-size:0.8rem;">${fmtClp(p.listPrice)}</span>` : ""}
                  </div>
                </div>

                <div style="display:flex; gap:0.35rem;">
                  <button class="btn btn-accent btn-sm btn-add-search-to-cart" data-idx="${idx}" title="Agregar al carrito activo">
                    🛒 + Carrito
                  </button>
                  <button class="btn btn-secondary btn-sm btn-pin-result" data-idx="${idx}" title="Fijar en seguimiento histórico">
                    📌 Fijar
                  </button>
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    container.querySelectorAll(".btn-add-search-to-cart").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const prod = filtered[Number(btn.dataset.idx)];
        const activeCart = getActiveCart();
        if (!prod || !activeCart) return;

        btn.disabled = true;
        btn.textContent = "⏳...";
        try {
          const res = await fetch(`/api/carts/${activeCart.id}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              label: state.liveSearchQuery || prod.name,
              searchQuery: state.liveSearchQuery || prod.name,
              quantity: 1,
              preferredUnit: prod.unit || "auto",
              initialProduct: prod,
            }),
          });
          const data = await res.json();
          if (data.carts) state.carts = data.carts;
          renderAll();
          showToast(`"${prod.name.slice(0, 30)}..." agregado al carrito.`);
        } finally {
          btn.disabled = false;
          btn.textContent = "🛒 + Carrito";
        }
      });
    });

    container.querySelectorAll(".btn-pin-result").forEach((btn) => {
      btn.addEventListener("click", () => {
        const prod = filtered[Number(btn.dataset.idx)];
        openPinModal(prod);
      });
    });
  }
}

// --- 6. Renderizar Sección IPC Personal ---

async function renderIpcSection() {
  try {
    const res = await fetch("/api/ipc");
    const data = await res.json();
    state.ipcData = data;

    const rateEl = document.getElementById("ipcBasketRate");
    const worstEl = document.getElementById("ipcWorstStore");
    const worstSub = document.getElementById("ipcWorstStoreSub");
    const bestEl = document.getElementById("ipcBestStore");
    const bestSub = document.getElementById("ipcBestStoreSub");

    if (rateEl) {
      const sign = data.basketInflationPct > 0 ? "+" : "";
      rateEl.textContent = `${sign}${data.basketInflationPct}%`;
      rateEl.style.color = data.basketInflationPct > 0 ? "#f87171" : "#34d399";
    }

    const storeEntries = Object.entries(data.storeInflation || {}).filter(
      ([_, s]) => s.productsEvaluated > 0
    );

    if (storeEntries.length > 0) {
      storeEntries.sort((a, b) => b[1].inflationPct - a[1].inflationPct);
      const worst = storeEntries[0];
      const best = storeEntries[storeEntries.length - 1];

      if (worstEl) {
        worstEl.textContent = STORE_META[worst[0]]?.name || worst[0];
        if (worstSub) {
          worstSub.textContent = `Alza promedio de ${worst[1].inflationPct > 0 ? "+" : ""}${worst[1].inflationPct}% (${worst[1].productsEvaluated} productos)`;
        }
      }

      if (bestEl) {
        bestEl.textContent = STORE_META[best[0]]?.name || best[0];
        if (bestSub) {
          bestSub.textContent = `Variación de ${best[1].inflationPct > 0 ? "+" : ""}${best[1].inflationPct}% (${best[1].productsEvaluated} productos)`;
        }
      }
    }

    // Top Increases
    const incTbody = document.querySelector("#ipcIncreasesTable tbody");
    if (incTbody) {
      if (!data.topIncreases || data.topIncreases.length === 0) {
        incTbody.innerHTML = `<tr><td colspan="4" class="small-muted" style="text-align:center;padding:1.5rem;">No se registran alzas en las últimas mediciones.</td></tr>`;
      } else {
        incTbody.innerHTML = data.topIncreases
          .map(
            (p) => `
            <tr>
              <td><strong>${p.title}</strong></td>
              <td><span class="category-pill">${p.category}</span></td>
              <td><span class="delta-pill delta-up">+${p.changePct}%</span></td>
              <td>${fmtClp(p.currentBest)} / ${p.unit}</td>
            </tr>
          `
          )
          .join("");
      }
    }

    // Top Decreases
    const decTbody = document.querySelector("#ipcDecreasesTable tbody");
    if (decTbody) {
      if (!data.topDecreases || data.topDecreases.length === 0) {
        decTbody.innerHTML = `<tr><td colspan="4" class="small-muted" style="text-align:center;padding:1.5rem;">Aún no hay rebajas significativas registradas.</td></tr>`;
      } else {
        decTbody.innerHTML = data.topDecreases
          .map(
            (p) => `
            <tr>
              <td><strong>${p.title}</strong></td>
              <td><span class="category-pill">${p.category}</span></td>
              <td><span class="delta-pill delta-down">${p.changePct}%</span></td>
              <td>${fmtClp(p.currentBest)} / ${p.unit}</td>
            </tr>
          `
          )
          .join("");
      }
    }

    // Stores Inflation Table
    const storeTbody = document.querySelector("#ipcStoreTable tbody");
    if (storeTbody) {
      storeTbody.innerHTML = STORE_ORDER.map((sId) => {
        const sInfo = data.storeInflation?.[sId];
        if (!sInfo) return "";
        const infl = sInfo.inflationPct ?? 0;
        const pillClass = infl > 0 ? "delta-up" : infl < 0 ? "delta-down" : "delta-same";
        const sign = infl > 0 ? "+" : "";

        let behavior = "Estable";
        if (infl >= 5) behavior = "🔴 Fuerte incremento de precios";
        else if (infl > 0) behavior = "🟠 Leve incremento";
        else if (infl <= -5) behavior = "🟢 Marcada baja / promociones";
        else if (infl < 0) behavior = "🟢 Leve baja";

        return `
          <tr>
            <td><span class="store-badge store-${sId}">${STORE_META[sId]?.name}</span></td>
            <td><span class="delta-pill ${pillClass}"><strong>${sign}${infl}%</strong></span></td>
            <td>${sInfo.productsEvaluated} productos</td>
            <td>${behavior}</td>
          </tr>
        `;
      })
        .filter(Boolean)
        .join("");
    }
  } catch (err) {
    console.error("Error al cargar IPC:", err);
  }
}

// --- 7. Carga y Gestión de Ajustes de Telegram ---

async function loadTelegramSettings() {
  try {
    const res = await fetch("/api/telegram");
    const data = await res.json();
    state.telegramSettings = data;

    const tokenInput = document.getElementById("teleTokenInput");
    const chatIdInput = document.getElementById("teleChatIdInput");
    const threshInput = document.getElementById("teleThresholdInput");
    const enabledInput = document.getElementById("teleEnabledInput");

    if (tokenInput && data.token) tokenInput.value = data.token;
    if (chatIdInput && data.chatId) chatIdInput.value = data.chatId;
    if (threshInput && data.thresholdPct) threshInput.value = data.thresholdPct;
    if (enabledInput) enabledInput.checked = Boolean(data.enabled);
  } catch (err) {
    console.warn("No se pudieron cargar los ajustes de Telegram:", err);
  }
}

// --- 8. Guardar Ajustes de Fricción y Tarjetas del Carrito ---

async function saveCartSettings() {
  const cart = getActiveCart();
  if (!cart) return;

  const chkFriction = document.getElementById("cartEnableFriction");
  const numDelivery = document.getElementById("cartDeliveryCost");
  const numFreeThresh = document.getElementById("cartFreeDeliveryThreshold");
  const selDayOfWeek = document.getElementById("cartDayOfWeekSelect");

  const enableFriction = chkFriction ? chkFriction.checked : true;
  const deliveryCost = numDelivery ? Number(numDelivery.value) || 3500 : 3500;
  const freeDeliveryThreshold = numFreeThresh ? Number(numFreeThresh.value) || 35000 : 35000;
  const dayOfWeek = selDayOfWeek ? Number(selDayOfWeek.value) : -1;

  const activePrograms = [];
  document
    .querySelectorAll("#cartProgramsCheckboxes input[type=checkbox]:checked")
    .forEach((cb) => activePrograms.push(cb.value));

  try {
    const res = await fetch(`/api/carts/${cart.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enableFriction,
        deliveryCost,
        freeDeliveryThreshold,
        dayOfWeek,
        activePrograms,
      }),
    });
    const data = await res.json();
    if (data.carts) state.carts = data.carts;
    renderBasketComparison();
    renderKpis();
  } catch (err) {
    showToast("Error guardando ajustes del carrito: " + err.message);
  }
}

// --- 9. Poblar Selectores y Modales ---

function populateSelectDropdowns() {
  const urlSelect = document.getElementById("urlTargetTrackedSelect");
  const manualSelect = document.getElementById("manualTrackedSelect");
  const pinSelect = document.getElementById("pinTargetSelect");

  const optionsHtml = state.trackedItems
    .map((it) => `<option value="${it.id}">${it.title}</option>`)
    .join("");

  if (urlSelect) {
    urlSelect.innerHTML =
      `<option value="new">➕ Crear como nuevo producto seguido</option>` + optionsHtml;
  }
  if (manualSelect) {
    manualSelect.innerHTML = optionsHtml;
  }
  if (pinSelect) {
    pinSelect.innerHTML =
      optionsHtml + `<option value="new">➕ Crear nuevo grupo con este producto</option>`;
  }
}

function openPinModal(product) {
  state.pendingPinProduct = product;
  const preview = document.getElementById("pinProductPreview");
  if (preview) {
    preview.innerHTML = `
      <div><span class="store-badge store-${product.store}">${product.storeName}</span> <strong>${product.name}</strong></div>
      <div style="margin-top:0.3rem;">
        Precio: <strong>${fmtClp(product.price)}</strong> · Por unidad: <strong style="color:#34d399;">${fmtUnitScaled(product.unitPrice, product.unit, state.unitScale, product.pricePer10gProtein)}</strong> (${product.formatLabel})
      </div>
    `;
  }

  const pinSelect = document.getElementById("pinTargetSelect");
  const newWrap = document.getElementById("pinNewTitleWrap");
  const newInput = document.getElementById("pinNewTitleInput");
  if (newInput) newInput.value = state.liveSearchQuery || product.name;

  if (newWrap && pinSelect) newWrap.style.display = pinSelect.value === "new" ? "flex" : "none";
  const modal = document.getElementById("modalPinProduct");
  if (modal) modal.style.display = "flex";
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.id === tabId);
  });

  if (tabId === "tab-ipc") {
    renderIpcSection();
  }
}

// --- 10. Autenticación y Bookmarklet Dinámico (Local o Nube HTTPS) ---

async function configureDynamicBookmarklet() {
  const linkEl = document.getElementById("bookmarkletLink");
  const originEl = document.getElementById("bookmarkletOriginCode");
  const origin = window.location.origin;
  if (originEl) originEl.textContent = origin;
  if (!linkEl) return;

  let endpoint = `${origin}/api/import-lider`;
  try {
    const res = await fetch("/api/bookmarklet-info");
    if (res.ok) {
      const info = await res.json();
      if (info.importToken) {
        endpoint += `?token=${encodeURIComponent(info.importToken)}`;
      }
    }
  } catch {
    // Fallback sin token
  }

  const code = `(function(){try{var raw='';var el=document.getElementById('__NEXT_DATA__');if(el){raw=el.textContent;}else{raw=document.documentElement.outerHTML;}var xhr=new XMLHttpRequest();xhr.open('POST',${JSON.stringify(endpoint)},true);xhr.setRequestHeader('Content-Type','application/json');xhr.onload=function(){var info='';try{var d=JSON.parse(xhr.responseText||'{}');if(xhr.status>=400){alert('Error ('+xhr.status+'): '+(d.error||'No autorizado'));return;}info=d.count?' ('+d.count+' prod.'+(d.matchedTrackedCount?', '+d.matchedTrackedCount+' seguidos act.':'')+')':'';}catch(e){}var toast=document.createElement('div');toast.style.cssText='position:fixed;top:20px;right:20px;z-index:999999;background:#10b981;color:#fff;padding:14px 20px;border-radius:10px;font-family:sans-serif;font-weight:bold;box-shadow:0 10px 25px rgba(0,0,0,0.4);';toast.innerHTML='🛒 ¡Precios importados a SuperPrecio CL'+info+'!<br><a href="'+(${JSON.stringify(origin)})+'" target="_blank" style="color:#fff;text-decoration:underline;font-size:12px;">Abrir Comparador</a>';document.body.appendChild(toast);setTimeout(function(){toast.remove();},6000);};xhr.onerror=function(){alert('Error conectando a SuperPrecio CL en '+${JSON.stringify(origin)});};xhr.send(JSON.stringify({rawContent:raw,url:location.href}));}catch(e){alert('Error: '+e.message);}})();`;
  linkEl.href = `javascript:${code}`;
}

async function bootApp() {
  const overlay = document.getElementById("authOverlay");
  const logoutBtn = document.getElementById("btnLogout");
  try {
    const res = await fetch("/api/auth/status");
    const auth = await res.json();
    if (logoutBtn) {
      logoutBtn.style.display = auth.authEnabled ? "inline-flex" : "none";
    }
    if (auth.authEnabled && !auth.authenticated) {
      if (overlay) overlay.style.display = "flex";
      return;
    }
    if (overlay) overlay.style.display = "none";
  } catch (err) {
    console.warn("No se pudo verificar estado de auth:", err);
  }

  await loadTrackedData();
  await loadTelegramSettings();
  await configureDynamicBookmarklet();
}

// --- Inicialización de Eventos DOM ---

window.addEventListener("DOMContentLoaded", () => {
  bootApp();

  // Formulario de Login (cuando ACCESS_PASSWORD está configurada en la nube)
  document.getElementById("authLoginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const passInput = document.getElementById("authPasswordInput");
    const errEl = document.getElementById("authErrorMsg");
    const btn = document.getElementById("btnAuthLogin");
    if (errEl) errEl.style.display = "none";
    btn.disabled = true;
    btn.textContent = "⏳ Verificando...";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: passInput.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (errEl) {
          errEl.textContent = data.error || "Contraseña incorrecta.";
          errEl.style.display = "block";
        }
        return;
      }
      passInput.value = "";
      await bootApp();
      showToast("Sesión iniciada correctamente.");
    } catch (err) {
      if (errEl) {
        errEl.textContent = "Error de conexión: " + err.message;
        errEl.style.display = "block";
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "🔓 Desbloquear Comparador";
    }
  });

  document.getElementById("btnLogout")?.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    await bootApp();
  });

  // Navegación por pestañas
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Escala global de unidad ($/kg vs $/100g vs $/g vs $/10g proteína)
  const globalScaleSelect = document.getElementById("globalUnitScale");
  if (globalScaleSelect) {
    globalScaleSelect.addEventListener("change", (e) => {
      state.unitScale = e.target.value;
      renderAll();
      if (state.liveSearchResults.length > 0) {
        renderLiveSearchResults();
      }
    });
  }

  // Selector de frecuencia de auto-registro
  const autoIntervalSelect = document.getElementById("autoIntervalSelect");
  if (autoIntervalSelect) {
    autoIntervalSelect.addEventListener("change", async (e) => {
      const val = Number(e.target.value);
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoIntervalMinutes: val }),
      });
      showToast(
        val > 0
          ? `Auto-registro programado cada ${val / 60} hora(s).`
          : "Auto-registro cambiado a modo manual."
      );
    });
  }

  // Botón Actualizar Todos Ahora
  const btnRefreshAll = document.getElementById("btnRefreshAll");
  if (btnRefreshAll) {
    btnRefreshAll.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = `<span class="icon">⏳</span> Actualizando todos...`;
      try {
        await fetch("/api/tracked/refresh-all", { method: "POST" });
        await loadTrackedData();
        showToast("Todos los productos fueron actualizados y guardados en el historial.");
      } catch (err) {
        showToast("Error al actualizar: " + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<span class="icon">🔄</span> Actualizar Todos Ahora`;
      }
    });
  }

  // =========================================================================
  // EVENTOS DEL CARRITO DE COMPRAS, FRICCIÓN Y TARJETAS
  // =========================================================================

  const activeCartSelect = document.getElementById("activeCartSelect");
  if (activeCartSelect) {
    activeCartSelect.addEventListener("change", (e) => {
      state.activeCartId = Number(e.target.value);
      renderAll();
    });
  }

  const cartCriteriaSelect = document.getElementById("cartCriteriaSelect");
  if (cartCriteriaSelect) {
    cartCriteriaSelect.addEventListener("change", async (e) => {
      const cart = getActiveCart();
      if (!cart) return;
      const res = await fetch(`/api/carts/${cart.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria: e.target.value }),
      });
      const data = await res.json();
      if (data.carts) state.carts = data.carts;
      renderAll();
    });
  }

  // Listeners para cambios de fricción de despacho y día de semana
  ["cartEnableFriction", "cartDeliveryCost", "cartFreeDeliveryThreshold", "cartDayOfWeekSelect"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", saveCartSettings);
    }
  );

  document
    .querySelectorAll("#cartProgramsCheckboxes input[type=checkbox]")
    .forEach((cb) => cb.addEventListener("change", saveCartSettings));

  const formAddCartItem = document.getElementById("formAddCartItem");
  if (formAddCartItem) {
    formAddCartItem.addEventListener("submit", async (e) => {
      e.preventDefault();
      const cart = getActiveCart();
      if (!cart) return;

      const qty = Number(document.getElementById("cartAddQty").value) || 1;
      const query = document.getElementById("cartAddQuery").value.trim();
      const preferredUnit = document.getElementById("cartAddUnit").value;
      if (!query) return;

      const btn = document.getElementById("btnAddCartItem");
      btn.disabled = true;
      btn.textContent = "⏳ Buscando en súper...";

      try {
        const res = await fetch(`/api/carts/${cart.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: query.charAt(0).toUpperCase() + query.slice(1),
            searchQuery: query,
            quantity: qty,
            preferredUnit,
          }),
        });
        const data = await res.json();
        if (data.carts) state.carts = data.carts;
        document.getElementById("cartAddQuery").value = "";
        document.getElementById("cartAddQty").value = "1";
        renderAll();
        showToast(`"${query}" agregado y comparado en el carrito.`);
      } catch (err) {
        showToast("Error agregando al carrito: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "🛒 Añadir al Carrito";
      }
    });
  }

  const formBatchCartItems = document.getElementById("formBatchCartItems");
  if (formBatchCartItems) {
    formBatchCartItems.addEventListener("submit", async (e) => {
      e.preventDefault();
      const cart = getActiveCart();
      if (!cart) return;

      const batchText = document.getElementById("cartBatchTextarea").value.trim();
      if (!batchText) return;

      const btn = document.getElementById("btnSubmitBatchCart");
      btn.disabled = true;
      btn.textContent = "⏳ Consultando lista en los 4 supermercados...";

      try {
        const res = await fetch(`/api/carts/${cart.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchText }),
        });
        const data = await res.json();
        if (data.carts) state.carts = data.carts;
        document.getElementById("cartBatchTextarea").value = "";
        renderAll();
        showToast("Lista de compras procesada y comparada con éxito.");
      } catch (err) {
        showToast("Error procesando lista: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "🚀 Generar Carrito con esta Lista";
      }
    });
  }

  const btnRefreshCart = document.getElementById("btnRefreshCart");
  if (btnRefreshCart) {
    btnRefreshCart.addEventListener("click", async (e) => {
      const cart = getActiveCart();
      if (!cart) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "⏳ Actualizando...";
      try {
        const res = await fetch(`/api/carts/${cart.id}/refresh`, { method: "POST" });
        const data = await res.json();
        if (data.carts) state.carts = data.carts;
        renderAll();
        showToast("Precios del carrito actualizados en vivo.");
      } finally {
        btn.disabled = false;
        btn.textContent = "🔄 Actualizar Precios";
      }
    });
  }

  const btnCopyCart = document.getElementById("btnCopyCartSummary");
  if (btnCopyCart) {
    btnCopyCart.addEventListener("click", async () => {
      const cart = getActiveCart();
      if (!cart) return;

      const lines = [
        `🛒 *${cart.name}*`,
        winSummaryLine(cart),
        "",
        "🛍️ *Desglose por Supermercado (Compra Óptima):*",
      ];

      for (const grp of cart.optimalSplitCart.byStore || []) {
        lines.push(`\n📍 *${grp.storeName}* (Subtotal: ${fmtClp(grp.subtotalClp)})`);
        for (const it of grp.items) {
          lines.push(
            `  • ${it.quantity}x ${it.productName} — ${fmtClp(it.lineTotal)} (${fmtUnitScaled(it.unitPrice, it.unit, state.unitScale, it.pricePer10gProtein)})`
          );
        }
      }

      await navigator.clipboard.writeText(lines.join("\n"));
      showToast("Lista de compra óptima copiada al portapapeles.");
    });
  }

  function winSummaryLine(cart) {
    const w = cart.winnerSingleStore;
    const sp = cart.optimalSplitCart;
    let out = "";
    if (w) out += `🥇 Todo en 1 súper: ${w.storeName} por ${fmtClp(w.netTotalClp || w.totalClp)}\n`;
    if (sp) out += `🏆 Compra dividida óptima: ${fmtClp(sp.netTotalClp || sp.totalClp)}`;
    return out;
  }

  // Modal Nuevo Carrito
  const modalNewCart = document.getElementById("modalNewCart");
  document.getElementById("btnNewCartModal")?.addEventListener("click", () => {
    if (modalNewCart) modalNewCart.style.display = "flex";
  });
  document.getElementById("btnCloseNewCartModal")?.addEventListener("click", () => {
    if (modalNewCart) modalNewCart.style.display = "none";
  });
  document.getElementById("btnCancelNewCartModal")?.addEventListener("click", () => {
    if (modalNewCart) modalNewCart.style.display = "none";
  });

  const formNewCart = document.getElementById("formNewCart");
  if (formNewCart) {
    formNewCart.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("newCartNameInput").value.trim();
      const batchText = document.getElementById("newCartBatchInput").value.trim();
      const btn = document.getElementById("btnSubmitNewCart");

      btn.disabled = true;
      btn.textContent = "⏳ Creando y buscando...";
      try {
        const res = await fetch("/api/carts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, batchText }),
        });
        const data = await res.json();
        if (data.carts) state.carts = data.carts;
        if (data.cart) state.activeCartId = data.cart.id;
        if (modalNewCart) modalNewCart.style.display = "none";
        e.target.reset();
        renderAll();
        showToast(`Carrito "${name}" creado con éxito.`);
      } finally {
        btn.disabled = false;
        btn.textContent = "🛒 Crear y Comparar Carrito";
      }
    });
  }

  document.getElementById("btnDeleteCart")?.addEventListener("click", async () => {
    const cart = getActiveCart();
    if (!cart) return;
    if (state.carts.length <= 1) {
      showToast("Debes mantener al menos un carrito activo.");
      return;
    }
    const res = await fetch(`/api/carts/${cart.id}`, { method: "DELETE" });
    const data = await res.json();
    if (data.carts) state.carts = data.carts;
    state.activeCartId = state.carts[0]?.id || null;
    renderAll();
    showToast("Carrito eliminado.");
  });

  // Controles de la sección de Historial y Variabilidad
  document.getElementById("historyProductSelect")?.addEventListener("change", (e) => {
    state.selectedHistoryItemId = Number(e.target.value);
    renderHistorySection();
  });

  document.getElementById("btnChartModeUnit")?.addEventListener("click", () => {
    state.chartMode = "unit";
    document.getElementById("btnChartModeUnit").classList.add("active");
    document.getElementById("btnChartModeTotal").classList.remove("active");
    renderHistorySection();
  });

  document.getElementById("btnChartModeTotal")?.addEventListener("click", () => {
    state.chartMode = "total";
    document.getElementById("btnChartModeTotal").classList.add("active");
    document.getElementById("btnChartModeUnit").classList.remove("active");
    renderHistorySection();
  });

  // Buscador en vivo
  document.getElementById("liveSearchForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    executeLiveSearch(document.getElementById("liveSearchInput").value);
  });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const q = chip.dataset.q;
      document.getElementById("liveSearchInput").value = q;
      executeLiveSearch(q);
    });
  });

  ["searchSortSelect", "searchUnitFilter", "searchStoreFilter"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => {
      if (state.liveSearchResults.length > 0) renderLiveSearchResults();
    });
  });

  // Botón Seguir esta búsqueda automáticamente
  document.getElementById("btnTrackCurrentSearch")?.addEventListener("click", async () => {
    if (!state.liveSearchQuery) return;
    const q = state.liveSearchQuery;
    const btn = document.getElementById("btnTrackCurrentSearch");
    btn.disabled = true;
    btn.textContent = "⏳ Guardando...";
    try {
      await fetch("/api/tracked", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: q.charAt(0).toUpperCase() + q.slice(1),
          searchQuery: q,
          mode: "mixed",
          preferredUnit:
            document.getElementById("searchUnitFilter").value === "all"
              ? "auto"
              : document.getElementById("searchUnitFilter").value,
        }),
      });
      await loadTrackedData();
      showToast(`"${q}" agregado al seguimiento automático.`);
      switchTab("tab-dashboard");
    } finally {
      btn.disabled = false;
      btn.textContent = "📌 Seguir esta Búsqueda Automáticamente";
    }
  });

  // =========================================================================
  // EVENTOS DE IPC PERSONAL Y RECALCULAR
  // =========================================================================

  document.getElementById("btnRefreshIpc")?.addEventListener("click", async () => {
    const btn = document.getElementById("btnRefreshIpc");
    btn.disabled = true;
    btn.textContent = "⏳ Recalculando...";
    try {
      await renderIpcSection();
      showToast("IPC Personal recalculado con éxito.");
    } finally {
      btn.disabled = false;
      btn.textContent = "🔄 Recalcular IPC";
    }
  });

  // =========================================================================
  // EVENTOS DE TELEGRAM
  // =========================================================================

  document.getElementById("telegramSettingsForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = document.getElementById("teleTokenInput").value.trim();
    const chatId = document.getElementById("teleChatIdInput").value.trim();
    const thresholdPct = Number(document.getElementById("teleThresholdInput").value) || 12;
    const enabled = document.getElementById("teleEnabledInput").checked;

    try {
      const res = await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, chatId, thresholdPct, enabled }),
      });
      if (res.ok) {
        showToast("Ajustes de Telegram guardados con éxito.");
      } else {
        showToast("Error guardando ajustes de Telegram.");
      }
    } catch (err) {
      showToast("Error: " + err.message);
    }
  });

  document.getElementById("btnTestTelegram")?.addEventListener("click", async () => {
    const token = document.getElementById("teleTokenInput").value.trim();
    const chatId = document.getElementById("teleChatIdInput").value.trim();
    if (!token || !chatId) {
      showToast("Ingresa primero tu Bot Token y Chat ID.");
      return;
    }
    const btn = document.getElementById("btnTestTelegram");
    btn.disabled = true;
    btn.textContent = "⏳ Enviando...";
    try {
      const res = await fetch("/api/telegram/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, chatId }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast("¡Mensaje de prueba enviado exitosamente a tu Telegram!");
      } else {
        showToast(`Error al enviar a Telegram: ${data.description || data.error || "Desconocido"}`);
      }
    } catch (err) {
      showToast("Error conectando con Telegram: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "🔔 Probar Alerta en mi Celular";
    }
  });

  // Modal Nuevo Producto Seguido
  const modalNew = document.getElementById("modalNewTracked");
  document.getElementById("btnOpenNewTrackModal")?.addEventListener("click", () => {
    if (modalNew) modalNew.style.display = "flex";
  });
  document.getElementById("btnCloseNewTrackModal")?.addEventListener("click", () => {
    if (modalNew) modalNew.style.display = "none";
  });
  document.getElementById("btnCancelNewTrack")?.addEventListener("click", () => {
    if (modalNew) modalNew.style.display = "none";
  });

  document.getElementById("formNewTracked")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("btnSubmitNewTrack");
    btn.disabled = true;
    btn.textContent = "⏳ Consultando supermercados...";
    try {
      const res = await fetch("/api/tracked", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: document.getElementById("newTrackTitle").value,
          searchQuery: document.getElementById("newTrackQuery").value,
          preferredUnit: document.getElementById("newTrackUnit").value,
          category: document.getElementById("newTrackCategory").value,
        }),
      });
      const data = await res.json();
      if (data.item) {
        state.selectedHistoryItemId = data.item.id;
      }
      if (modalNew) modalNew.style.display = "none";
      e.target.reset();
      await loadTrackedData();
      showToast("Producto creado y precios registrados en vivo.");
    } catch (err) {
      showToast("Error: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "🚀 Crear y Consultar Precios Ahora";
    }
  });

  // Modal Fijar Producto Específico
  const modalPin = document.getElementById("modalPinProduct");
  const pinSelect = document.getElementById("pinTargetSelect");
  if (pinSelect) {
    pinSelect.addEventListener("change", () => {
      const wrap = document.getElementById("pinNewTitleWrap");
      if (wrap) wrap.style.display = pinSelect.value === "new" ? "flex" : "none";
    });
  }
  document.getElementById("btnClosePinModal")?.addEventListener("click", () => {
    if (modalPin) modalPin.style.display = "none";
  });
  document.getElementById("btnCancelPinModal")?.addEventListener("click", () => {
    if (modalPin) modalPin.style.display = "none";
  });

  document.getElementById("formPinProduct")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.pendingPinProduct) return;
    const target = pinSelect.value;

    try {
      if (target === "new") {
        const title =
          document.getElementById("pinNewTitleInput").value.trim() ||
          state.pendingPinProduct.name;
        await fetch("/api/tracked", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            searchQuery: title,
            mode: "mixed",
            preferredUnit: state.pendingPinProduct.unit || "auto",
            initialProduct: state.pendingPinProduct,
          }),
        });
      } else {
        await fetch(`/api/tracked/${Number(target)}/pin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product: state.pendingPinProduct }),
        });
      }
      if (modalPin) modalPin.style.display = "none";
      await loadTrackedData();
      showToast("Producto fijado y precio guardado en el historial.");
    } catch (err) {
      showToast("Error al fijar: " + err.message);
    }
  });

  // Formulario Lookup por Link / URL
  const urlTargetSelect = document.getElementById("urlTargetTrackedSelect");
  if (urlTargetSelect) {
    urlTargetSelect.addEventListener("change", () => {
      const f = document.getElementById("urlNewTitleField");
      if (f) f.style.display = urlTargetSelect.value === "new" ? "flex" : "none";
    });
  }

  document.getElementById("urlLookupForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = document.getElementById("urlLookupInput").value.trim();
    const target = urlTargetSelect.value;
    const title = document.getElementById("urlNewTitleInput").value.trim();
    const box = document.getElementById("urlLookupResultBox");
    const btn = document.getElementById("btnLookupUrl");

    btn.disabled = true;
    btn.textContent = "⏳ Extrayendo producto...";
    box.innerHTML = "";

    try {
      const res = await fetch("/api/lookup-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          createNew: target === "new",
          trackedItemId: target !== "new" ? Number(target) : undefined,
          title: title || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al consultar link");

      const p = data.product;
      box.innerHTML = `
        <div class="winner-banner">
          <div>
            ✅ <strong>${p.storeName}</strong>: ${p.name}<br/>
            Precio: <strong>${fmtClp(p.price)}</strong> · Por unidad: <strong>${fmtUnitScaled(p.unitPrice, p.unit, state.unitScale, p.pricePer10gProtein)}</strong> (${p.formatLabel})
          </div>
        </div>
      `;
      await loadTrackedData();
      showToast("Link procesado y guardado en tu seguimiento.");
    } catch (err) {
      box.innerHTML = `<div class="empty-state" style="padding:1rem;color:#f87171;">⚠️ ${err.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "🔍 Extraer Precio y Guardar en Seguimiento";
    }
  });

  // Formulario de Registro Manual / Lider
  document.getElementById("manualEntryForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const itemId = Number(document.getElementById("manualTrackedSelect").value);
    const store = document.getElementById("manualStoreSelect").value;
    const name = document.getElementById("manualNameInput").value.trim();
    const brand = document.getElementById("manualBrandInput").value.trim();
    const price = Number(document.getElementById("manualPriceInput").value);
    const formatLabel = document.getElementById("manualFormatInput").value.trim();

    const res = await fetch(`/api/tracked/${itemId}/manual-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store, name, brand, price, formatLabel }),
    });
    if (res.ok) {
      e.target.reset();
      await loadTrackedData();
      showToast("Medición guardada en el historial y calculado su $/unidad.");
    }
  });

  // Importación avanzada de JSON __NEXT_DATA__ de Lider
  document.getElementById("btnImportLiderRaw")?.addEventListener("click", async () => {
    const rawContent = document.getElementById("liderRawTextarea").value.trim();
    const trackedItemId = Number(document.getElementById("manualTrackedSelect").value);
    if (!rawContent) return;

    const res = await fetch("/api/import-lider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawContent, trackedItemId }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "Error al procesar JSON de Lider");
      return;
    }
    document.getElementById("liderRawTextarea").value = "";
    await loadTrackedData();
    showToast(`Importados ${data.count} productos de Lider y registrado el mejor precio.`);
  });
});
