/**
 * Simulador de Tarjetas Bancarias, Membresías y Calendario de Descuentos por Día
 * para supermercados en Chile (Jumbo, Santa Isabel, Unimarc, Tottus, Lider).
 */

export const DISCOUNT_PROGRAMS = [
  {
    id: "cmr",
    name: "CMR Falabella",
    color: "#65a30d",
    icon: "💳",
    targetStores: ["tottus"],
    description: "Precios exclusivos CMR en Tottus y días especiales de descuento.",
  },
  {
    id: "cencosud",
    name: "Cencosud Scotiabank / Jumbo Prime",
    color: "#16a34a",
    icon: "💳",
    targetStores: ["jumbo", "santaisabel"],
    description: "Precios socio Jumbo Prime y días Cencosud en Jumbo y Santa Isabel.",
  },
  {
    id: "unimarc_club",
    name: "Club Unimarc (RUT)",
    color: "#ea580c",
    icon: "🏷️",
    targetStores: ["unimarc"],
    description: "Descuentos automáticos al dar tu RUT en Unimarc.",
  },
  {
    id: "lider_bci",
    name: "Tarjeta Lider Bci",
    color: "#2563eb",
    icon: "💳",
    targetStores: ["lider"],
    description: "Precios Mi Club Lider y 6% de descuento los miércoles.",
  },
  {
    id: "banco_estado",
    name: "BancoEstado / Cuenta RUT / Tenpo",
    color: "#f59e0b",
    icon: "🏦",
    targetStores: ["unimarc", "lider"],
    description: "Días bancarios con Cuenta RUT o Tenpo en supermercados.",
  },
];

export const WEEKDAY_RULES = {
  // 0: Domingo, 1: Lunes, 2: Martes, 3: Miércoles, 4: Jueves, 5: Viernes, 6: Sábado
  1: [ // Lunes
    {
      store: "unimarc",
      program: "banco_estado",
      name: "Lunes BancoEstado / Cuenta RUT",
      discountPct: 10,
      description: "10% adicional con tarjeta BancoEstado en Unimarc.",
    },
    {
      store: "jumbo",
      program: "cencosud",
      name: "Lunes Cencosud Scotiabank",
      discountPct: 10,
      description: "10% extra en marcas seleccionadas con Cencosud.",
    },
  ],
  2: [ // Martes
    {
      store: "tottus",
      program: "cmr",
      name: "Martes CMR",
      discountPct: 10,
      description: "10% adicional con CMR Falabella en categorías seleccionadas.",
    },
    {
      store: "unimarc",
      program: "unimarc_club",
      name: "Martes Club Unimarc",
      discountPct: 8,
      description: "Descuentos en carnes y despensa con Club Unimarc.",
    },
  ],
  3: [ // Miércoles
    {
      store: "lider",
      program: "lider_bci",
      name: "Miércoles Lider Bci",
      discountPct: 6,
      description: "6% de descuento pagando con Tarjeta Lider Bci.",
    },
    {
      store: "santaisabel",
      program: "cencosud",
      name: "Miércoles Santa Isabel Cencosud",
      discountPct: 10,
      description: "10% de descuento con Cencosud Scotiabank.",
    },
    {
      store: "tottus",
      program: "cmr",
      name: "Miércoles CMR Carnicería y Fiambrería",
      discountPct: 15,
      categories: ["carnes"],
      description: "15% de descuento solo en carnes y fiambres con CMR.",
    },
  ],
  4: [ // Jueves
    {
      store: "jumbo",
      program: "cencosud",
      name: "Jueves Cencosud Jumbo",
      discountPct: 12,
      description: "12% de descuento en categorías seleccionadas con Cencosud Scotiabank.",
    },
    {
      store: "unimarc",
      program: "banco_estado",
      name: "Jueves Tenpo / Digital",
      discountPct: 10,
      description: "10% adicional pagando con Tenpo o prepago digital.",
    },
  ],
  5: [ // Viernes
    {
      store: "santaisabel",
      program: "cencosud",
      name: "Viernes Santa Isabel Puntos",
      discountPct: 8,
      description: "Precios especiales fin de semana con Cencosud.",
    },
  ],
  6: [ // Sábado
    {
      store: "tottus",
      program: "cmr",
      name: "Sábado CMR Puntos",
      discountPct: 5,
      description: "Descuento directo con CMR.",
    },
  ],
  0: [ // Domingo
    {
      store: "jumbo",
      program: "cencosud",
      name: "Domingo Familiar Jumbo Prime",
      discountPct: 5,
      description: "Descuentos exclusivos Jumbo Prime en toda la canasta.",
    },
  ],
};

const DAY_NAMES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

export function getTodayDayIndex() {
  return new Date().getDay();
}

export function getWeekdayName(idx) {
  return DAY_NAMES[idx] || "Hoy";
}

/**
 * Calcula el precio final de una línea de producto aplicando:
 * 1. Precio de socio/membresía (si el usuario tiene activado el programa de fidelidad de esa tienda)
 * 2. Descuento bancario / día de la semana si corresponde
 */
export function calculateDiscountedPricing({
  store,
  price,
  memberPrice,
  category = null,
  activePrograms = [],
  dayOfWeek = getTodayDayIndex(),
  hasStoreOffer = false,
}) {
  const activeSet = new Set(activePrograms);
  let effectivePrice = price;
  const appliedDiscounts = [];

  // 1. Descuentos de Membresía / Socio explícitos del catálogo
  if (memberPrice && memberPrice < price) {
    let qualifiesForMemberPrice = false;
    if (store === "tottus" && activeSet.has("cmr")) qualifiesForMemberPrice = true;
    if ((store === "jumbo" || store === "santaisabel") && activeSet.has("cencosud")) qualifiesForMemberPrice = true;
    if (store === "unimarc" && activeSet.has("unimarc_club")) qualifiesForMemberPrice = true;
    if (store === "lider" && activeSet.has("lider_bci")) qualifiesForMemberPrice = true;

    if (qualifiesForMemberPrice) {
      effectivePrice = memberPrice;
      appliedDiscounts.push(`Precio socio/tarjeta ($${memberPrice.toLocaleString("es-CL")})`);
    }
  }

  // 2. Descuentos por Calendario del Día (no acumulables sobre ofertas/promociones de tienda)
  const dayRules = !hasStoreOffer ? WEEKDAY_RULES[dayOfWeek] || [] : [];
  let bestAfterRule = effectivePrice;
  let bestRuleLabel = null;
  for (const rule of dayRules) {
    if (rule.store !== store || !activeSet.has(rule.program)) continue;
    if (
      Array.isArray(rule.categories) &&
      (!category || !rule.categories.includes(category))
    ) {
      continue;
    }
    const discountAmount = Math.round((effectivePrice * rule.discountPct) / 100);
    const candidatePrice = Math.max(1, effectivePrice - discountAmount);
    if (candidatePrice < bestAfterRule) {
      bestAfterRule = candidatePrice;
      bestRuleLabel = `${rule.name} (-${rule.discountPct}%)`;
    }
  }
  if (bestRuleLabel) {
    effectivePrice = bestAfterRule;
    appliedDiscounts.push(bestRuleLabel);
  }

  const savingsAmount = Math.max(0, price - effectivePrice);
  const discountPct = price > 0 ? Math.round((savingsAmount / price) * 100) : 0;

  return {
    originalPrice: price,
    finalPrice: effectivePrice,
    savingsAmount,
    discountPct,
    label: appliedDiscounts.join(" + "),
    hasDiscount: effectivePrice < price,
    appliedDiscounts,
  };
}
