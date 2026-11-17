/**
 * Motor de normalización de precios, unidades (g, kg, ml, cc, L, un) y relevancia
 * para supermercados de Chile.
 */

export function normalizeText(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

export function toClp(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

export function parseClpString(value) {
  if (typeof value === "number") return toClp(value);
  if (typeof value !== "string") return undefined;
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length === 0) return undefined;
  const num = Number(digits);
  return num > 0 ? num : undefined;
}

export function normalizeUnit(rawUnit) {
  const u = normalizeText(rawUnit).replace(/\./g, "");
  if (
    ["g", "gr", "grs", "gramo", "gramos", "kg", "kilo", "kilos", "k", "10gr", "10g", "100gr", "100g"].includes(u)
  ) {
    return "kg";
  }
  if (["ml", "cc", "cm3", "lt", "l", "lts", "litro", "litros", "100ml", "100cc"].includes(u)) {
    return "lt";
  }
  if (
    [
      "un",
      "und",
      "unid",
      "unidad",
      "unidades",
      "rollo",
      "rollos",
      "bolsita",
      "bolsitas",
      "capsula",
      "capsulas",
      "panal",
      "panales",
      "hoja",
      "hojas",
      "m",
      "mt",
      "mts",
      "metro",
      "metros",
    ].includes(u)
  ) {
    return "un";
  }
  return u || "un";
}

/**
 * Convierte (precio, cantidad, unidad_cruda) a precio por unidad base canónica:
 * - Masa -> $/kg
 * - Volumen -> $/lt
 * - Unidades -> $/un
 */
export function normalizeUnitPrice(price, qty, rawUnit) {
  const q = qty && qty > 0 ? qty : 1;
  const u = normalizeText(rawUnit).replace(/\./g, "");

  if (["g", "gr", "grs", "gramo", "gramos"].includes(u)) {
    const kg = q / 1000;
    return { unitPrice: Math.round(price / kg), unit: "kg", baseAmount: kg };
  }
  if (["kg", "kilo", "kilos", "k"].includes(u)) {
    return { unitPrice: Math.round(price / q), unit: "kg", baseAmount: q };
  }
  if (["ml", "cc", "cm3"].includes(u)) {
    const lt = q / 1000;
    return { unitPrice: Math.round(price / lt), unit: "lt", baseAmount: lt };
  }
  if (["lt", "l", "lts", "litro", "litros"].includes(u)) {
    return { unitPrice: Math.round(price / q), unit: "lt", baseAmount: q };
  }
  return {
    unitPrice: Math.round(price / q),
    unit: normalizeUnit(u),
    baseAmount: q,
  };
}

/**
 * Parsea cadenas PPUM de supermercados chilenos:
 *   "$2.500 x litro"  -> { unitPrice: 2500, unit: "lt" }
 *   "$1.048 x 100ml"  -> { unitPrice: 10480, unit: "lt" }
 *   "$700 x 100 g"    -> { unitPrice: 7000, unit: "kg" }
 *   "$1.097 por LT"   -> { unitPrice: 1097, unit: "lt" }
 */
export function parseUnitPriceString(value) {
  if (typeof value !== "string") return undefined;
  const m = value.match(
    /\$?\s*([\d.]+)\s*(?:x|por|\/)\s*(\d+(?:[.,]\d+)?)?\s*([a-zA-Z]+)/i
  );
  if (!m) return undefined;
  const price = Number(m[1].replace(/\./g, ""));
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const qty = m[2] ? Number(m[2].replace(",", ".")) : 1;
  const res = normalizeUnitPrice(price, qty, m[3]);
  return { unitPrice: res.unitPrice, unit: res.unit };
}

/**
 * Extrae el peso, volumen o cantidad desde el nombre del producto o formato.
 * Soporta:
 * - Multipacks: "6 x 200 ml", "Pack 12 un x 90 g", "4x1.5L", "6 de 350 cc"
 * - Medidas simples: "1 kg", "900 g", "250 grs", "1,5 L", "900 ml", "500 cc"
 * - Unidades discretas: "30 un", "12 unidades", "100 bolsitas", "8 rollos"
 */
export function extractQuantityFromText(name = "", formatStr = "") {
  const combined = `${name} ${formatStr}`.trim();
  const norm = normalizeText(combined);

  // 1. Multipacks con peso/volumen: ej. "6 x 200 ml", "12 un de 90 g", "6x1.5 l"
  const multiMatch = norm.match(
    /\b(\d{1,3})\s*(?:un(?:id(?:ades)?)?\s*)?(?:x|de|por)\s*(\d+(?:[.,]\d+)?)\s*(kg|kilo|kilos|g|gr|grs|gramos|lt|lts|l|litro|litros|ml|cc)\b/i
  );
  if (multiMatch) {
    const count = Number(multiMatch[1]);
    const eachQty = Number(multiMatch[2].replace(",", "."));
    const rawUnit = multiMatch[3];
    if (count > 0 && eachQty > 0) {
      const totalRaw = count * eachQty;
      const converted = normalizeUnitPrice(1000, totalRaw, rawUnit);
      return {
        baseAmount: converted.baseAmount,
        unit: converted.unit,
        displayFormat: `${count} x ${eachQty} ${rawUnit}`,
      };
    }
  }

  // 2. Peso o volumen simple: ej. "1.5 kg", "900 ml", "250 g", "1 l", "400 gr"
  const singleMatch = norm.match(
    /\b(\d+(?:[.,]\d+)?)\s*(kg|kilo|kilos|g|gr|grs|gramo|gramos|lt|lts|l|litro|litros|ml|cc)\b/i
  );
  if (singleMatch) {
    const qty = Number(singleMatch[1].replace(",", "."));
    const rawUnit = singleMatch[2];
    if (qty > 0) {
      const converted = normalizeUnitPrice(1000, qty, rawUnit);
      // Evitar falsos positivos absurdos (ej. "0.0001 kg")
      if (converted.baseAmount > 0 && converted.baseAmount <= 100) {
        return {
          baseAmount: converted.baseAmount,
          unit: converted.unit,
          displayFormat: `${qty} ${rawUnit}`,
        };
      }
    }
  }

  // 3. Unidades discretas: ej. "30 un", "12 unidades", "8 rollos", "20 bolsitas"
  const unitMatch = norm.match(
    /\b(\d{1,4})\s*(un|und|unid|unidades|unidad|rollos|rollo|bolsitas|bolsita|capsulas|capsula|panales|panal|hojas)\b/i
  );
  if (unitMatch) {
    const qty = Number(unitMatch[1]);
    const rawU = unitMatch[2];
    if (qty > 0) {
      return {
        baseAmount: qty,
        unit: "un",
        displayFormat: `${qty} ${rawU}`,
      };
    }
  }

  return null;
}

/**
 * Calcula y unifica todas las métricas de precio por unidad de un producto:
 * - unitPrice: $/kg, $/lt o $/un
 * - unit: 'kg' | 'lt' | 'un'
 * - pricePer100: $/100g o $/100ml (si aplica)
 * - pricePerSmallUnit: $/g o $/ml (si aplica)
 * - formatLabel: ej. "900 g", "1.5 L", "1 kg"
 */
export function enrichUnitMetrics({
  price,
  storeUnitPrice,
  storeUnit,
  storeMultiplier,
  name,
  description,
}) {
  const extracted = extractQuantityFromText(name, description);

  let unit = storeUnit ? normalizeUnit(storeUnit) : undefined;
  let unitPrice = toClp(storeUnitPrice);
  let baseAmount = extracted?.baseAmount;
  let formatLabel = extracted?.displayFormat || description || undefined;

  // Si tenemos multiplier directo (ej. Cencosud unit_multiplier_un)
  if (!unitPrice && storeMultiplier && storeMultiplier > 0 && price) {
    unitPrice = Math.round(price / storeMultiplier);
    if (!baseAmount) baseAmount = storeMultiplier;
  }

  // Si pudimos extraer peso/volumen del título (ej. "900 g", "1.5 L"), siempre normalizamos
  // a kg/lt para evitar errores cuando la tienda reporta "10gr", "100g" o "un"
  if (extracted && (extracted.unit === "kg" || extracted.unit === "lt") && extracted.baseAmount > 0) {
    unit = extracted.unit;
    baseAmount = extracted.baseAmount;
    unitPrice = Math.round(price / extracted.baseAmount);
  } else if (extracted && extracted.unit === "un" && extracted.baseAmount > 0) {
    unit = "un";
    baseAmount = extracted.baseAmount;
    unitPrice = Math.round(price / extracted.baseAmount);
  }

  // Fallback final: 1 unidad
  if (!unitPrice || !unit) {
    unit = unit || "un";
    unitPrice = price;
    baseAmount = 1;
  }

  const isMassOrVol = unit === "kg" || unit === "lt";
  const smallUnitName = unit === "kg" ? "g" : unit === "lt" ? "ml" : "un";
  const per100UnitName = unit === "kg" ? "100g" : unit === "lt" ? "100ml" : "un";

  const pricePer100 = isMassOrVol ? Math.round(unitPrice / 10) : unitPrice;
  const pricePerSmallUnit = isMassOrVol
    ? Number((unitPrice / 1000).toFixed(2))
    : unitPrice;

  if (!formatLabel && baseAmount && isMassOrVol) {
    if (baseAmount < 1) {
      formatLabel = `${Math.round(baseAmount * 1000)} ${smallUnitName}`;
    } else {
      formatLabel = `${Number(baseAmount.toFixed(2))} ${unit}`;
    }
  }

  return {
    unit,
    unitPrice,
    baseAmount: baseAmount ?? 1,
    formatLabel: formatLabel || `1 ${unit}`,
    pricePer100,
    per100UnitName,
    pricePerSmallUnit,
    smallUnitName,
  };
}

/**
 * Parsea promociones multi-compra ("2 x $3.000", "Lleva 3 por $4.500", "2x1").
 */
export function parseBundle(text) {
  if (!text || typeof text !== "string") return undefined;
  const desc = text.trim().replace(/\s+/g, " ");
  if (desc.length === 0) return undefined;

  const bundle = desc.match(/(?:combina|lleva)?\s*(\d+)\s*(?:x|por)\s*\$\s*([\d.]+)/i);
  if (bundle) {
    const minQuantity = Number(bundle[1]);
    const bundlePrice = Number(bundle[2].replace(/\./g, ""));
    if (
      Number.isFinite(minQuantity) &&
      minQuantity > 1 &&
      Number.isFinite(bundlePrice) &&
      bundlePrice > 0
    ) {
      return {
        description: desc,
        type: "bundle",
        minQuantity,
        bundlePrice,
        unitPriceInBundle: Math.round(bundlePrice / minQuantity),
      };
    }
  }

  const nxm = desc.match(/(\d+)\s*x\s*(\d+)\b/i);
  if (nxm && !/\$/.test(desc)) {
    return { description: desc, type: "nxm", minQuantity: Number(nxm[1]) };
  }

  return { description: desc, type: "descuento" };
}

// --- Matching de búsqueda entre supermercados ---

const STOPWORDS = new Set([
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "en",
  "con",
  "sin",
  "para",
  "por",
  "un",
  "una",
  "al",
  "y",
  "o",
  "a",
]);

export function singularize(word) {
  if (word.length <= 3) return word;
  if (word.endsWith("ces")) return word.slice(0, -3) + "z";
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  return normalizeText(text)
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => singularize(t));
}

