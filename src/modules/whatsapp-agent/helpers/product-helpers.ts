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
	if (!weightMatch) {
		// Sin número: "medio kilo", "un kilo"
		if (/\bmedio\s*kilo\b/i.test(text)) return 500;
		if (/\b(un|1)\s+kilo\b/i.test(text)) return 1000;
		return null;
	}
	const val = parseFloat(weightMatch[1].replace(',', '.'));
	const unit = weightMatch[2].toLowerCase();
	return unit.startsWith('k') ? val * 1000 : val;
}

/**
 * Convierte el nombre de una variante a mililitros cuando es posible.
 * Ej: "20 ml" → 20, "20 cc" → 20, "1 lt" → 1000, "Medio Litro" → 500
 */
export function parseVariantVolumeMl(variantName: string): number | null {
	const normalized = normalizeText(variantName);
	if (/\bmedio\s*litro\b/.test(normalized)) return 500;
	const literMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*(?:litros?|lts?|l)\b/);
	if (literMatch) return parseFloat(literMatch[1].replace(',', '.')) * 1000;
	if (/^\s*litros?\s*$/.test(normalized)) return 1000;
	const mlMatch = normalized.match(
		/(\d+(?:[.,]\d+)?)\s*(?:ml|mililitros?|cc)\b/,
	);
	if (mlMatch) return parseFloat(mlMatch[1].replace(',', '.'));
	return null;
}

/**
 * Cantidad pedida o de una presentación en su dimensión: gramos para peso,
 * mililitros para volumen. Solo se comparan medidas de la misma dimensión: 500 ml
 * no se resuelve contra una presentación de 500 g
 */
export type Measure = { dimension: 'mass' | 'volume'; base: number };

/** Abreviatura con la que se nombra la base de cada dimensión en los mensajes */
export const MEASURE_BASE_LABEL: Record<Measure['dimension'], string> = {
	mass: 'g',
	volume: 'ml',
};

/**
 * Unidad para hablarle al cliente de una cantidad: el peso siempre en kg; el
 * volumen en litros desde 1 litro y en ml por debajo
 */
export function measureLabelUnit(measure: Measure): 'kg' | 'litros' | 'ml' {
	if (measure.dimension === 'mass') return 'kg';
	return measure.base >= 1000 ? 'litros' : 'ml';
}

/** "2 kg", "1.5 litros", "500 ml" */
export function formatMeasureAmount(
	measure: Measure,
	unit: ReturnType<typeof measureLabelUnit> = measureLabelUnit(measure),
): string {
	const value = unit === 'ml' ? measure.base : measure.base / 1000;
	return `${value % 1 === 0 ? value : value.toFixed(1)} ${unit}`;
}

export function parseVariantMeasure(variantName: string): Measure | null {
	const grams = parseVariantWeightGrams(variantName);
	if (grams !== null) return { dimension: 'mass', base: grams };
	const ml = parseVariantVolumeMl(variantName);
	if (ml !== null) return { dimension: 'volume', base: ml };
	return null;
}

/** La medida de la presentación en la dimensión pedida, o null si es de otra */
export function variantAmountIn(
	variantName: string,
	dimension: Measure['dimension'],
): number | null {
	const measure = parseVariantMeasure(variantName);
	return measure?.dimension === dimension ? measure.base : null;
}

/**
 * Detecta si el texto del cliente especifica una cantidad por peso o por
 * volumen ("2 kilos", "500 ml", "1 litro", "20 cc").
 */
export function detectRequestedMeasure(text: string): Measure | null {
	const grams = detectRequestedWeightGrams(text);
	if (grams !== null) return { dimension: 'mass', base: grams };
	const volumeMatch = text.match(
		/\b(\d+(?:[.,]\d+)?)\s*(litros?|lts?|l|mililitros?|ml|cc)\b/i,
	);
	if (volumeMatch) {
		const val = parseFloat(volumeMatch[1].replace(',', '.'));
		const unit = volumeMatch[2].toLowerCase();
		const isLiter = unit.startsWith('l');
		return { dimension: 'volume', base: isLiter ? val * 1000 : val };
	}
	if (/\bmedio\s*litro\b/i.test(text)) return { dimension: 'volume', base: 500 };
	if (/\bun\s+litro\b/i.test(text)) return { dimension: 'volume', base: 1000 };
	return null;
}

