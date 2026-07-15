import { formatPrice, normalizeText } from '../utils';
import { ProductListEntry, CartItem } from '../types';

export function buildSelectionReply(
	product: ProductListEntry,
	currency: string,
): string {
	if (product.variants.length === 1) {
		const v = product.variants[0];
		const priceText = formatPrice(v.price, currency);
		const detail = v.name ? `${v.name} – ${priceText}` : priceText;
		return (
			`Perfecto 👌\n\n*${product.name}*\n${detail} · ${v.totalQty} disponibles` +
			'\n\n¿Le ayudo con la cotización o tiene alguna duda?'
		);
	}

	const variantLines = product.variants.map(v => {
		const priceText = formatPrice(v.price, currency);
		return `  - ${v.name} – ${priceText} (${v.totalQty} disponibles)`;
	});

	return (
		`Perfecto 👌\n\n*${product.name}* lo tenemos en estas presentaciones:\n\n` +
		variantLines.join('\n') +
		'\n\n¿Con cuál te quedas?'
	);
}

export function buildResumptionReply(product: ProductListEntry): string {
	const variantLines = product.variants.map(v => `• ${v.name}`).join('\n');
	return (
		`Hola 😊 retomamos donde lo dejamos.\n\nEstábamos viendo:\n\n*${product.name}*` +
		(product.description ? `\n_${product.description}_` : '') +
		(product.variants.length > 1 ? `\n${variantLines}` : '') +
		`\n\n¿Quiere continuar con ese o busca algo diferente?`
	);
}

/**
 * Coincidencia difusa entre dos PALABRAS: igualdad exacta siempre vale; la
 * contención (una dentro de la otra) SOLO cuando la palabra más corta tiene
 * al menos 4 letras. Sin este mínimo, tokens cortos producen falsos positivos
 * de identidad: "termometro" contiene "tr" y matchearía la base "TR
 * PLUS-TRANSPARENTE"; "encerada" contiene "cera", etc.
 */
export function fuzzyWordMatch(a: string, b: string): boolean {
	if (a === b) return true;
	const shorterLen = Math.min(a.length, b.length);
	if (shorterLen < 4) return false;
	return a.includes(b) || b.includes(a);
}

/**
 * Score de coincidencia (0..1) entre un hint del NLU y el nombre de un
 * producto/ítem: proporción de palabras del hint que coinciden, donde la
 * coincidencia exacta vale 1 y la parcial (substring) 0.5. Evita el falso
 * positivo de "cualquier palabra matchea cualquier ítem".
 */
export function scoreNameMatch(hint: string, candidate: string): number {
	const hintWords = normalizeText(hint)
		.split(/\s+/)
		.filter(w => w.length > 2);
	if (hintWords.length === 0) return 0;
	const candidateWords = normalizeText(candidate).split(/\s+/);
	let score = 0;
	for (const hw of hintWords) {
		if (candidateWords.some(cw => cw === hw)) score += 1;
		else if (candidateWords.some(cw => fuzzyWordMatch(cw, hw))) score += 0.5;
	}
	return score / hintWords.length;
}

/**
 * true si TODAS las palabras significativas del hint coinciden (al menos
 * parcialmente) en el candidato. Determina identidad de producto: "aceite de
 * coco" NO es "Aceite Vegetal Ricino" aunque compartan la palabra "aceite".
 */
export function allHintWordsMatch(hint: string, candidate: string): boolean {
	const hintWords = normalizeText(hint)
		.split(/\s+/)
		.filter(w => w.length > 2);
	if (hintWords.length === 0) return false;
	const candidateWords = normalizeText(candidate).split(/\s+/);
	return hintWords.every(hw =>
		candidateWords.some(cw => fuzzyWordMatch(cw, hw)),
	);
}

export function resolveVariant(
	product: ProductListEntry,
	hint?: string,
	userText?: string,
): ProductListEntry['variants'][0] | undefined {
	if (product.variants.length === 1) return product.variants[0];

	// 1) Hint-based match
	if (hint) {
		const normalizedHint = normalizeText(hint);
		const match =
			product.variants.find(v =>
				normalizeText(v.name).includes(normalizedHint),
			) ??
			product.variants.find(v =>
				normalizedHint.includes(normalizeText(v.name)),
			);
		if (match) return match;
	}

	// 2) User text keyword match: score each variant by how many of its
	//    distinctive words appear in the message
	if (userText) {
		const normalized = normalizeText(userText);
		let bestVariant: ProductListEntry['variants'][0] | undefined;
		let bestScore = 0;
		for (const v of product.variants) {
			const vWords = normalizeText(v.name)
				.split(/\s+/)
				.filter((w: string) => w.length > 1);
			const score = vWords.filter((w: string) => normalized.includes(w)).length;
			if (score > bestScore) {
				bestScore = score;
				bestVariant = v;
			}
		}
		if (bestVariant && bestScore > 0) return bestVariant;
	}

	// 3) Fallback: pick variant with highest stock (most popular)
	return product.variants.reduce((best, v) =>
		v.totalQty > best.totalQty ? v : best,
	);
}