export function matchScore(query, candidateName) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 1;
  const cTokens = tokenize(candidateName);
  const cSet = new Set(cTokens);

  let hits = 0;
  for (const qt of qTokens) {
    // Ignorar tokens de unidad puros en la penalización estricta si el nombre lo expresa distinto (ej. 1l vs 1000ml)
    if (["1l", "1lt", "1kg"].includes(qt)) {
      hits += 0.8;
      continue;
    }
    const matched =
      cSet.has(qt) ||
      (!/^\d+$/.test(qt) &&
        qt.length >= 4 &&
        cTokens.some(
          (ct) =>
            Math.abs(ct.length - qt.length) <= 2 &&
            (ct.includes(qt) || qt.includes(ct))
        ));
    if (matched) hits += 1;
  }
  return hits / qTokens.length;
}


// --- Estimación Nutricional y Densidad Proteica ($ / 10g de proteína) ---

const PROTEIN_TABLE = [
  { match: /\b(?:proteina\s+en\s+polvo|whey|isolate|proteina\s+whey)\b/i, gPer100: 75 },
  { match: /\b(?:pechuga|filete\s+de\s+pollo|pollo\s+pechuga)\b/i, gPer100: 23 },
  { match: /\b(?:truto|pollo\s+entero|pollo)\b/i, gPer100: 19 },
  { match: /\b(?:posta|lomo|filete|vacuno|carne\s+molida|sobrecostilla|abastero|tapapecho)\b/i, gPer100: 21 },
  { match: /\b(?:atun|jurel|salmon|merluza|reineta|pescado)\b/i, gPer100: 23 },
  { match: /\b(?:huevo|huevos)\b/i, gPerUnit: 6.3, gPer100: 12.5 },
  { match: /\b(?:lenteja|lentejas)\b/i, gPer100: 24 },
  { match: /\b(?:garbanzo|garbanzos)\b/i, gPer100: 19 },
  { match: /\b(?:poroto|porotos)\b/i, gPer100: 21 },
  { match: /\b(?:leche\s+protein|leche\s+proteina|protein\s+shot|calo\s+protein)\b/i, gPer100: 6.5 },
  { match: /\b(?:leche)\b/i, gPer100: 3.2 },
  { match: /\b(?:yogurt\s+protein|yogur\s+protein|griego|skyr)\b/i, gPer100: 9.5 },
  { match: /\b(?:yogurt|yogur)\b/i, gPer100: 3.8 },
  { match: /\b(?:queso\s+gauda|queso\s+chanco|queso\s+mantecoso|queso)\b/i, gPer100: 23 },
  { match: /\b(?:quesillo|cottage)\b/i, gPer100: 12 },
  { match: /\b(?:avena)\b/i, gPer100: 13 },
  { match: /\b(?:fideos|spaghetti|tallarines|espirales|pasta)\b/i, gPer100: 12 },
  { match: /\b(?:arroz)\b/i, gPer100: 7.2 },
  { match: /\b(?:mani|nueces|almendras|pistachos|frutos\s+secos)\b/i, gPer100: 22 },
  { match: /\b(?:tofu|soya|carne\s+de\s+soya)\b/i, gPer100: 16 },
  { match: /\b(?:jamon\s+de\s+pavo|pechuga\s+de\s+pavo|jamon)\b/i, gPer100: 17 },
  { match: /\b(?:pan\s+marraqueta|marraqueta|hallulla|pan\s+de\s+molde)\b/i, gPer100: 8.5 }
];

