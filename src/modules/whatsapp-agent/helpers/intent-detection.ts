import { normalizeText, stemTerm, SYNONYMS } from '../utils';
import { ProductListEntry } from '../types';

export function stripCallingCode(phoneNumber: string): string {
	const prefixes = ['593', '57']; // longest first
	const matched = prefixes.find(p => phoneNumber.startsWith(p));
	return matched ? phoneNumber.slice(matched.length) : phoneNumber;
}

/**
 * Returns an intent only for cases the backend can resolve deterministically
 * (show_more, affirmation, show_cart). Returns null when uncertain
 * so the AI can take over.
 */
export function detectDeterministicIntent(
	normalizedText: string,
): string | null {
	const showMorePhrases = [
		'ver mas',
		'mas opciones',
		'quiero ver mas',
		'muestrame mas',
		'muestra mas',
		'hay mas',
		'tienes mas',
		'tienen mas',
		'no tienen mas',
		'no tienes mas',
		'no hay mas',
		'mostrar mas',
		'ver otras',
		'ver otros',
		'otras opciones',
		'otras alternativas',
		'alguna otra',
		'alguna mas',
		'algun otro',
		'tienen otra',
		'tienen otro',
		'tienen alguna',
		'tienes otra',
		'tienes otro',
		'mas productos',
		'ver mas opciones',
		'quiero ver otras',
		'quiero mas',
		'ver siguiente',
		'ver siguientes',
		'nada mas',
		'no tienen nada mas',
		'no tienes nada mas',
	];
	const showMoreExact = /^(mas|otros|otras|siguiente|siguientes)[,!.\s?]*$/i;
	// Si el mensaje dice "tienes más X" o "más opciones de X" con un sustantivo
	// tras el modificador, es una búsqueda nueva. Ej: "tienes más mechas"
	const showMoreWithProductRegex =
		/(?:tienes\s+mas|tienen\s+mas|hay\s+mas|mas\s+opciones\s+de|mas\s+tipos\s+de)\s+\w/i;
	if (
		!showMoreWithProductRegex.test(normalizedText) &&
		(showMorePhrases.some(p => normalizedText.includes(p)) ||
			showMoreExact.test(normalizedText.trim()))
	)
		return 'show_more';

	// Afirmación con cantidad explícita: "Sí, dame 5", "si quiero 3", "ok ponme 2"
	const affirmationWithQtyRegex =
		/^(si|vale|ok|dale|claro|listo|perfecto|bueno|de acuerdo|va|venga|obvio)[,\s!.]+(?:(?:dame|quiero|ponme|pon|agrega|necesito|llevo|llevame|mandame|enviame)\s+)?\d+\b/i;
	if (affirmationWithQtyRegex.test(normalizedText.trim())) return 'affirmation';

	const isAffirmationOnly =
		/^(si|vale|ok|dale|claro|listo|perfecto|bueno|de acuerdo|va|venga|obvio)[,!.\s?]*$/i.test(
			normalizedText.trim(),
		);
	if (isAffirmationOnly) return 'affirmation';

	const showCartPhrases = [
		'que llevamos',
		'que llevo',
		'mi carrito',
		'ver carrito',
		'ver pedido',
		'mi pedido',
		'lo que llevo',
		'lo que llevamos',
		'lo que tengo',
		'resumen del pedido',
		'mostrame el pedido',
		'muestrame el pedido',
		'muestrame que llevamos',
		'muestrame que llevo',
		'que hay en el carrito',
		'que tengo en el carrito',
		'cuanto seria el total',
		'cuanto seria por todo',
		'cuanto es el total',
		'cuanto es por todo',
		'cuanto va el total',
		'cuanto va todo',
		'cuanto es todo',
		'cuanto seria todo',
		'cuanto suma todo',
		'cuanto me sale todo',
		'cuanto me saldria todo',
		'cuanto seria en total',
		'a cuanto sube todo',
		'a cuanto llega todo',
		'a cuanto llega el total',
	];
	if (showCartPhrases.some(p => normalizedText.includes(p))) return 'show_cart';

	const requestQuotePhrases = [
		'cotizacion',
		'cotización',
		'cotizar',
		'cotizame',
		'cotizalo',
		'cotizalos',
		'presupuesto',
		'proforma',
		'hazme una cotizacion',
		'genera la cotizacion',
		'arma la cotizacion',
		'quiero cotizar',
		'quiero la cotizacion',
		'me generas la cotizacion',
		'enviame la cotizacion',
	];
	if (requestQuotePhrases.some(p => normalizedText.includes(p)))
		return 'request_quote';

	const purchaseIntentPhrases = [
		'quiero comprar',
		'quiero pagar',
		'como pago',
		'cómo pago',
		'como compro',
		'cómo compro',
		'finalizar pedido',
		'finalizar compra',
		'completar compra',
		'completar pedido',
		'quiero proceder',
		'proceder con el pago',
		'hacer el pago',
		'realizar el pago',
		'pagar mi pedido',
	];
	if (purchaseIntentPhrases.some(p => normalizedText.includes(p)))
		return 'purchase_intent';

	return null;
}

