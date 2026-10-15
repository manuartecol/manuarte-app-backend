export function stripCallingCode(phoneNumber: string): string {
	const prefixes = ['593', '57']; // longest first
	const matched = prefixes.find(p => phoneNumber.startsWith(p));
	return matched ? phoneNumber.slice(matched.length) : phoneNumber;
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

/**
 * Petición explícita de hablar con una persona. Se usa SOLO para dejar salir al
 * cliente de un flujo en curso (compra o cotización): ahí los interceptores
 * responden antes de que el NLU llegue a clasificar, así que sin esto un
 * cliente atascado en el formulario pediría ayuda y el bot le seguiría pidiendo
 * la cédula. Fuera de los flujos, la intención la sigue decidiendo el LLM.
 *
 * El patrón es deliberadamente estrecho —verbo + "persona/humano/asesor"— para
 * no confundirlo con una respuesta legítima del formulario. Convive con las
 * expresiones de cancelación que los propios flujos ya usan.
 */
export function isExplicitHumanRequest(normalizedText: string): boolean {
	// "hablar con una persona", "pasame con un asesor", "comunicar con alguien".
	// Entre el verbo y el sustantivo solo se admiten conectores: así "quiero la
	// vela de persona grande" no se confunde con una petición de traspaso.
	const contactarConPersona =
		/\b(hablar|conversar|comunicar|comunicarme|contactar|contactarme|pasar|pasame|pasenme|transferir|atienda|atiendan)\s+(con\s+)?(un|una|algun|alguna)?\s*(persona|humano|humana|asesor|asesora|agente|vendedor|vendedora|operador|operadora|alguien)\b/i;

	// "quiero hablar", "necesito comunicarme" a secas. El lookahead descarta
	// hablar *de* algo ("quiero hablar de la cotización"), que es conversación
	// normal y no una petición de traspaso.
	const quererHablar =
		/\b(quiero|necesito|deseo|puedo|podria|quisiera)\s+(hablar|conversar|comunicarme|contactarme)\b(?!\s+(de|del|sobre|acerca)\b)/i;

	// "quiero un asesor", "necesito una persona".
	const quererPersona =
		/\b(quiero|necesito|deseo|quisiera)\s+(un|una)\s+(persona|humano|humana|asesor|asesora|agente|vendedor|vendedora|operador|operadora)\b/i;

	return (
		contactarConPersona.test(normalizedText) ||
		quererHablar.test(normalizedText) ||
		quererPersona.test(normalizedText)
	);
}