const NUMBER_WORDS: Record<string, number> = {
	un: 1,
	una: 1,
	uno: 1,
	dos: 2,
	tres: 3,
	cuatro: 4,
	cinco: 5,
	seis: 6,
	siete: 7,
	ocho: 8,
	nueve: 9,
	diez: 10,
};

/**
 * La cantidad con que empieza el mensaje ("un bloque de soya", "2 mechas"), o
 * null si no empieza con una. Espera el texto ya normalizado
 */
export function leadingQuantity(normalizedText: string): number | null {
	const first = normalizedText.trim().split(/\s+/)[0] ?? '';
	if (/^\d{1,3}$/.test(first)) {
		const n = parseInt(first, 10);
		return n > 0 ? n : null;
	}
	return NUMBER_WORDS[first] ?? null;
}

const NUMBER_TOKEN = `(?:\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;
// "la 1", "el 2", "opción 3", "número 1": es la opción elegida, no la cantidad
const SELECTION_REF = new RegExp(
	`\\b(?:la|el|las|los|opcion|numero|nro)\\s+${NUMBER_TOKEN}\\b`,
	'g',
);
const QUANTITY_TOKEN = new RegExp(`\\b${NUMBER_TOKEN}\\b`, 'g');

/**
 * true si al elegir una opción el cliente dijo también cuántas quiere ("2 de la
 * 1", "la 1, tres unidades"). "bueno, la 1" o "1" solos no traen cantidad: el
 * número es la opción. Espera el texto ya normalizado
 */
export function statesQuantityBesidesSelection(
	normalizedText: string,
	selectionIndexes: number[],
): boolean {
	const rest = normalizedText.replace(SELECTION_REF, ' ');
	const numbers = rest.match(QUANTITY_TOKEN) ?? [];
	if (numbers.length === 0) return false;
	// Un número suelto en un mensaje corto ("1", "ok 2") es la opción
	const onlyNumber = numbers[0] as string;
	const value = /^\d+$/.test(onlyNumber)
		? parseInt(onlyNumber, 10)
		: NUMBER_WORDS[onlyNumber];
	if (
		rest === normalizedText &&
		numbers.length === 1 &&
		value !== undefined &&
		selectionIndexes.includes(value) &&
		normalizedText.split(/\s+/).length <= 3
	) {
		return false;
	}
	return true;
}

const MEASURE_UNIT =
	'(?:kg|kgs|kilos?|k|gr|grs|g|gramos?|lt|lts|l|litros?|ml|mililitros?|cc)';
const MEASURE_AMOUNT = `(?:\\d+\\s*${MEASURE_UNIT}|(?:un|una|medio)\\s+(?:kilo|litro))`;
const PACKAGE_FORM = '(?:bloque|caja|bulto|paca|bolsa|frasco|tarro|galon|garrafa)s?';

// "de 10 kg", "la que viene en 10 kilos", "en 500 ml", "presentación de 1 litro"
const PRESENTATION_CUE = new RegExp(
	`\\bde\\s+${MEASURE_AMOUNT}\\b` +
		`|\\bvienen?\\s+(?:en|de|por|x)\\s+${MEASURE_AMOUNT}\\b` +
		`|\\ben\\s+${MEASURE_AMOUNT}\\b` +
		`|\\bpresentacion(?:es)?\\b` +
		`|\\b${PACKAGE_FORM}\\s+(?:de\\s+|x\\s+)?${MEASURE_AMOUNT}\\b`,
);
// "10 kilos de cera": una cantidad del producto, no el tamaño del empaque
const QUANTITY_OF_PRODUCT = new RegExp(`\\b${MEASURE_AMOUNT}\\s+(?:de|del)\\b`);
const ASKING =
	/\b(tienes|tienen|tiene|tendras|tendran|hay|manejas|manejan|maneja|vendes|venden|vende|existe|existen|viene|vienen|pregunto|saber)\b/;
// Un pedido en imperativo ("dame la de 1 kg") no es una pregunta por la presentación
const ORDER_VERB =
	/\b(dame|deme|damelo|regalame|regaleme|agrega|agregame|agregue|agregueme|anade|anademe|ponme|pongame|mandame|mandeme|enviame|envieme|facturame|factureme|vendeme|vendame|despachame|despacheme)\b/;

/**
 * true cuando el cliente PREGUNTA si existe una presentación concreta ("¿no
 * tienes de 10 kg?", "¿la tienes en 500 ml?"), no cuando pide una cantidad
 * ("¿tienen 10 kilos de cera?") ni cuando ordena ("dame la de 1 kg").
 * Las frases típicas de presentación se reconocen aquí; el NLU cubre las demás,
 * salvo que el texto tenga la forma de una cantidad del producto
 */
export function isPresentationQuestion(
	text: string,
	nluSaysPresentation: boolean | undefined,
): boolean {
	const t = normalizeText(text);
	if (!(text.includes('?') || ASKING.test(t))) return false;
	if (ORDER_VERB.test(t)) return false;
	if (PRESENTATION_CUE.test(t)) return true;
	return nluSaysPresentation === true && !QUANTITY_OF_PRODUCT.test(t);
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

export type PresentationForm = 'bloque' | 'caja' | 'bulto' | 'paca';

/**
 * La forma que nombró el cliente ("un bloque", "en caja"), en singular. Qué
 * presentación es un bloque lo dice su nombre en el catálogo, no su peso: en la
 * soya el bloque es de 1 kg y en otros productos puede no existir
 */
export function presentationFormKeyword(
	text: string | undefined,
): PresentationForm | undefined {
	if (!text) return undefined;
	const match = normalizeText(text).match(/\b(bloque|caja|bulto|paca)s?\b/);
	return match?.[1] as PresentationForm | undefined;
}

/** true si la presentación se llama con esa forma: "Bloque x 1 kg" para "bloque" */
export function variantHasForm(name: string, form: PresentationForm): boolean {
	return new RegExp(`\\b${form}s?\\b`).test(normalizeText(name));
}

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
	/** La forma que nombró el cliente: solo cuentan las presentaciones que la llevan en el nombre */
	form?: PresentationForm,
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
		.filter(w => !form || variantHasForm(w.variant.name, form))
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
	return resolveVariantByMeasure(variants, {
		dimension: 'mass',
		base: requestedGrams,
	});
}

/**
 * Lo mismo que `resolveVariantByWeight` para peso o volumen: solo considera las
 * presentaciones de la misma dimensión que lo pedido
 */
export function resolveVariantByMeasure(
	variants: ProductListEntry['variants'],
	requested: Measure,
): { variant: ProductListEntry['variants'][0]; units: number } | null {
	const measured = variants
		.map(v => ({
			variant: v,
			amount: variantAmountIn(v.name, requested.dimension),
		}))
		.filter(
			(vm): vm is { variant: ProductListEntry['variants'][0]; amount: number } =>
				vm.amount !== null && vm.amount > 0,
		);
	if (measured.length === 0) return null;

	// Solo presentaciones que cubren la cantidad exacta. Redondear hacia arriba
	// convertía "medio litro" en 1 litro sin preguntar
	const candidates = measured.filter(vm => requested.base % vm.amount === 0);
	if (candidates.length === 0) return null;

	// Menor cantidad de unidades = presentación más práctica para la cantidad pedida
	const best = candidates.reduce((a, b) => {
		const unitsA = Math.ceil(requested.base / a.amount);
		const unitsB = Math.ceil(requested.base / b.amount);
		return unitsB < unitsA ? b : a;
	});

	return {
		variant: best.variant,
		units: Math.ceil(requested.base / best.amount),
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