/**
 * Retorna true si el texto normalizado es un cierre de conversación puro:
 * agradecimiento o despedida sin ninguna solicitud de producto implícita.
 * Requiere: (1) todos los tokens en el vocabulario de cierre, Y
 *           (2) al menos un token es una "palabra ancla" de cierre.
 */
export function isFarewellOnly(normalizedText: string): boolean {
	const farewellVocabulary = new Set([
		// palabras ya presentes en pureGreetingOrAckWords que aplican a cierres
		'gracias',
		'ok',
		'perfecto',
		'genial',
		'entendido',
		'listo',
		'claro',
		'dale',
		'excelente',
		'super',
		'vale',
		'si',
		'bueno',
		'bien',
		'todo',
		// palabras de agradecimiento/cierre que NO están en pureGreetingOrAckWords
		'muchas',
		'mil',
		'muy',
		'amable',
		'agradezco',
		'te',
		'le',
		'les',
		'quedo',
		'quedamos',
		'pendiente',
		'pendientes',
		'de',
		'nada',
		'con',
		'gusto',
		'mucho',
		'bastante',
		'gentil',
		'atento',
		'atenta',
		'placer',
		'fue',
		'un',
		'una',
		'igual',
		'igualmente',
		'tambien',
	]);
	const anchorWords = new Set([
		'gracias',
		'agradezco',
		'amable',
		'pendiente',
		'pendientes',
		'quedamos',
		'placer',
		'gentil',
		'atento',
		'atenta',
	]);
	const tokens = normalizedText
		.trim()
		.split(/\s+/)
		.filter(w => w.length > 0);
	if (tokens.length === 0) return false;
	const allInVocabulary = tokens.every(w => farewellVocabulary.has(w));
	const hasAnchor = tokens.some(w => anchorWords.has(w));
	return allInVocabulary && hasAnchor;
}

export function detectIntent(normalizedText: string): string {
	const objectionPhrases = [
		'muy caro',
		'esta caro',
		'es caro',
		'caro',
		'no me alcanza',
		'no tengo',
		'sin dinero',
		'sin plata',
		'no tengo plata',
		'no tengo dinero',
		'lo pienso',
		'lo voy a pensar',
		'voy a pensar',
		'pensarlo',
		'despues',
		'luego',
		'mas adelante',
		'otro dia',
		'ahorita no',
		'por ahora no',
		'no por ahora',
		'lo consulto',
		'te aviso',
		'no me interesa',
		'ya no',
		'dejalo',
		'dejame pensar',
	];

	const hasObjection = objectionPhrases.some(phrase =>
		normalizedText.includes(phrase),
	);
	if (hasObjection) return 'objection';

	const showMorePhrases = [
		'ver mas',
		'mas opciones',
		'quiero ver mas',
		'muestrame mas',
		'muestra mas',
		'hay mas',
		'tienes mas',
		'mostrar mas',
		'ver otras',
		'ver otros',
		'otras opciones',
		'otras alternativas',
		'mas productos',
		'ver mas opciones',
		'quiero ver otras',
		'quiero mas',
		'ver siguiente',
		'ver siguientes',
	];
	const showMoreExact = /^(mas|otros|otras|siguiente|siguientes)[,!.\s?]*$/i;
	if (
		showMorePhrases.some(p => normalizedText.includes(p)) ||
		showMoreExact.test(normalizedText.trim())
	)
		return 'show_more';

	const isAffirmationOnly =
		/^(si|vale|ok|dale|claro|listo|perfecto|bueno|de acuerdo|va|venga|obvio)[,!.\s?]*$/i.test(
			normalizedText.trim(),
		);
	if (isAffirmationOnly) return 'affirmation';

	// Detectar cierre de conversación ANTES de productKeywords para evitar
	// que palabras como "muchas", "mil", "amable" se traten como términos de búsqueda
	if (isFarewellOnly(normalizedText)) return 'farewell';

	const productKeywords = [
		'producto',
		'precio',
		'tienes',
		'tienen',
		'hay',
		'busco',
		'buscando',
		'buscar',
		'buscas',
		'quiero',
		'necesito',
		'cuesta',
		'vale',
		'disponible',
		'stock',
		'venden',
		'vende',
		'interesa',
		'vendes',
	];
	const hasProductKeyword = productKeywords.some(kw =>
		normalizedText.includes(kw),
	);
	if (hasProductKeyword) return 'search_product';

	const words = normalizedText.split(' ');
	const knownProductTerms = new Set(Object.keys(SYNONYMS));
	const hasKnownProductTerm = words.some(
		w => knownProductTerms.has(w) || knownProductTerms.has(stemTerm(w)),
	);
	if (hasKnownProductTerm) return 'search_product';

	const pureGreetingOrAckWords = new Set([
		'hola',
		'ola',
		'hey',
		'buenos',
		'buenas',
		'buen',
		'dias',
		'tardes',
		'noches',
		'madrugada',
		'como',
		'estas',
		'esta',
		'tal',
		'bien',
		'todo',
		'gracias',
		'ok',
		'perfecto',
		'genial',
		'entendido',
		'listo',
		'claro',
		'dale',
		'excelente',
		'super',
		'vale',
		'si',
		'bueno',
		'venga',
	]);
	const substantiveWords = words.filter(
		w => w.length > 2 && !pureGreetingOrAckWords.has(w),
	);
	if (substantiveWords.length > 0) return 'search_product';

	return 'greeting';
}