/**
 * Convierte el nombre de una variante a gramos cuando es posible.
 * Ej: "100g" → 100, "Medio Kilo" → 500, "KILO" → 1000, "(APROX. 20 unidades)" → null
 */
export function parseVariantWeightGrams(variantName: string): number | null {
	const normalized = variantName.toLowerCase().trim();
	// "Medio Kilo" → 500g
	if (/\bmedio\s*kilo\b/.test(normalized)) return 500;
	// "1 kilo", "2 kilos", "1kg" → gramos
	const kiloMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*(?:kilo[s]?|kg)/);
	if (kiloMatch) return parseFloat(kiloMatch[1].replace(',', '.')) * 1000;
	// "kilo" o "kilos" sin número → 1000g
	if (/^\s*kilo[s]?\s*$/.test(normalized)) return 1000;
	// "100g", "250gr", "500 gramos" → gramos directos
	const gramMatch = normalized.match(
		/(\d+(?:[.,]\d+)?)\s*(?:gr(?:amo[s]?)?|g\b)/,
	);
	if (gramMatch) return parseFloat(gramMatch[1].replace(',', '.'));
	return null;
}

/**
 * Detecta si el texto del cliente especifica una cantidad por peso.
 * Devuelve el peso en gramos, o null si no hay unidad de peso reconocible.
 */
export function detectRequestedWeightGrams(text: string): number | null {
	const weightMatch = text.match(
		/\b(\d+(?:[.,]\d+)?)\s*(kilo[s]?|kg|gramo[s]?|gr|g)\b/i,
	);
	if (!weightMatch) return null;
	const val = parseFloat(weightMatch[1].replace(',', '.'));
	const unit = weightMatch[2].toLowerCase();
	return unit.startsWith('k') ? val * 1000 : val;
}

/**
 * Umbral (en gramos) a partir del cual un peso pedido SIN presentación explícita
 * deja de asumirse: el cliente podría querer kilos sueltos o un bloque/caja, así
 * que se le pregunta. Por debajo del umbral se resuelve directo a kilos sueltos.
 * Regla de negocio: "si pide 10 o más kilos sin especificar, hay que preguntar".
 */
export const PRESENTATION_AMBIGUITY_MIN_GRAMS = 10000;

/**
 * Interpreta la PREFERENCIA de presentación que el cliente expresó en texto libre
 * (o que el NLU pasó como hint): a granel ("bloque", "caja", "bulto") o suelta
 * ("de a kilo", "por kilo", "unidades", "sueltos"). Devuelve undefined si el texto
 * no expresa una preferencia clara (ej. solo un peso: "10 kilos").
 * Nota: es una lectura léxica del hint, NO clasificación de intención (eso lo hace el NLU).
 */
export function classifyPresentationPreference(
	text: string | undefined,
): 'bulk' | 'unit' | undefined {
	if (!text) return undefined;
	const t = normalizeText(text);
	if (/\b(bloque|bloques|caja|cajas|bulto|bultos|paca|pacas)\b/.test(t))
		return 'bulk';
	if (
		/\bde a kilo\b|\bpor kilos?\b|\bkilos? suelt/.test(t) ||
		/\b(unidad|unidades|individual|individuales|suelto|suelta|sueltos|sueltas)\b/.test(
			t,
		)
	)
		return 'unit';
	return undefined;
}

export type WeightedPresentationResult =
	| { mode: 'resolved'; variant: ProductListEntry['variants'][0]; units: number }
	| {
			mode: 'ambiguous';
			kilo: { variant: ProductListEntry['variants'][0]; units: number };
			bulk: Array<{ variant: ProductListEntry['variants'][0]; units: number }>;
	  }
	| { mode: 'none' };

/**
 * Política de resolución de un peso pedido contra las presentaciones de un
 * producto DUAL (se vende por KILO y también a granel: bloque/caja):
 * - Preferencia explícita del cliente ('bulk'/'unit') → resuelve directo a esa forma.
 * - Sin preferencia y peso < umbral → kilos sueltos (ej. "4 kilos" = 4 × KILO).
 * - Sin preferencia y peso ≥ umbral con opción a granel exacta → AMBIGUO (preguntar).
 * Devuelve { mode: 'none' } cuando el producto no es dual o el peso no aplica a esta
 * política; en ese caso el caller usa resolveVariantByWeight (comportamiento estándar).
 */
