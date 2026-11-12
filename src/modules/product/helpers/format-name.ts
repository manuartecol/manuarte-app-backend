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

/**
 * `keepUppercase`: además de la lista, respeta como sigla cualquier palabra de
 * dos o más letras escrita toda en mayúsculas. Solo tiene sentido cuando el
 * nombre no viene entero en mayúsculas
 */
export const formatProductName = (
	name: string,
	keepUppercase = false,
): string => {
	const clean = name
		.trim()
		.replace(/\s+/g, ' ')
		// Basura de captura: "Jarra Acrilica con pico - "
		.replace(/[\s-]+$/, '');
	let isFirst = true;

	const formatted = clean.replace(/[\p{L}\p{N}]+/gu, word => {
		const first = isFirst;
		isFirst = false;

		if (/\d/.test(word)) return word;
		if (ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
		// Conectores y unidades nunca son siglas: "x 1 KG" queda "x 1 kg"
		if (!first && LOWERCASE_WORDS.has(word.toLowerCase())) {
			return word.toLowerCase();
		}
		if (keepUppercase && word.length > 1 && !/\p{Ll}/u.test(word)) {
			return word;
		}

		// Mezcla interna de mayúsculas a propósito, como "GlydantPlus"
		if (/\p{Ll}\p{Lu}/u.test(word)) return word;

		const lower = word.toLowerCase();
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
export const formatCategoryName = (
	name: string,
	keepUppercase = false,
): string =>
	formatProductName(name.replace(/\s*\/\s*/g, ' / '), keepUppercase);

/**
 * Para lo que se escribe en el panel. Siempre formatea (inicial mayúscula,
 * conectores en minúscula), pero si el nombre mezcla mayúsculas y minúsculas,
 * las palabras escritas enteras en mayúsculas se respetan como siglas aunque la
 * lista no las conozca: "Base easy soap XYZ con miel" queda
 * "Base Easy Soap XYZ con Miel". Un nombre todo en mayúsculas no permite
 * distinguirlas y solo protege las de la lista
 */
export const formatTypedName = (
	name: string,
	format: (name: string, keepUppercase?: boolean) => string = formatProductName,
): string => format(name, /\p{Ll}/u.test(name) && /\p{Lu}/u.test(name));
