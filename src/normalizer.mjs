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
export function normalizeProductUrl(rawUrl = "", store = "") {
  const url = String(rawUrl || "").trim();
  if (!url || url === "#") return "";
  if (store === "santaisabel" || /sisa\.cl/i.test(url)) {
    return url.replace(/^https?:\/\/(?:www\.)?sisa\.cl/i, "https://www.santaisabel.cl");
  }
  if (store === "unimarc" || /unimarc\.cl\/product\//i.test(url)) {
    return url.replace(/\/product(\/[^?#]+?)\/p(?=$|[?#])/i, "/product$1");
  }
  return url;
}

/**
 * Traduce nombres internos de Lider/Walmart u otros supermercados a búsquedas limpias
 * compatibles con Jumbo, Santa Isabel, Unimarc y Tottus.
 */
export function buildCrossStoreSearchQuery(rawQuery = "") {
  let q = normalizeText(rawQuery);
  if (!q) return "";
  q = q
    .replace(/\(\s*\d+\s*porciones?\s*\)/gi, " ")
    .replace(/\brefresco\s+sabor\b/gi, "jugo en polvo")
    .replace(/\brefresco\b/gi, "jugo en polvo")
    .replace(/\b(?:sobre|doypack|botella|bolsa)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return q || String(rawQuery).trim();
}

export function extractQuantityFromText(name = "", formatStr = "") {
  const combined = `${name} ${formatStr}`.trim();
  const norm = normalizeText(combined)
    .replace(
      /\b(?:rinde|para\s+preparar|prepara|equivalente\s+a)\s*\d+(?:[.,]\d+)?\s*(?:lt|lts|l|litro|litros|ml|cc)\b/gi,
      " "
    )
    .replace(/\b\d+\s*porciones?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

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

  // 1b. Multipacks separados por texto: ej. "Pack 6 un. Leche Soprole Proteína Chocolate 200 ml"
  const separatedPackMatch = norm.match(
    /\b(?:pack\s*)?(\d{1,2})\s*(?:un(?:id(?:ades)?)?\.?|x)\b.*?\b(\d+(?:[.,]\d+)?)\s*(ml|cc|g|gr|grs)\b/i
  );
  if (separatedPackMatch) {
    const count = Number(separatedPackMatch[1]);
    const eachQty = Number(separatedPackMatch[2].replace(",", "."));
    const rawUnit = separatedPackMatch[3];
    if (count >= 2 && count <= 30 && eachQty >= 15 && eachQty <= 1500) {
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

  const bundle = desc.match(/(?:combina|lleva|agrega)?\s*(\d+)\s*(?:x|por)\s*\$\s*([\d.]+)/i);
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

const BRAND_PATTERNS = [
  { match: /\b(?:cuisine\s*&\s*co|cuisine\s+and\s+co|cuisine\s+co)\b/i, name: "Cuisine & Co" },
  { match: /\b(?:nuestra\s+cocina)\b/i, name: "Nuestra Cocina" },
  { match: /\b(?:campo\s+lindo)\b/i, name: "Campo Lindo" },
  { match: /\b(?:receta\s+del\s+abuelo)\b/i, name: "Receta del Abuelo" },
  { match: /\b(?:precio\s+uno)\b/i, name: "Precio Uno" },
  { match: /\b(?:super\s+pollo)\b/i, name: "Super Pollo" },
  { match: /\b(?:san\s+jorge)\b/i, name: "San Jorge" },
  { match: /\bsoprole\b/i, name: "Soprole" },
  { match: /\bloncoleche\b/i, name: "Loncoleche" },
  { match: /\bcolun\b/i, name: "Colun" },
  { match: /\bsurlat\b/i, name: "Surlat" },
  { match: /\bquillayes\b/i, name: "Quillayes" },
  { match: /\bnestle\b/i, name: "Nestlé" },
  { match: /\bcalo\b/i, name: "Calo" },
  { match: /\bdanone\b/i, name: "Danone" },
  { match: /\bchobani\b/i, name: "Chobani" },
  { match: /\bmiraflores\b/i, name: "Miraflores" },
  { match: /\bbelmont\b/i, name: "Belmont" },
  { match: /\bchef\b/i, name: "Chef" },
  { match: /\bnatura\b/i, name: "Natura" },
  { match: /\bmazola\b/i, name: "Mazola" },
  { match: /\bhuasco\b/i, name: "Huasco" },
  { match: /\bcarbonell\b/i, name: "Carbonell" },
  { match: /\btottus\b/i, name: "Tottus" },
  { match: /\blider\b/i, name: "Lider" },
  { match: /\bacuenta\b/i, name: "Acuenta" },
  { match: /\bmaxima\b/i, name: "Máxima" },
  { match: /\bcarozzi\b/i, name: "Carozzi" },
  { match: /\blucchetti\b/i, name: "Lucchetti" },
  { match: /\btalliani\b/i, name: "Talliani" },
  { match: /\bsadia\b/i, name: "Sadia" },
  { match: /\bariztia\b/i, name: "Ariztía" },
  { match: /\bpf\b/i, name: "PF" },
  { match: /\bcrianza\b/i, name: "Crianza" },
  { match: /\btucapel\b/i, name: "Tucapel" },
  { match: /\bbanquete\b/i, name: "Banquete" },
  { match: /\bomo\b/i, name: "Omo" },
  { match: /\bariel\b/i, name: "Ariel" },
  { match: /\bace\b/i, name: "Ace" },
  { match: /\bdrive\b/i, name: "Drive" },
  { match: /\bfuzol\b/i, name: "Fuzol" },
  { match: /\bcif\b/i, name: "Cif" },
  { match: /\bquix\b/i, name: "Quix" },
  { match: /\bvirginia\b/i, name: "Virginia" },
  { match: /\bpoett\b/i, name: "Poett" },
  { match: /\bclorinda\b/i, name: "Clorinda" },
  { match: /\bclorox\b/i, name: "Clorox" },
  { match: /\belite\b/i, name: "Elite" },
  { match: /\bconfort\b/i, name: "Confort" },
  { match: /\bscott\b/i, name: "Scott" },
  { match: /\bfavorita\b/i, name: "Favorita" },
  { match: /\bnoble\b/i, name: "Noble" },
  { match: /\bvirutex\b/i, name: "Virutex" },
  { match: /\biansa\b/i, name: "Iansa" },
  { match: /\bdaily\b/i, name: "Daily" },
  { match: /\bcachantun\b/i, name: "Cachantun" },
  { match: /\bvital\b/i, name: "Vital" },
  { match: /\bwatts\b/i, name: "Watts" },
  { match: /\bvivo\b/i, name: "Vivo" },
  { match: /\bzuko\b/i, name: "Zuko" },
  { match: /\blivean\b/i, name: "Livean" },
  { match: /\bmilo\b/i, name: "Milo" },
];

export function inferBrand(name = "", rawBrand = "") {
  const cleanedRaw = String(rawBrand || "").trim();
  const normRaw = normalizeText(cleanedRaw);
  if (normRaw && !["generico", "genérico", "sin marca", "n/a", "none"].includes(normRaw)) {
    const known = BRAND_PATTERNS.find((b) => b.match.test(normRaw));
    if (known) return known.name;
    return cleanedRaw
      .split(/\s+/)
      .map((w) => (w === "&" ? "&" : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join(" ");
  }

  const normName = normalizeText(name);
  const found = BRAND_PATTERNS.find((b) => b.match.test(normName));
  if (found) return found.name;
  return "Genérico / Marca Propia";
}

function normalizeTokenSynonym(word) {
  if (word === "proteina") return "protein";
  if (word === "yoghurt" || word === "yogur") return "yogurt";
  if (word === "lavalozas") return "lavaloza";
  return word;
}

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
    .map((t) => normalizeTokenSynonym(singularize(t)));
}

const STRICT_MODIFIER_TOKENS = new Set([
  "canola",
  "oliva",
  "maravilla",
  "protein",
  "proteina",
  "whey",
  "duquesa",
  "stevia",
  "sucralosa",
  "integral",
  "quinoa",
  "avena",
  "atun",
  "jurel",
  "salmon",
  "pechuga",
  "churrasco",
  "molida",
  "sopa",
  "caracolito",
  "caracolitos",
  "higienico",
  "basura",
  "detergente",
  "quitamanchas",
  "lavaloza",
  "lavalozas",
]);

/**
 * Filtro de pureza nutricional y de variedad ("No mezclar peras con manzanas").
 */
export function checkProductPurity(query = "", candidateName = "", candidateBrand = "") {
  const q = normalizeText(query);
  const c = normalizeText(`${candidateName} ${candidateBrand}`);
  if (!q || !c) {
    return { isPure: true, isBlend: false, purityTier: "pure", purityWarning: null, penaltyFactor: 1 };
  }

  // 1. Aceites: excluir mantequilla/margarina/conservas y validar variedad
  if (/\baceite\b/.test(q)) {
    if (/\b(mantequilla|margarina|mayonesa|atun|jurel|sardina|lomito|crema|barra|galleta)\b/.test(c)) {
      return {
        isPure: false,
        isBlend: false,
        purityTier: "mismatch",
        purityWarning: "⚠️ No es aceite líquido (es otro producto con aceite)",
        penaltyFactor: 0.15,
      };
    }
    if (/\bcanola\b/.test(q)) {
      if (!/\bcanola\b/.test(c)) {
        return {
          isPure: false,
          isBlend: false,
          purityTier: "mismatch",
          purityWarning: "⚠️ No es Aceite de Canola (es Maravilla/Vegetal/Otro)",
          penaltyFactor: 0.2,
        };
      }
      if (/\b(vegetal\s+con\s+canola|mezcla)\b/.test(c)) {
        return {
          isPure: true,
          isBlend: true,
          purityTier: "blend",
          purityWarning: "⚠️ Mezcla vegetal c/ canola (~85% soya, no 100% canola)",
          penaltyFactor: 0.82,
        };
      }
    }
    if (/\boliva\b/.test(q) && !/\boliva\b/.test(c)) {
      return {
        isPure: false,
        isBlend: false,
        purityTier: "mismatch",
        purityWarning: "⚠️ No es Aceite de Oliva",
        penaltyFactor: 0.2,
      };
    }
    if (/\bmaravilla\b/.test(q) && !/\bmaravilla\b/.test(c)) {
      return {
        isPure: false,
        isBlend: false,
        purityTier: "mismatch",
        purityWarning: "⚠️ No es Aceite de Maravilla",
        penaltyFactor: 0.2,
      };
    }
  }

  // 2. Leches / Yogures: excluir snacks, saborizantes en polvo y leches normales cuando se busca Protein
  if (/\b(leche|leches|yogurt|yoghurt|yogur)\b/.test(q)) {
    if (
      /\b(leche|leches)\b/.test(q) &&
      ((/\b(barra|galleta|cereal|manjar|crema|polvo\s+para|chocolate\s+en\s+barra)\b/.test(c) && !/\b(leche|leches)\b/.test(c)) ||
        (/\b(saborizante|en\s+polvo|polvo)\b/.test(c) && !/\b(polvo|saborizante)\b/.test(q)))
    ) {
      return {
        isPure: false,
        isBlend: false,
        purityTier: "mismatch",
        purityWarning: "⚠️ No es leche líquida (es saborizante/polvo/snack)",
        penaltyFactor: 0.15,
      };
    }
    if (/\b(protein|proteina|whey|skyr)\b/.test(q) && !/\b(protein|proteina|whey|skyr|full\s*pro|pro\+)\b/.test(c)) {
      return {
        isPure: false,
        isBlend: false,
        purityTier: "mismatch",
        purityWarning: "⚠️ No es línea Protein (es lácteo estándar)",
        penaltyFactor: 0.2,
      };
    }
  }

  // 3. Refrescos / Jugos en Polvo: no mezclar con frutas congeladas, néctares líquidos ni caramelos
  if (/\b(?:refresco|jugo\s+en\s+polvo|zuko|livean|sprim)\b/.test(q)) {
    if (
      /\b(mango|frutilla\s+congelada|caramelo|chupone?s|manjar|barra\s+de\s+fruta|compota|saborizante|cola\s+cao|agua\s+saborizada|limonada\s+.*1\s*l|nectar|gaseosa|fanta|bebida\s+.*1\.\d|500\s*g|180\s*g)\b/.test(
        c
      )
    ) {
      return {
        isPure: false,
        isBlend: false,
        purityTier: "mismatch",
        purityWarning: "⚠️ No es jugo en polvo en sobre (es fruta/líquido/dulce)",
        penaltyFactor: 0.15,
      };
    }
    const isPowderMatch = /\b(polvo|zuko|livean|sprim|vivo|instantane[oa]|refresco|bebida\s+instantanea)\b/.test(
      c
    );
    if (!isPowderMatch) {
      return {
        isPure: false,
        isBlend: false,
        purityTier: "mismatch",
        purityWarning: "⚠️ No es jugo en polvo equivalente",
        penaltyFactor: 0.2,
      };
    }
  }

  // 4. Cortes / Variedades críticas
  if (/\bduquesa\b/.test(q) && !/\bduquesa\b/.test(c)) {
    return {
      isPure: false,
      isBlend: false,
      purityTier: "mismatch",
      purityWarning: "⚠️ No son Papas Duquesa",
      penaltyFactor: 0.2,
    };
  }
  if (/\bpechuga\b/.test(q) && /\b(truto|alita|entero|pata|contramuslo)\b/.test(c)) {
    return {
      isPure: false,
      isBlend: false,
      purityTier: "mismatch",
      purityWarning: "⚠️ Corte distinto a Pechuga",
      penaltyFactor: 0.2,
    };
  }
  if (/\bchurrasco\b/.test(q) && !/\bchurrasco\b/.test(c)) {
    return {
      isPure: false,
      isBlend: false,
      purityTier: "mismatch",
      purityWarning: "⚠️ No es Churrasco",
      penaltyFactor: 0.2,
    };
  }

  // 4. Verificación general de modificadores estrictos
  const qWords = q.split(/[^a-z0-9]+/i).filter(Boolean);
  const cSet = new Set(c.split(/[^a-z0-9]+/i).filter(Boolean).map(normalizeTokenSynonym));
  for (const w of qWords) {
    if (STRICT_MODIFIER_TOKENS.has(w)) {
      const targetToken = normalizeTokenSynonym(singularize(w));
      const matched =
        cSet.has(targetToken) ||
        cSet.has(w) ||
        cSet.has(singularize(w)) ||
        (targetToken === "protein" && /\b(protein|proteina|whey|full\s*pro|pro\+)\b/.test(c));
      if (!matched) {
        return {
          isPure: false,
          isBlend: false,
          purityTier: "mismatch",
          purityWarning: "⚠️ No coincide con la variedad buscada",
          penaltyFactor: 0.25,
        };
      }
    }
  }

  return { isPure: true, isBlend: false, purityTier: "pure", purityWarning: null, penaltyFactor: 1 };
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

  const purity = checkProductPurity(query, candidateName);
  return Number(((hits / qTokens.length) * purity.penaltyFactor).toFixed(3));
}


// --- Inteligencia Nutricional y Densidad Proteica ($ / 10g de proteína + Score Nutricional) ---

function resolveNutritionProfile(norm, unit, brandNorm) {
  // 1. Proteína en polvo / Suplementos
  if (/\b(?:proteina\s+en\s+polvo|isolate|suplemento\s+proteico)\b/.test(norm) || (/\bwhey\b/.test(norm) && !/\bleche\b/.test(norm) && unit === "kg")) {
    return { gPer100: 75, score: 96, grade: "A+", badge: "💪 Suplemento Whey (~75g prot/100g) · Grado A+" };
  }

  // 2. Leches (diferenciadas por línea y densidad real)
  if (/\b(?:leche|leches)\b/.test(norm) && !/\b(barra|galleta|chocolate\s+en\s+barra|saborizante)\b/.test(norm)) {
    if (/\bfull\s*pro\b/.test(norm)) {
      return { gPer100: 10.0, score: 97, grade: "A+", badge: "🧬 100g prot/L (25g/envase Full Pro) · Grado A+" };
    }
    if (/\bpower\b/.test(norm) || (/\bsoprole\b/.test(norm + " " + brandNorm) && /\bpeanut\b/.test(norm))) {
      return { gPer100: 8.0, score: 96, grade: "A+", badge: "🧬 80g prot/L (16g/vaso Power) · Grado A+" };
    }
    if (/\bwhey\b/.test(norm) || (/\bloncoleche\b/.test(norm + " " + brandNorm) && /\b(protein|proteina)\b/.test(norm))) {
      return { gPer100: 7.0, score: 93, grade: "A+", badge: "🧬 70g prot/L (14g/vaso Whey) · Grado A+" };
    }
    if (/\bsoprole\b/.test(norm + " " + brandNorm) && /\b(protein|proteina|pro\+)\b/.test(norm)) {
      return { gPer100: 6.0, score: 88, grade: "A", badge: "🧬 60g prot/L (12g/vaso Protein+) · Grado A" };
    }
    if (/\b(surlat|colun|quillayes|calo)\b/.test(norm + " " + brandNorm) && /\b(protein|proteina)\b/.test(norm)) {
      return { gPer100: 5.0, score: 82, grade: "B", badge: "🧬 50g prot/L (10g/vaso) · Grado B" };
    }
    if (/\b(protein|proteina|pro\+)\b/.test(norm)) {
      return { gPer100: 6.0, score: 86, grade: "A", badge: "🧬 60g prot/L · Grado A" };
    }
    const stdScore = /\bdescremada\b/.test(norm) ? 66 : /\bsemidescremada\b/.test(norm) ? 62 : 58;
    return { gPer100: 3.1, score: stdScore, grade: "C", badge: "🥛 31g prot/L (Leche estándar · 6.2g/vaso)" };
  }

  // 3. Yogures (Power, Skyr/Griego, Protein+, En Simple, estándar)
  if (/\b(?:yoghurt|yogurt|yogur|skyr)\b/.test(norm)) {
    if (/\bpower\b/.test(norm)) {
      return { gPer100: 7.7, score: 94, grade: "A+", badge: "🧬 ~12g prot/pote (7.7g/100g Power) · Grado A+" };
    }
    if (/\bskyr\b/.test(norm) || (/\bgriego\b/.test(norm) && /\b(protein|proteina)\b/.test(norm))) {
      return { gPer100: 8.5, score: 95, grade: "A+", badge: "🧬 8.5g prot/100g (Skyr/Griego) · Grado A+" };
    }
    if (/\b(protein|proteina|pro\+)\b/.test(norm)) {
      return { gPer100: 6.5, score: 89, grade: "A", badge: "🧬 ~10g prot/pote (6.5g/100g Protein+) · Grado A" };
    }
    if (/\ben\s+simple\b/.test(norm)) {
      return { gPer100: 4.2, score: 76, grade: "B", badge: "🌿 5 Ingredientes (4.2g prot/100g) · Grado B" };
    }
    return { gPer100: 3.5, score: 60, grade: "C", badge: "🥛 3.5g prot/100g (Estándar)" };
  }

  // 4. Huevos por Calibre
  if (/\b(?:huevo|huevos)\b/.test(norm)) {
    if (/\b(?:super\s+extra|superextra|jumbo)\b/.test(norm)) {
      return { gPerUnit: 8.3, gPer100: 12.6, score: 96, grade: "A+", badge: "🥚 Calibre Super Extra (~68g · 8.3g prot/huevo) · Grado A+" };
    }
    if (/\b(?:extra|xl)\b/.test(norm)) {
      return { gPerUnit: 7.5, gPer100: 12.6, score: 92, grade: "A", badge: "🥚 Calibre Extra (~62g · 7.5g prot/huevo) · Grado A" };
    }
    if (/\b(?:grande|primera)\b/.test(norm)) {
      return { gPerUnit: 6.5, gPer100: 12.5, score: 85, grade: "A", badge: "🥚 Calibre Grande (~56g · 6.5g prot/huevo) · Grado A" };
    }
    if (/\b(?:mediano|segunda|pequeno|chico)\b/.test(norm)) {
      return { gPerUnit: 5.5, gPer100: 12.5, score: 74, grade: "B", badge: "🥚 Calibre Mediano (~48g · 5.5g prot/huevo) · Grado B" };
    }
    return { gPerUnit: 6.2, gPer100: 12.5, score: 80, grade: "B", badge: "🥚 Calibre Estándar (~53g · 6.2g prot/huevo) · Grado B" };
  }

  // 5. Carnes, Pollo y Pescados
  if (/\b(?:pechuga|filete\s+de\s+pollo|filetillo\s+de\s+pollo|pollo\s+pechuga|pollo\s+filete)\b/.test(norm)) {
    if (/\bmarinad[oa]\b/.test(norm)) {
      return { gPer100: 20.2, score: 82, grade: "B", badge: "💧 Pechuga Marinada (20.2g prot/100g · ~12% salmuera)" };
    }
    return { gPer100: 23.0, score: 96, grade: "A+", badge: "🍗 Pechuga 100% Magra (23g prot/100g · 1.5% grasa) · Grado A+" };
  }
  if (/\b(?:truto|pollo\s+entero|muslo|alita)\b/.test(norm) || /\bpollo\b/.test(norm)) {
    return { gPer100: 13.0, score: 72, grade: "B", badge: "🦴 Con Hueso (~68% carne útil · 13g prot/100g bruto)" };
  }
  if (/\bmolida\b/.test(norm)) {
    if (/\b(?:3%|4%|5%|3\s*%|4\s*%|5\s*%|especial|tartaro|magra)\b/.test(norm)) {
      return { gPer100: 22.0, score: 95, grade: "A+", badge: "🥩 Vacuno Magro ≤4% Grasa (22g prot/100g) · Grado A+" };
    }
    return { gPer100: 18.5, score: 76, grade: "B", badge: "🥩 Molida 10% Grasa (18.5g prot/100g) · Grado B" };
  }
  if (/\b(?:posta|lomo\s+liso|filete|pollo\s+ganso|choclillo|asiento)\b/.test(norm)) {
    return { gPer100: 21.5, score: 93, grade: "A", badge: "🥩 Corte Magro (21.5g prot/100g · ~4.5% grasa) · Grado A" };
  }
  if (/\b(?:churrasco|lomo\s+vetado|huachalomo|sobrecostilla|abastero|tapapecho|vacuno)\b/.test(norm)) {
    return { gPer100: 19.5, score: 82, grade: "B", badge: "🥩 Corte Intermedio (19.5g prot/100g · ~9% grasa) · Grado B" };
  }
  if (/\b(?:atun|jurel|salmon|merluza|reineta|pescado)\b/.test(norm)) {
    const isWater = /\bal\s+agua\b/.test(norm);
    return {
      gPer100: 23.5,
      score: isWater ? 96 : 88,
      grade: isWater ? "A+" : "A",
      badge: isWater
        ? "🐟 Al Agua (23.5g prot/100g · Omega-3) · Grado A+"
        : "🐟 Pescado Rico en Proteína (23.5g/100g) · Grado A",
    };
  }

  // 6. Aceites (perfil lipídico, sin proteína)
  if (/\baceite\b/.test(norm) && !/\b(?:mantequilla|margarina|atun|jurel|mayonesa)\b/.test(norm)) {
    if (/\boliva\b/.test(norm)) {
      return { gPer100: 0, noProtein: true, score: 98, grade: "A+", badge: "🫒 100% Oliva Extra Virgen (73% Omega-9) · Grado A+" };
    }
    if (/\b(?:vegetal\s+con\s+canola|mezcla)\b/.test(norm)) {
      return { gPer100: 0, noProtein: true, score: 68, grade: "B", badge: "⚠️ Mezcla Vegetal c/ Canola (~85% Soya + ~15% Canola) · Grado B" };
    }
    if (/\bcanola\b/.test(norm)) {
      return { gPer100: 0, noProtein: true, score: 92, grade: "A", badge: "🌼 100% Canola Pura (~10% Omega-3 · Solo 7% Sat.) · Grado A" };
    }
    if (/\bmaravilla\b/.test(norm)) {
      return { gPer100: 0, noProtein: true, score: 55, grade: "C", badge: "🌻 100% Maravilla (Alto Omega-6 · 0% Omega-3) · Grado C" };
    }
    return { gPer100: 0, noProtein: true, score: 48, grade: "C", badge: "🌱 Aceite Vegetal / Soya (15% Saturada) · Grado C" };
  }

  // 7. Otros básicos con proteína y Score Nutricional
  if (/\blentejas?\b/.test(norm)) return { gPer100: 24, score: 92, grade: "A", badge: "🫘 Legumbre Alta Fibra (24g prot/100g) · Grado A" };
  if (/\bgarbanzos?\b/.test(norm)) return { gPer100: 19, score: 90, grade: "A", badge: "🫘 Legumbre Rica en Fibra (19g prot/100g) · Grado A" };
  if (/\bporotos?\b/.test(norm)) return { gPer100: 21, score: 91, grade: "A", badge: "🫘 Legumbre Rica en Fibra (21g prot/100g) · Grado A" };
  if (/\b(?:quesillo|cottage)\b/.test(norm)) return { gPer100: 12, score: 88, grade: "A", badge: "🧀 Lácteo Magro (12g prot/100g) · Grado A" };
  if (/\b(?:queso\s+gauda|queso\s+chanco|queso\s+mantecoso|queso)\b/.test(norm)) return { gPer100: 23, score: 75, grade: "B", badge: "🧀 Queso (23g prot/100g · Mayor Grasa Sat.) · Grado B" };
  if (/\bavena\b/.test(norm)) return { gPer100: 13, score: 89, grade: "A", badge: "🌾 Grano Integral (13g prot/100g) · Grado A" };
  if (/\b(?:fideos|spaghetti|tallarines|espirales|pasta)\b/.test(norm)) return { gPer100: 12, score: 74, grade: "B", badge: "🍝 Carbohidrato Complejo (12g prot/100g) · Grado B" };
  if (/\barroz\b/.test(norm)) return { gPer100: 7.2, score: /\bintegral\b/.test(norm) ? 84 : 72, grade: "B", badge: "🍚 Cereal Base (7.2g prot/100g) · Grado B" };
  if (/\b(?:mani|nueces|almendras|pistachos|frutos\s+secos)\b/.test(norm)) return { gPer100: 22, score: 90, grade: "A", badge: "🥜 Grasas Saludables + Proteína (22g/100g) · Grado A" };
  if (/\b(?:tofu|soya|carne\s+de\s+soya)\b/.test(norm)) return { gPer100: 16, score: 88, grade: "A", badge: "🌱 Proteína Vegetal (16g/100g) · Grado A" };
  if (/\b(?:jamon\s+de\s+pavo|pechuga\s+de\s+pavo|jamon)\b/.test(norm)) return { gPer100: 17, score: 76, grade: "B", badge: "🥪 Fiambre (17g prot/100g) · Grado B" };
  if (/\b(?:pan\s+marraqueta|marraqueta|hallulla|pan\s+de\s+molde)\b/.test(norm)) return { gPer100: 8.5, score: /\bintegral\b/.test(norm) ? 78 : 66, grade: "B", badge: "🥖 Panadería (8.5g prot/100g)" };

  return null;
}

export function estimateNutritionMetrics(name = "", unit = "un", baseAmount = 1, price = 0, brand = "") {
  const norm = normalizeText(name);
  const brandNorm = normalizeText(brand);
  const matched = resolveNutritionProfile(norm, unit, brandNorm);

  if (!matched) {
    return {
      hasProteinData: false,
      hasNutritionData: false,
      proteinGramsTotal: null,
      proteinPer100g: null,
      pricePer10gProtein: null,
      nutritionScore: null,
      nutritionGrade: null,
      nutritionBadge: null,
    };
  }

  if (matched.noProtein) {
    return {
      hasProteinData: false,
      hasNutritionData: true,
      proteinGramsTotal: null,
      proteinPer100g: null,
      pricePer10gProtein: null,
      nutritionScore: matched.score,
      nutritionGrade: matched.grade,
      nutritionBadge: matched.badge,
    };
  }

  let totalGramsOfProtein = 0;
  const gPer100 = matched.gPer100 || 0;

  if (unit === "un" && matched.gPerUnit) {
    totalGramsOfProtein = baseAmount * matched.gPerUnit;
  } else if (unit === "kg") {
    const totalWeightGrams = baseAmount * 1000;
    totalGramsOfProtein = (totalWeightGrams / 100) * gPer100;
  } else if (unit === "lt") {
    const totalVolumeMl = baseAmount * 1000;
    totalGramsOfProtein = (totalVolumeMl / 100) * gPer100;
  } else {
    totalGramsOfProtein = (baseAmount / 100) * gPer100;
  }

  totalGramsOfProtein = Number(totalGramsOfProtein.toFixed(1));

  let pricePer10gProtein = null;
  if (totalGramsOfProtein > 0 && price > 0) {
    pricePer10gProtein = Math.round(price / (totalGramsOfProtein / 10));
  }

  return {
    hasProteinData: true,
    hasNutritionData: true,
    proteinGramsTotal: totalGramsOfProtein,
    proteinPer100g: gPer100,
    pricePer10gProtein,
    nutritionScore: matched.score,
    nutritionGrade: matched.grade,
    nutritionBadge: matched.badge,
  };
}

export function estimateProteinMetrics(name = "", unit = "un", baseAmount = 1, price = 0, brand = "") {
  return estimateNutritionMetrics(name, unit, baseAmount, price, brand);
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