export function estimateProteinMetrics(name = "", unit = "un", baseAmount = 1, price = 0) {
  const norm = normalizeText(name);
  let matched = null;

  for (const entry of PROTEIN_TABLE) {
    if (entry.match.test(norm)) {
      matched = entry;
      break;
    }
  }

  if (!matched) {
    return {
      hasProteinData: false,
      proteinGramsTotal: null,
      proteinPer100g: null,
      pricePer10gProtein: null
    };
  }

  let totalGramsOfProtein = 0;
  let gPer100 = matched.gPer100 || 0;

  if (unit === "un" && matched.gPerUnit) {
    totalGramsOfProtein = baseAmount * matched.gPerUnit;
  } else if (unit === "kg") {
    // baseAmount en kg -> gramos = baseAmount * 1000
    const totalWeightGrams = baseAmount * 1000;
    totalGramsOfProtein = (totalWeightGrams / 100) * gPer100;
  } else if (unit === "lt") {
    // baseAmount en litros -> ml = baseAmount * 1000
    const totalVolumeMl = baseAmount * 1000;
    totalGramsOfProtein = (totalVolumeMl / 100) * gPer100;
  } else {
    // Estimación general
    totalGramsOfProtein = (baseAmount / 100) * gPer100;
  }

  totalGramsOfProtein = Number(totalGramsOfProtein.toFixed(1));

  let pricePer10gProtein = null;
  if (totalGramsOfProtein > 0 && price > 0) {
    // precio / (proteina total / 10)
    pricePer10gProtein = Math.round(price / (totalGramsOfProtein / 10));
  }

  return {
    hasProteinData: true,
    proteinGramsTotal: totalGramsOfProtein,
    proteinPer100g: gPer100,
    pricePer10gProtein
  };
}