export function detectSelectionByName(
	normalizedText: string,
	productList: ProductListEntry[],
): number | null {
	const stopWords = new Set([
		'el',
		'la',
		'los',
		'las',
		'un',
		'una',
		'de',
		'del',
		'al',
		'en',
		'con',
		'por',
		'para',
		'me',
		'que',
		'se',
		'mi',
		'tu',
		'su',
		'ese',
		'esa',
		'eso',
		'esta',
		'este',
		'y',
		'o',
		'a',
	]);

	const msgWords = normalizedText
		.split(/\s+/)
		.filter(w => w.length > 2 && !stopWords.has(w));

	if (msgWords.length === 0) return null;

	let bestIndex: number | null = null;
	let bestScore = 0;
	let bestRatio = 0;

	productList.forEach((product, i) => {
		const productNorm = normalizeText(product.name);
		const variantNorm = product.variants
			.map(v => normalizeText(v.name ?? ''))
			.join(' ');
		const combined = `${productNorm} ${variantNorm}`;
		const productWords = combined
			.split(/\s+/)
			.filter(w => w.length > 2 && !stopWords.has(w));

		const score = msgWords.filter(w => productWords.includes(w)).length;
		// Usar ratio matched/total para preferir el producto más específico cuando hay empate.
		// Ej: "karite" coincide con "KARITE" (1/6=0.167) y con "AVENA & KARITE" (1/7=0.143),
		// ganando el primero por tener menos palabras extra.
		const ratio =
			score > 0 && productWords.length > 0 ? score / productWords.length : 0;
		if (ratio > bestRatio || (ratio === bestRatio && score > bestScore)) {
			bestRatio = ratio;
			bestScore = score;
			bestIndex = i + 1;
		}
	});

	return bestScore >= 1 ? bestIndex : null;
}

export function detectSelection(normalizedText: string): number | null {
	// "2", "el 2", "la 2", "el número 2", "número 2"
	const numMatch = normalizedText.match(
		/^(?:(?:el|la)\s+)?(?:numero\s+)?(\d+)$/,
	);
	if (numMatch) return parseInt(numMatch[1], 10);

	// "me interesa la 2", "quiero el 3", "dame la 2 por favor"
	const contextNumMatch = normalizedText.match(
		/(?:el|la)\s+(?:numero\s+)?(\d+)(?:\s|$)/,
	);
	if (contextNumMatch) return parseInt(contextNumMatch[1], 10);

	// Ordinales en español
	const ordinals: Record<string, number> = {
		primero: 1,
		primera: 1,
		segundo: 2,
		segunda: 2,
		tercero: 3,
		tercera: 3,
		cuarto: 4,
		cuarta: 4,
		quinto: 5,
		quinta: 5,
	};
	const clean = normalizedText.replace(/^(el|la)\s+/, '').trim();
	return ordinals[clean] ?? null;
}