export function resolveWeightedPresentation(
	variants: ProductListEntry['variants'],
	requestedGrams: number,
	preference?: 'bulk' | 'unit',
): WeightedPresentationResult {
	if (requestedGrams <= 0) return { mode: 'none' };
	const weighted = variants
		.map(v => ({ variant: v, grams: parseVariantWeightGrams(v.name) }))
		.filter(
			(x): x is { variant: ProductListEntry['variants'][0]; grams: number } =>
				x.grams !== null && x.grams > 0,
		);
	if (weighted.length === 0) return { mode: 'none' };

	const inStock = weighted.filter(w => w.variant.totalQty > 0);
	const pool = inStock.length > 0 ? inStock : weighted;

	const kilo = pool.find(w => w.grams === 1000);
	const hasBulk = pool.some(w => w.grams > 1000);
	// Solo intervenimos en productos DUALES (KILO + presentación mayor).
	if (!kilo || !hasBulk) return { mode: 'none' };

	const units = (grams: number) => Math.ceil(requestedGrams / grams);
	// Opciones a granel que cubren EXACTAMENTE el peso pedido (mayor primero: bloque antes que caja)
	const bulks = pool
		.filter(w => w.grams > 1000 && requestedGrams % w.grams === 0)
		.sort((a, b) => b.grams - a.grams);

	// Preferencia explícita del cliente
	if (preference === 'unit')
		return { mode: 'resolved', variant: kilo.variant, units: units(kilo.grams) };
	if (preference === 'bulk' && bulks.length > 0)
		return {
			mode: 'resolved',
			variant: bulks[0].variant,
			units: units(bulks[0].grams),
		};

	// Sin preferencia: solo aplica a pesos múltiplos exactos de 1 kilo
	if (requestedGrams % 1000 !== 0) return { mode: 'none' };
	if (requestedGrams < PRESENTATION_AMBIGUITY_MIN_GRAMS)
		return { mode: 'resolved', variant: kilo.variant, units: units(kilo.grams) };
	if (bulks.length > 0)
		return {
			mode: 'ambiguous',
			kilo: { variant: kilo.variant, units: units(kilo.grams) },
			bulk: bulks.map(b => ({ variant: b.variant, units: units(b.grams) })),
		};
	return { mode: 'none' };
}

/**
 * Dado un peso en gramos y las variantes de un producto, devuelve la variante
 * más adecuada y la cantidad de unidades necesarias.
 *
 * Lógica:
 * 1. Preferir variantes donde `requestedGrams` sea múltiplo exacto de la variante.
 * 2. Entre candidatos exactos (o todos si no hay exactos), preferir la que da
 *    MENOS unidades (más eficiente para el cliente).
 */
export function resolveVariantByWeight(
	variants: ProductListEntry['variants'],
	requestedGrams: number,
): { variant: ProductListEntry['variants'][0]; units: number } | null {
	const weighted = variants
		.map(v => ({ variant: v, grams: parseVariantWeightGrams(v.name) }))
		.filter(
			(vw): vw is { variant: ProductListEntry['variants'][0]; grams: number } =>
				vw.grams !== null && vw.grams > 0,
		);
	if (weighted.length === 0) return null;

	const exactMatches = weighted.filter(vw => requestedGrams % vw.grams === 0);
	const candidates = exactMatches.length > 0 ? exactMatches : weighted;

	// Menor cantidad de unidades = presentación más práctica para la cantidad pedida
	const best = candidates.reduce((a, b) => {
		const unitsA = Math.ceil(requestedGrams / a.grams);
		const unitsB = Math.ceil(requestedGrams / b.grams);
		return unitsB < unitsA ? b : a;
	});

	return {
		variant: best.variant,
		units: Math.ceil(requestedGrams / best.grams),
	};
}

/**
 * Construye el mensaje que pregunta al cliente qué quiere hacer
 * con los ítems del carrito que no tienen stock suficiente.
 */
export function buildOutOfStockResolutionMessage(
	blockedItemsContext: Array<{
		item: CartItem;
		availableStock: number;
		alternatives: Array<{
			variantId: string;
			name: string;
			stock: number;
			unitPrice: string | null;
		}>;
	}>,
): string {
	const lines: string[] = [];

	for (const blocked of blockedItemsContext) {
		const name = blocked.item.variantName
			? `${blocked.item.productName} ${blocked.item.variantName}`
			: blocked.item.productName;

		if (blocked.availableStock > 0) {
			lines.push(
				`⚠️ *${name}*: solo hay ${blocked.availableStock} unidades disponibles de las ${blocked.item.quantity} que pediste. ¿Las incluyo en el pedido?`,
			);
		} else {
			lines.push(
				`⚠️ *${name}*: no hay stock disponible. ¿Lo omito del pedido?`,
			);
		}
	}

	return lines.join('\n\n');
}