// --- Detector de Falsos Packs Ahorro (Envases Trampa) ---

export function detectPackTraps(products = []) {
  if (!products || products.length < 2) return [];

  const traps = [];
  // Agrupar por marca
  const byBrand = {};
  for (const p of products) {
    const brand = normalizeText(p.brand || "generico");
    if (!brand || brand === "generico") continue;
    if (!byBrand[brand]) byBrand[brand] = [];
    byBrand[brand].push(p);
  }

  for (const [brand, list] of Object.entries(byBrand)) {
    if (list.length < 2) continue;
    // Filtrar solo productos con misma unidad (kg o lt) y con baseAmount válido
    const valid = list.filter(
      (p) => (p.unit === "kg" || p.unit === "lt") && p.baseAmount > 0 && p.unitPrice > 0
    );
    if (valid.length < 2) continue;

    // Ordenar de menor a mayor tamaño físico
    valid.sort((a, b) => a.baseAmount - b.baseAmount);

    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const small = valid[i];
        const large = valid[j];

        // Solo si el grande es al menos 40% más grande que el pequeño
        if (large.baseAmount >= small.baseAmount * 1.35) {
          // Si el grande tiene un precio por unidad MAYOR al del pequeño (con al menos 4% de diferencia)
          if (large.unitPrice > small.unitPrice * 1.04) {
            const diffPct = Math.round(((large.unitPrice - small.unitPrice) / small.unitPrice) * 100);
            traps.push({
              brand: large.brand || brand,
              store: large.store,
              storeName: large.storeName,
              smallProduct: {
                name: small.name,
                format: small.formatLabel,
                price: small.price,
                unitPrice: small.unitPrice,
                unit: small.unit
              },
              largeProduct: {
                name: large.name,
                format: large.formatLabel,
                price: large.price,
                unitPrice: large.unitPrice,
                unit: large.unit
              },
              diffPct,
              message: `⚠️ ¡Falso Pack Ahorro en ${large.storeName}! Comprar envases de ${small.formatLabel} ($${small.unitPrice.toLocaleString("es-CL")}/${small.unit}) es ${diffPct}% más barato por ${small.unit} que llevar el envase grande de ${large.formatLabel} ($${large.unitPrice.toLocaleString("es-CL")}/${large.unit}).`
            });
          }
        }
      }
    }
  }

  return traps;
}
