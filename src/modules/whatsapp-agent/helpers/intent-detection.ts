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
