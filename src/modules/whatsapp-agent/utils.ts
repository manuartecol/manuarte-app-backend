import { toZonedTime } from 'date-fns-tz';

export function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '') // quitar tildes
		.replace(/[^a-z0-9\s]/g, '') // quitar caracteres especiales
		.trim();
}

export function stemTerm(word: string): string {
	// Plurales españoles en -[aeiou]les: esenciales→esencial, naturales→natural
	if (word.length > 5) {
		if (
			word.endsWith('ales') ||
			word.endsWith('eles') ||
			word.endsWith('iles') ||
			word.endsWith('oles') ||
			word.endsWith('ules')
		) {
			return word.slice(0, -2);
		}
	}
	if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
	return word;
}

/**
 * SYNONYM_REPLACEMENTS: términos que el cliente usa pero que NO aparecen en los nombres
 * de productos en BD. El término original se reemplaza por sus valores en la búsqueda.
 * Ejemplo: "esencias" → buscar "fragancia" (no buscar "esencia" en BD).
 */
export const SYNONYM_REPLACEMENTS: Record<string, string[]> = {
	// El cliente dice "esencias"/"perfume"/"aroma" pero en BD el producto es "fragancia"
	esencia: ['fragancia'],
	perfume: ['fragancia'],
	aroma: ['fragancia'],
};

export const SYNONYMS: Record<string, string[]> = {
	// Pabilos / Mechas — bidireccional: cada término expande al otro
	pabilo: ['mecha'],
	mecha: ['pabilo'],
	wick: ['mecha', 'pabilo'],

	btms: ['emulsionante', 'emulsificante', 'cetilico'],

	// Ceras
	soja: ['soya'],
	soya: ['soja'],
	parafina: ['cera'],
	cera: ['parafina', 'soya'],

	// Mantecas
	shea: ['manteca', 'karite'],
	karite: ['manteca'],
	cacao: ['manteca'],

	// Colorantes / Pigmentos / Micas
	colorante: ['pigmento', 'mica', 'tinte'],
	pigmento: ['colorante', 'mica'],
	mica: ['pigmento', 'colorante'],
	tinte: ['colorante', 'pigmento'],

	// Bases / Glicerina / Jabón
	jabon: ['glicerina', 'base'],
	glicerina: ['base'],
	base: ['glicerina'],

	// Envases / Recipientes
	recipiente: ['envase', 'frasco', 'tarro', 'vaso'],
	frasco: ['envase'],
	tarro: ['envase'],
	contenedor: ['envase'],

	// Preservantes / Conservantes
	conservante: ['preservante'],
	preservante: ['conservante'],

	// Tensioactivos / Surfactantes
	surfactante: ['tensioactivo'],
	tensioactivo: ['betaina', 'texapon'],
	betaina: ['tensioactivo'],
	texapon: ['tensioactivo'],

	// Emulsionantes
	emulsificante: ['emulsionante'],
	emulsionante: ['emulsificante', 'cetilico'],

	// Soda Cáustica / NaOH
	sosa: ['soda', 'caustica'],
	naoh: ['soda', 'caustica'],
	hidroxido: ['soda', 'caustica'],
	caustica: ['soda'],

	// Bolsas / Tulas / Empaques
	bolsa: ['tula'],
	tula: ['bolsa'],
	empaque: ['bolsa', 'tula', 'caja'],

	// Spray / Atomizador
	spray: ['atomizador'],
	atomizador: ['spray'],

	// Balanza
	bascula: ['balanza'],

	// Moldes
	silicona: ['molde'],
	forma: ['molde'],
};

/**
 * Normalizaciones de consultas RAG: variantes lexicales que los clientes usan para
 * preguntar sobre temas de FAQ pero que el modelo de embeddings puntúa por debajo del
 * umbral por diferencias lexicales (ej: "métodos de pago" vs "medios de pago").
 * Cada entrada: [patrón regex, término canónico usado en los FAQ de BD].
 */
export const RAG_QUERY_NORMALIZATIONS: [RegExp, string][] = [
	[/m[eé]todos?\s+de\s+pago/gi, 'medios de pago'],
	[/formas?\s+de\s+pago/gi, 'medios de pago'],
	[/m[eé]todos?\s+de\s+env[ií]o/gi, 'opciones de envío'],
	[/formas?\s+de\s+env[ií]o/gi, 'opciones de envío'],
	[/transportadoras?/gi, 'empresa de mensajería'],
	[/courier/gi, 'empresa de mensajería'],
	[/agencias?\s+de\s+transporte/gi, 'empresa de mensajería'],
	[/empresas?\s+de\s+log[ií]stica/gi, 'empresa de mensajería'],
	[/empresa(s)?\s+de\s+env[ií]os?/gi, 'empresa de mensajería'],
	[
		/con\s+qu[eé]\s+empresa(s)?\s+.{0,20}(env[ií]os?|pedidos?|despachos?)/gi,
		'con cuáles empresas de mensajería realizan los despachos',
	],
	[/despachos?/gi, 'envío'],
	[
		/env[ií]o\s+gratis|env[ií]o\s+sin\s+costo|env[ií]o\s+gratuito/gi,
		'costo de envío',
	],
	[/retirar|recoger.*tienda|retiro.*local/gi, 'recogida en tienda'],
	[/domicilio/gi, 'envío a domicilio'],
	[/factura\s+electr[oó]nica|facturaci[oó]n/gi, 'factura electrónica'],
	[/garantia|garant[ií]a/gi, 'garantía de productos'],
	[/devoluci[oó]n|cambio.*producto/gi, 'política de devoluciones'],
];

export function normalizeRagQuery(text: string): string {
	let out = text;
	for (const [re, rep] of RAG_QUERY_NORMALIZATIONS) out = out.replace(re, rep);
	return out;
}

/**
 * Palabras genéricas de categoría de producto (aceite, cera, manteca…) que no son
 * identificadores únicos de un producto específico.
 * Usadas para detectar cambios de producto en la búsqueda RAG.
 */
export const PRODUCT_FAMILY_WORDS = new Set([
	'aceite',
	'vegetal',
	'esencial',
	'mineral',
	'natural',
	'manteca',
	'cera',
	'pigmento',
	'colorante',
	'extracto',
	'fragancia',
	'jabon',
	'crema',
	'gel',
	'base',
	'emulsionante',
	'conservante',
	'polvo',
	'liquido',
]);

export function formatPrice(price: string | null, currency: string): string {
	if (!price) return 'precio no disponible';
	const num = Number(price);
	if (currency === 'COP') {
		return `$${num.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
	}
	return `$${num.toFixed(2)}`;
}

export function isWithinOfficeHours(): boolean {
	const now = toZonedTime(new Date(), 'America/Bogota');
	const day = now.getDay(); // 0=Dom, 1=Lun, ..., 6=Sáb
	const hour = now.getHours();
	const minute = now.getMinutes();
	const timeInMinutes = hour * 60 + minute;

	if (day >= 1 && day <= 5) {
		// Lunes a Viernes: 8:00–18:00
		return timeInMinutes >= 8 * 60 && timeInMinutes < 18 * 60;
	}
	if (day === 6) {
		// Sábado: 8:00–14:00
		return timeInMinutes >= 8 * 60 && timeInMinutes < 14 * 60;
	}
	return false; // Domingo cerrado
}
