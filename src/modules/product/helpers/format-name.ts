/**
 * Formato único de los nombres de producto: inicial mayúscula por palabra, salvo
 * los conectores y las siglas. Lo que lleva dígitos no se toca.
 *
 * Lo usan el modelo, al crear o renombrar, y el backfill del catálogo: con una
 * sola función el catálogo no vuelve a desordenarse después de normalizarlo
 */
const LOWERCASE_WORDS = new Set([
	'a',
	'al',
	'c',
	'cav',
	'cc',
	'con',
	'de',
	'del',
	'el',
	'en',
	'g',
	'grs',
	'kg',
	'la',
	'las',
	'los',
	'ml',
	'mm',
	'o',
	'para',
	'por',
	'sin',
	'x',
	'y',
]);

const ACRONYMS = new Set([
	'AAA',
	'AC',
	'APF',
	'BPF',
	'CCA',
	'CMC',
	'DSDA',
	'FUBF',
	'HD',
	'KD',
	'PH',
	'PVC',
	'TR',
	'USP',
]);

export const formatProductName = (name: string): string => {
	const clean = name
		.trim()
		.replace(/\s+/g, ' ')
		// Basura de captura: "Jarra Acrilica con pico - "
		.replace(/[\s-]+$/, '');
	let isFirst = true;

	const formatted = clean.replace(/[\p{L}\p{N}]+/gu, word => {
		const first = isFirst;
		isFirst = false;

		if (/\d/.test(word) || ACRONYMS.has(word.toUpperCase())) {
			return /\d/.test(word) ? word : word.toUpperCase();
		}

		// Mezcla interna de mayúsculas a propósito, como "GlydantPlus"
		if (/\p{Ll}\p{Lu}/u.test(word)) return word;

		const lower = word.toLowerCase();
		if (!first && LOWERCASE_WORDS.has(lower)) return lower;

		return lower.charAt(0).toUpperCase() + lower.slice(1);
	});

	// Aquí son letras, no conectores
	return formatted
		.replace('Triple a', 'Triple A')
		.replace(
			/Vitamina ([ac])\b/,
			(_, letter) => `Vitamina ${letter.toUpperCase()}`,
		);
};

// Las categorías, con la barra siempre entre espacios: "MECHAS/PABILOS" queda
// "Mechas / Pabilos"
export const formatCategoryName = (name: string): string =>
	formatProductName(name.replace(/\s*\/\s*/g, ' / '));
