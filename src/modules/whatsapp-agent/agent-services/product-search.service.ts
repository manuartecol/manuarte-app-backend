import { Op } from 'sequelize';
import { sequelize } from '../../../config/database';
import { ProductModel } from '../../product/model';
import { ProductVariantModel } from '../../product-variant/model';
import { StockItemModel } from '../../stock-item/model';
import { WhatsAppLogService } from '../logging/log.service';
import {
	formatPrice,
	normalizeText,
	stemTerm,
	SYNONYMS,
	SYNONYM_REPLACEMENTS,
} from '../utils';
import { MAX_PRODUCT_RESULTS } from '../constants';
import { CartItem, ProductListEntry, UserSession } from '../types';
import {
	detectRequestedWeightGrams,
	resolveVariantByWeight,
	resolveVariant,
	allHintWordsMatch,
} from '../helpers/product-helpers';
import { addToCart } from '../helpers/cart-helpers';

// Tokens de peso/medida que describen la PRESENTACIÓN (variante), no el producto.
// Se excluyen de los términos OBLIGATORIOS de la búsqueda por nombre (ver buildProductReply).
const MEASURE_TOKEN =
	/^(kilos?|kgs?|gramos?|grs?|ml|mililitros?|litros?|lts?|cc|onzas?|oz)$/i;

export class ProductSearchService {
	constructor(private logService: WhatsAppLogService) {}

	filterCartItemsByStock = async (
		cartItems: CartItem[],
		stockIds: string[],
	): Promise<{ purchasableItems: CartItem[]; blockedItems: CartItem[] }> => {
		const purchasableItems: CartItem[] = [];
		const blockedItems: CartItem[] = [];

		for (const item of cartItems) {
			if (!item.stockItemId) {
				purchasableItems.push(item);
				continue;
			}
			try {
				const stockItem = await StockItemModel.findOne({
					where: {
						id: item.stockItemId,
						active: true,
						...(stockIds.length > 0 ? { stockId: { [Op.in]: stockIds } } : {}),
					},
					attributes: ['quantity'],
				});
				if (!stockItem || Number(stockItem.get('quantity')) < item.quantity) {
					blockedItems.push(item);
				} else {
					purchasableItems.push(item);
				}
			} catch {
				// En caso de error al consultar stock, incluir el ítem
				purchasableItems.push(item);
			}
		}

		return { purchasableItems, blockedItems };
	};

	/** Devuelve el stock disponible actual de un stockItem (0 si no existe). */
	getAvailableStock = async (
		stockItemId: string,
		stockIds: string[],
	): Promise<number> => {
		try {
			const si = await StockItemModel.findOne({
				where: {
					id: stockItemId,
					active: true,
					...(stockIds.length > 0 ? { stockId: { [Op.in]: stockIds } } : {}),
				},
				attributes: ['quantity'],
			});
			return si ? Number(si.get('quantity')) : 0;
		} catch {
			return 0;
		}
	};

	/**
	 * Resuelve un producto contra la lista activa de la conversación: cuando el
	 * bot acaba de mostrar opciones, "la blanca" se refiere a una de ellas, no a
	 * una búsqueda nueva en BD. Identidad estricta (todas las palabras del hint
	 * deben coincidir) y pool de variantes entre entradas hermanas (las listas de
	 * sugerencias vienen aplanadas: una entrada por variante).
	 * Retorna null si nada coincide → el caller decide (p. ej. búsqueda en BD).
	 */
	resolveFromActiveList = (
		list: ProductListEntry[] | undefined,
		productHint: string,
		variantHint?: string,
	): {
		product: ProductListEntry;
		variant: ProductListEntry['variants'][0];
		units: number;
	} | null => {
		if (!list?.length || !productHint) return null;
		const matched = list.filter(e => allHintWordsMatch(productHint, e.name));
		if (matched.length === 0) return null;

		const pool = matched.flatMap(e =>
			e.variants.map(v => ({ entry: e, variant: v })),
		);
		const inStock = pool.filter(p => p.variant.totalQty > 0);
		const candidates = inStock.length > 0 ? inStock : pool;
		if (candidates.length === 0) return null;

		if (variantHint) {
			// Peso ("2 kilos") → variante cuyo peso calce y unidades necesarias
			const grams = detectRequestedWeightGrams(variantHint);
			if (grams !== null) {
				const byWeight = resolveVariantByWeight(
					candidates.map(c => c.variant),
					grams,
				);
				if (byWeight) {
					const pair = candidates.find(c => c.variant === byWeight.variant);
					if (pair) {
						return {
							product: pair.entry,
							variant: byWeight.variant,
							units: byWeight.units,
						};
					}
				}
			}
			// Presentación como texto ("20 ml")
			const normalizedHint = normalizeText(variantHint);
			const byName = candidates.find(c => {
				const vn = normalizeText(c.variant.name ?? '');
				return (
					vn.length > 0 &&
					(vn.includes(normalizedHint) || normalizedHint.includes(vn))
				);
			});
			if (byName) {
				return { product: byName.entry, variant: byName.variant, units: 1 };
			}
			// La presentación pedida no está entre las opciones mostradas →
			// dejar que la búsqueda en BD resuelva (puede haber otras)
			return null;
		}

		// Sin hint de variante → la opción disponible de menor precio
		const cheapest = [...candidates].sort(
			(a, b) => Number(a.variant.price) - Number(b.variant.price),
		)[0];
		return {
			product: cheapest.entry,
			variant: cheapest.variant,
			units: 1,
		};
	};

	/**
	 * Procesa una lista de productos y los agrega al carrito de la sesión.
	 * Usado en request_quote y en los handlers de awaiting_confirmation.
	 * Cada ítem se resuelve primero contra la lista activa de la conversación y,
	 * si no está ahí, con búsqueda en BD.
	 * @returns objecto con número de productos agregados, lista de productos sin stock
	 *          y detalles de sin-stock con alternativas disponibles
	 */
	processProductListItems = async (
		items: Array<{
			productHint: string;
			quantity: number;
			variantHint?: string;
		}>,
		session: UserSession,
		currency: string,
		countryInfo: {
			currency: string;
			stockIds: string[];
			shopId: string;
			isoCode: string;
		} | null,
		mode: 'quote' | 'purchase' = 'purchase',
	): Promise<{
		added: number;
		outOfStock: string[];
		outOfStockDetails: Array<{
			name: string;
			currentStock: number;
			alternatives: Array<{ name: string; stock: number }>;
		}>;
	}> => {
		let added = 0;
		const outOfStock: string[] = [];
		const outOfStockDetails: Array<{
			name: string;
			currentStock: number;
			alternatives: Array<{ name: string; stock: number }>;
		}> = [];

		const pushOutOfStock = (
			hint: string,
			allVariants: Array<{ variantId: string; name: string; totalQty: number }>,
			chosenVariantId?: string,
			chosenStock = 0,
		) => {
			outOfStock.push(hint);
			const alternatives = allVariants
				.filter(v => v.variantId !== chosenVariantId && v.totalQty > 0)
				.map(v => ({ name: v.name, stock: v.totalQty }));
			outOfStockDetails.push({
				name: hint,
				currentStock: chosenStock,
				alternatives,
			});
		};

		// Agrega una variante resuelta al carrito, gestionando stock y avisos de sin-stock.
		const addResolved = (
			product: ProductListEntry,
			variant: ProductListEntry['variants'][0],
			unitsRequested: number,
		) => {
			const stock = variant.totalQty;
			const realName = [product.name, variant.name]
				.filter(Boolean)
				.join(' ')
				.trim();
			if (mode === 'purchase' && stock === 0) {
				pushOutOfStock(realName, product.variants, variant.variantId, stock);
				return;
			}
			const cartQty =
				mode === 'quote' ? unitsRequested : Math.min(unitsRequested, stock);
			addToCart(session, product, cartQty, currency, variant);
			added++;
			if (stock < unitsRequested) {
				pushOutOfStock(realName, product.variants, variant.variantId, stock);
			}
		};

		for (const item of items) {
			try {
				const qtyRequested = Math.max(1, item.quantity || 1);

				// 1) Resolver contra la lista activa de la conversación: si el bot
				//    acaba de mostrar opciones, el hint se refiere a una de ellas.
				const fromList = this.resolveFromActiveList(
					session.lastProductList,
					item.productHint,
					item.variantHint,
				);
				if (fromList) {
					console.log(
						`[WhatsApp Agent] Product list item "${item.productHint}" resolved from active list: ${fromList.product.name} – ${fromList.variant.name}`,
					);
					addResolved(
						fromList.product,
						fromList.variant,
						fromList.units * qtyRequested,
					);
					continue;
				}

				// 2) Búsqueda en BD
				const result = await this.buildProductReply(
					normalizeText(item.productHint),
					countryInfo ?? session.lastCountryInfo ?? null,
					item.productHint,
				);
				if (!result.productFound || result.products.length === 0) {
					console.log(
						`[WhatsApp Agent] Product list item not found: "${item.productHint}"`,
					);
					if (result.outOfStockProductName) {
						outOfStock.push(result.outOfStockProductName);
						outOfStockDetails.push({
							name: result.outOfStockProductName,
							currentStock: 0,
							alternatives: [],
						});
					}
					continue;
				}
				const product = result.products[0];
				const qty = qtyRequested;

				if (item.variantHint) {
					// El tamaño/presentación/peso viene como texto libre en variantHint
					// (ej: "5 kilos", "20 ml").
					// 1) Si el hint expresa un PESO (ej: "4 kilos"), resolver por peso PRIMERO.
					//    Esto cubre el caso en que el producto se vende por kilo (variante "KILO")
					//    y el cliente pide "4 kilos": son 4 unidades, no 1. resolveVariant no
					//    puede inferir el multiplicador (devuelve la variante única tal cual).
					const requestedGrams = detectRequestedWeightGrams(item.variantHint);
					const byWeight =
						requestedGrams !== null
							? resolveVariantByWeight(product.variants, requestedGrams)
							: null;
					if (byWeight) {
						// El peso YA expresa la cantidad total ("4 kilos" → 4 unidades de KILO).
						// NO multiplicar por qty: el NLU suele repetir el mismo número en
						// quantity y en el peso ("4 kilos" → quantity:4 + variantHint:"4 kilos"),
						// lo que daría 16 (4×4). Mismo criterio que la búsqueda directa.
						addResolved(product, byWeight.variant, byWeight.units);
					} else {
						// 2) Sin peso (ej: "20 ml"): match directo de la presentación contra
						//    el texto libre de las variantes en BD.
						const resolved = resolveVariant(
							product,
							item.variantHint,
							normalizeText(item.productHint),
						);
						if (resolved) {
							addResolved(product, resolved, qty);
						} else if (product.variants.length === 1) {
							addResolved(product, product.variants[0], qty);
						}
					}
				} else if (product.variants.length === 1) {
					addResolved(product, product.variants[0], qty);
				} else {
					// Múltiples variantes sin hint → usar la disponible de menor precio.
					// El cliente pidió cantidad sin especificar presentación.
					const sortedByPrice = [...product.variants]
						.filter(v => v.totalQty > 0)
						.sort((a, b) => Number(a.price) - Number(b.price));
					const defaultVariant = sortedByPrice[0] ?? product.variants[0];
					if (defaultVariant) {
						addResolved(product, defaultVariant, qty);
					}
				}
			} catch (err) {
				console.error(
					`[WhatsApp Agent] Error processing product list item: "${item.productHint}"`,
					err,
				);
			}
		}
		return { added, outOfStock, outOfStockDetails };
	};

	buildProductReply = async (
		normalizedText: string,
		countryInfo: { currency: string; stockIds: string[] } | null,
		aiSearchQuery?: string,
		// Contexto del cliente (jabón/vela): cuando una categoría tiene productos "para
		// jabon" y "para velas" (ej. colorantes), prioriza los que calzan con lo que el
		// cliente está haciendo. Solo reordena (los demás quedan en remainingProducts).
		craftContext?: 'jabon' | 'vela',
	): Promise<{
		replyText: string;
		searchTerms: string[];
		productFound: boolean;
		suggestionsShown: boolean;
		products: ProductListEntry[];
		remainingProducts: ProductListEntry[];
		outOfStockProductName?: string;
	}> => {
		const stopWords = [
			// intención
			'producto',
			'productos',
			'articulo',
			'articulos',
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
			// verbos comunes
			'estoy',
			'estas',
			'tiene',
			'tengo',
			// artículos y preposiciones
			'el',
			'la',
			'los',
			'las',
			'un',
			'una',
			'unos',
			'unas',
			'de',
			'del',
			'al',
			'por',
			'para',
			'con',
			'sin',
			'en',
			'que',
			// conectores y filler words
			'favor',
			'tambien',
			'mas',
			'si',
			'no',
			'me',
			'puedo',
			'porfavor',
			'gracias',
			'hola',
			'buen',
			'buenos',
			'buenas',
			'dias',
			'tardes',
			'noches',
			'como',
			'esta',
			'ese',
			'esa',
			'este',
			'esto',
			'eso',
			'sus',
			'les',
			'nos',
		];

		// If AI provided a clean search query, use it directly (skip stopword filtering)
		const baseText = aiSearchQuery
			? normalizeText(aiSearchQuery)
			: normalizedText;

		const searchTerms = aiSearchQuery
			? baseText
					.split(' ')
					.filter(
						w => w.length > 1 && !stopWords.includes(w) && !/^\d+$/.test(w),
					)
			: normalizedText
					.split(' ')
					.filter(
						w => w.length > 2 && !stopWords.includes(w) && !/^\d+$/.test(w),
					);

		const expandedTerms = [
			...new Set(
				searchTerms.flatMap(t => [t, ...(SYNONYMS[stemTerm(t)] ?? [])]),
			),
		];

		if (searchTerms.length === 0) {
			return {
				replyText: '¿Qué producto busca? Dígame el nombre y le ayudo. 😊',
				searchTerms: [],
				productFound: false,
				suggestionsShown: false,
				products: [],
				remainingProducts: [],
			};
		}

		try {
			const stockItemWhere =
				countryInfo && countryInfo.stockIds.length > 0
					? { stockId: { [Op.in]: countryInfo.stockIds }, active: true }
					: { active: true };

			const variantInclude = {
				model: ProductVariantModel,
				as: 'productVariants',
				attributes: ['name', 'id'],
				include: [
					{
						model: StockItemModel,
						as: 'stockItems',
						attributes: ['id', 'quantity', 'price'],
						where: stockItemWhere,
						required: false,
					},
				],
			};

			// Búsqueda AND: todos los términos deben aparecer en el nombre.
			// EXCEPCIÓN: los tokens de peso/medida (kilo, gramos, ml, etc.) describen la
			// PRESENTACIÓN/variante, no el producto, y el peso se resuelve aparte por variante.
			// Si se exigieran en el nombre, una frase como "cera de palma kilo" desviaría la
			// búsqueda a un producto cuyo NOMBRE contenga "kilo" (ej: "Cera de palma - Caja x
			// 15 kilos", sin stock) en vez del producto real "Cera de Palma / de Vaso". Por eso
			// se excluyen del AND, pero se conservan en searchTerms para el scoring de relevancia.
			const coreSearchTerms = searchTerms.filter(t => !MEASURE_TOKEN.test(t));
			const andSearchTerms =
				coreSearchTerms.length > 0 ? coreSearchTerms : searchTerms;

			// Los términos en SYNONYM_REPLACEMENTS se reemplazan por su equivalente en BD
			// (ej: "esencia" → "fragancia") para evitar falsos positivos por substring.
			const effectiveTermsPerSearch = andSearchTerms.map(t => {
				const stem = stemTerm(t);
				return SYNONYM_REPLACEMENTS[stem] ?? [t];
			});

			let products = await ProductModel.findAll({
				attributes: ['id', 'name', 'description'],
				where: {
					name: { [Op.notILike]: 'flete' },
					[Op.and]: effectiveTermsPerSearch.map(terms => ({
						[Op.or]: terms.map(term =>
							sequelize.where(
								sequelize.fn('unaccent', sequelize.col('ProductModel.name')),
								{ [Op.iLike]: `%${stemTerm(term)}%` },
							),
						),
					})),
				},
				include: [variantInclude],
				limit: 20,
			});

			// Términos de sinónimos puros (no originales)
			const synonymOnlyTerms = expandedTerms.filter(
				t => !searchTerms.includes(t),
			);

			// Expandir sinónimos como OR alternativo SOLO cuando la búsqueda AND no encontró nada.
			// Si el AND ya encontró el producto específico (ej: "cera de palma" → "Cera de Palma / de Vaso"),
			// no agregar sinónimos genéricos (ej: "soya", "parafina") que contaminarían los resultados.
			if (synonymOnlyTerms.length > 0 && products.length === 0) {
				const synonymProducts = await ProductModel.findAll({
					attributes: ['id', 'name', 'description'],
					where: {
						name: { [Op.notILike]: 'flete' },
						[Op.or]: synonymOnlyTerms.map(term =>
							sequelize.where(
								sequelize.fn('unaccent', sequelize.col('ProductModel.name')),
								{ [Op.iLike]: `%${stemTerm(term)}%` },
							),
						),
					},
					include: [variantInclude],
					limit: 20,
				});
				// Fusionar deduplicando por id
				const existingIds = new Set(products.map(p => p.id));
				for (const p of synonymProducts) {
					if (!existingIds.has(p.id)) products.push(p);
				}
			}

			// Fallback OR: si no encontró nada con AND ni con sinónimos, buscar con cualquier término original
			if (products.length === 0 && searchTerms.length > 1) {
				console.log(
					'[WhatsApp Agent] AND search returned 0 results, trying OR fallback.',
				);
				products = await ProductModel.findAll({
					attributes: ['id', 'name', 'description'],
					where: {
						name: { [Op.notILike]: 'flete' },
						[Op.or]: expandedTerms.map(term =>
							sequelize.where(
								sequelize.fn('unaccent', sequelize.col('ProductModel.name')),
								{ [Op.iLike]: `%${stemTerm(term)}%` },
							),
						),
					},
					include: [variantInclude],
					limit: 20,
				});
			}

			type StockItem = { id: string; quantity: number; price: string };
			type Variant = { id: string; name: string; stockItems: StockItem[] };

			const currency = countryInfo?.currency ?? 'USD';

			// Scoring: relevancia textual + disponibilidad
			type ScoredProduct = {
				score: number;
				relevanceScore: number;
				productId: string;
				name: string;
				description?: string;
				variants: Array<{
					variantId: string;
					stockItemId: string | null;
					name: string;
					totalQty: number;
					price: string | null;
				}>;
			};
			const scored: ScoredProduct[] = [];
			const outOfStockNames: string[] = [];
			const outOfStockIds: string[] = [];

			for (const p of products) {
				const variants = p.get('productVariants') as Variant[] | undefined;
				const nameLower = normalizeText(p.name);
				const description = (p.get('description') as string | undefined) ?? '';

				const availableVariants = (variants ?? [])
					.map(v => {
						const totalQty = v.stockItems.reduce(
							(sum, si) => sum + Number(si.quantity),
							0,
						);
						const price = v.stockItems[0]?.price ?? null;
						const stockItemId = v.stockItems[0]?.id ?? null;
						return {
							variantId: v.id,
							stockItemId,
							name: v.name,
							totalQty,
							price,
						};
					})
					.filter(v => v.totalQty > 0);

				if (availableVariants.length === 0) {
					outOfStockNames.push(p.name);
					outOfStockIds.push(String(p.id));
					continue;
				}

				// Relevancia textual: cuántos términos coinciden y con qué precisión
				const nameWords = nameLower.split(/\s+/);

				// Word-boundary match: term matches a complete word in the name
				const wordMatchCount = searchTerms.filter(t => {
					const stem = stemTerm(t);
					return nameWords.some(w => w === stem || w.startsWith(stem));
				}).length;

				// Substring-only match: appears in name but NOT as a whole word
				// (e.g. "cera" inside "encerada")
				const substringMatchCount = searchTerms.filter(t => {
					const stem = stemTerm(t);
					const inName = nameLower.includes(stem);
					const isWord = nameWords.some(w => w === stem || w.startsWith(stem));
					return inName && !isWord;
				}).length;

				const descMatchCount = searchTerms.filter(t =>
					normalizeText(description).includes(stemTerm(t)),
				).length;
				const exactMatch = nameLower === searchTerms.join(' ') ? 1000 : 0;

				// Product-type bonus: search term is the first word of the product name
				const productTypeBonus = searchTerms.some(t => {
					const stem = stemTerm(t);
					return nameWords[0] === stem || nameWords[0]?.startsWith(stem);
				})
					? 50
					: 0;

				const startsWithMatch = searchTerms.some(t =>
					nameLower.startsWith(stemTerm(t)),
				)
					? 10
					: 0;
				const totalStock = availableVariants.reduce(
					(sum, v) => sum + v.totalQty,
					0,
				);

				// Bonus de contexto: si la categoría trae productos "para jabon" y "para
				// velas", el que calza con lo que el cliente está haciendo sube de tier
				// (los del otro uso bajan y quedan en "remaining" → "tienes más?").
				let craftBonus = 0;
				if (craftContext) {
					const other = craftContext === 'jabon' ? 'vela' : 'jabon';
					if (nameLower.includes(craftContext)) craftBonus = 60;
					else if (nameLower.includes(other)) craftBonus = -60;
				}

				// Relevance score (primary): determines product ordering tier
				const relevanceScore =
					exactMatch +
					productTypeBonus +
					wordMatchCount * 30 +
					substringMatchCount * 3 +
					descMatchCount * 3 +
					startsWithMatch +
					craftBonus +
					availableVariants.length;

				// Final score: relevance dominates, stock breaks ties within same tier
				const score = relevanceScore * 1000 + totalStock;

				scored.push({
					score,
					relevanceScore,
					productId: String(p.id),
					name: p.name,
					description: description || undefined,
					variants: availableVariants,
				});
			}

			scored.sort((a, b) => b.score - a.score);

			if (scored.length === 0) {
				const outOfStockProductName =
					outOfStockNames.length > 0 ? outOfStockNames[0] : undefined;
				const suggestions = await this.buildSuggestions(
					searchTerms,
					stockItemWhere,
					outOfStockIds.length > 0 ? outOfStockIds : undefined,
				);
				return {
					replyText: suggestions.replyText,
					searchTerms,
					productFound: false,
					suggestionsShown: suggestions.products.length > 0,
					products: suggestions.products,
					remainingProducts: suggestions.remainingProducts,
					outOfStockProductName,
				};
			}

			// Group products with same base name that differ only by color suffix.
			// e.g. "Pigmento para cera arena MORADO", "...AMARILLO" → one grouped entry.
			const KNOWN_COLORS = new Set([
				'morado',
				'amarillo',
				'rosado',
				'naranja',
				'verde',
				'magenta',
				'rojo',
				'azul',
				'negro',
				'blanco',
				'violeta',
				'lila',
				'turquesa',
				'dorado',
				'plateado',
				'celeste',
				'beige',
				'coral',
				'marfil',
				'chocolate',
				'cafe',
				'fucsia',
				'gris',
				'rosa',
				'aguamarina',
			]);
			const getBaseName = (name: string): string | null => {
				const words = normalizeText(name).split(/\s+/);
				if (words.length < 2) return null;
				const lastWord = words[words.length - 1];
				if (KNOWN_COLORS.has(lastWord)) return words.slice(0, -1).join(' ');
				return null;
			};

			// Build groups by base name
			const groupMap = new Map<string, ScoredProduct[]>();
			const ungrouped: ScoredProduct[] = [];
			for (const s of scored) {
				const baseName = getBaseName(s.name);
				if (baseName) {
					const group = groupMap.get(baseName) ?? [];
					group.push(s);
					groupMap.set(baseName, group);
				} else {
					ungrouped.push(s);
				}
			}

			// Collapse groups of 3+ into a single representative entry
			const collapsed: ScoredProduct[] = [...ungrouped];
			const groupedRemaining: ScoredProduct[] = [];
			for (const [, group] of groupMap.entries()) {
				if (group.length >= 3) {
					// Take highest scored as representative
					const [representative, ...rest] = group;
					const colorNames = group.map(g => {
						const words = g.name.split(/\s+/);
						return words[words.length - 1];
					});
					const totalGroupStock = group.reduce(
						(sum, g) => sum + g.variants.reduce((s, v) => s + v.totalQty, 0),
						0,
					);
					collapsed.push({
						...representative,
						name: representative.name.split(/\s+/).slice(0, -1).join(' '),
						description: `Disponible en ${group.length} colores: ${colorNames.join(', ')} (${totalGroupStock} unidades en total)`,
						// Keep representative's variants for price reference
					});
					groupedRemaining.push(...rest);
				} else {
					collapsed.push(...group);
				}
			}

			// Re-sort collapsed list by score
			collapsed.sort((a, b) => b.score - a.score);

			// Dominance filter: when the top result's relevance score is ≥ 2× the next,
			// the top result is the clear match and the rest are spurious (e.g. searching
			// "cera de arena" matching "Pigmento para cera arena"). Keep only the top.
			if (
				collapsed.length >= 2 &&
				collapsed[0].relevanceScore >= 2 * collapsed[1].relevanceScore
			) {
				collapsed.splice(1);
			}

			const displayedScored = collapsed.slice(0, MAX_PRODUCT_RESULTS);
			const remainingScored = [
				...collapsed.slice(MAX_PRODUCT_RESULTS),
				...groupedRemaining,
			];
			const lines = displayedScored.map((s, i) => {
				if (s.variants.length === 1) {
					const v = s.variants[0];
					const priceText = formatPrice(v.price, currency);
					const label = v.name ? `${s.name} ${v.name}` : s.name;
					return `${i + 1}. ${label} – ${priceText}`;
				}
				// Multi-variant: show product name with variant sub-list
				const variantLines = s.variants
					.map(
						v =>
							`   - ${v.name}: ${formatPrice(v.price, currency)} (${v.totalQty} disponibles)`,
					)
					.join('\n');
				return `${i + 1}. ${s.name}\n${variantLines}`;
			});
			const productList: ProductListEntry[] = displayedScored.map(s => ({
				productId: s.productId,
				name: s.name,
				description: s.description,
				variants: s.variants,
			}));
			const remainingProducts: ProductListEntry[] = remainingScored.map(s => ({
				productId: s.productId,
				name: s.name,
				description: s.description,
				variants: s.variants,
			}));

			const replyText = `Claro 😊 le muestro lo que tenemos:\n\n${lines.join('\n\n')}`;
			return {
				replyText,
				searchTerms,
				productFound: true,
				suggestionsShown: false,
				products: productList,
				remainingProducts,
			};
		} catch (error) {
			console.error('[WhatsApp Agent] Error searching products:', error);
			this.logService
				.logError({
					context: 'buildProductReply',
					error,
					rawText: normalizedText,
				})
				.catch(e =>
					console.error('[WhatsApp Agent] Failed to save error log:', e),
				);
			return {
				replyText:
					'Algo salió mal de mi lado 😕 ¿Puede repetirme qué está buscando?',
				searchTerms: [],
				productFound: false,
				suggestionsShown: false,
				products: [],
				remainingProducts: [],
			};
		}
	};

	buildSuggestions = async (
		searchTerms: string[],
		stockItemWhere: object,
		outOfStockProductIds?: string[],
	): Promise<{
		replyText: string;
		products: ProductListEntry[];
		remainingProducts: ProductListEntry[];
	}> => {
		try {
			// Buscar productos que coincidan con los términos (sin filtro de stock)
			// para obtener sus categorías.
			// Si tenemos IDs directos de productos sin stock, los usamos para lookup preciso.
			const matchingProducts =
				outOfStockProductIds && outOfStockProductIds.length > 0
					? await ProductModel.findAll({
							attributes: ['id', 'productCategoryId'],
							where: { id: { [Op.in]: outOfStockProductIds } },
						})
					: await ProductModel.findAll({
							attributes: ['id', 'productCategoryId'],
							where: {
								name: { [Op.notILike]: 'flete' },
								[Op.or]: searchTerms.map(term =>
									sequelize.where(
										sequelize.fn(
											'unaccent',
											sequelize.col('ProductModel.name'),
										),
										{ [Op.iLike]: `%${stemTerm(term)}%` },
									),
								),
							},
							limit: 10,
						});

			if (matchingProducts.length === 0) {
				return {
					replyText:
						'Mmm 🤔 no lo encontré con ese nombre. ¿Puede contarme un poco más o qué tipo de insumo busca?',
					products: [],
					remainingProducts: [],
				};
			}

			const categoryIds = [
				...new Set(
					matchingProducts
						.map(p => p.get('productCategoryId') as string)
						.filter(Boolean),
				),
			];

			type SuggestionVariant = {
				id: string;
				name: string;
				stockItems: { id: string; quantity: number; price: string }[];
			};

			// Buscar todos los productos en esas categorías con stock disponible (sin límite)
			const suggestions = await ProductModel.findAll({
				attributes: ['id', 'name', 'description'],
				where: {
					productCategoryId: { [Op.in]: categoryIds },
					name: { [Op.notILike]: 'flete' },
				},
				include: [
					{
						model: ProductVariantModel,
						as: 'productVariants',
						attributes: ['id', 'name'],
						include: [
							{
								model: StockItemModel,
								as: 'stockItems',
								attributes: ['id', 'quantity', 'price'],
								where: { ...stockItemWhere, quantity: { [Op.gt]: 0 } },
								required: true,
							},
						],
						required: true,
					},
				],
			});

			if (suggestions.length === 0) {
				// Fallback: buscar con el primer término significativo para mostrar
				// productos relacionados del mismo tipo (ej: "cera de arena" sin stock
				// → mostrar otras ceras disponibles).
				const primaryTerm = searchTerms.find(t => t.length > 3);
				if (primaryTerm) {
					const fallbackResults = await ProductModel.findAll({
						attributes: ['id', 'name', 'description'],
						where: {
							name: { [Op.notILike]: 'flete' },
							[Op.or]: [
								sequelize.where(
									sequelize.fn(
										'unaccent',
										sequelize.col('ProductModel.name'),
									),
									{ [Op.iLike]: `%${stemTerm(primaryTerm)}%` },
								),
							],
						},
						include: [
							{
								model: ProductVariantModel,
								as: 'productVariants',
								attributes: ['id', 'name'],
								include: [
									{
										model: StockItemModel,
										as: 'stockItems',
										attributes: ['id', 'quantity', 'price'],
										where: { ...stockItemWhere, quantity: { [Op.gt]: 0 } },
										required: true,
									},
								],
								required: true,
							},
						],
						limit: 20,
					});

					if (fallbackResults.length > 0) {
						type FallbackVariant = {
							id: string;
							name: string;
							stockItems: { id: string; quantity: number; price: string }[];
						};
						const fallbackList: (ProductListEntry & { totalQty: number })[] =
							fallbackResults
								.map(p => {
									const variants = p.get('productVariants') as
										| FallbackVariant[]
										| undefined;
									const availableVariants = (variants ?? []).map(v => ({
										variantId: v.id,
										stockItemId: v.stockItems[0]?.id ?? null,
										name: v.name,
										totalQty: v.stockItems.reduce(
											(sum, si) => sum + Number(si.quantity),
											0,
										),
										price: v.stockItems[0]?.price ?? null,
									}));
									return {
										productId: String(p.id),
										name: p.name,
										description:
											(p.get('description') as string | undefined) ||
											undefined,
										variants: availableVariants,
										totalQty: availableVariants.reduce(
											(s, v) => s + v.totalQty,
											0,
										),
									};
								})
								.sort((a, b) => b.totalQty - a.totalQty);
						return {
							replyText: '',
							products: fallbackList
								.slice(0, MAX_PRODUCT_RESULTS)
								// eslint-disable-next-line @typescript-eslint/no-unused-vars
								.map(({ totalQty: _, ...p }) => p),
							remainingProducts: fallbackList
								.slice(MAX_PRODUCT_RESULTS)
								// eslint-disable-next-line @typescript-eslint/no-unused-vars
								.map(({ totalQty: _, ...p }) => p),
						};
					}
				}

				return {
					replyText:
						'Ese producto no lo tenemos disponible ahora. ¿Puede contarme más sobre lo que necesita? 😊',
					products: [],
					remainingProducts: [],
				};
			}

			// Mapear a ProductListEntry y ordenar por mayor disponibilidad
			const allProducts: (ProductListEntry & { totalQty: number })[] =
				suggestions
					.map(p => {
						const variants = p.get('productVariants') as
							| SuggestionVariant[]
							| undefined;
						const availableVariants = (variants ?? []).map(v => ({
							variantId: v.id,
							stockItemId: v.stockItems[0]?.id ?? null,
							name: v.name,
							totalQty: v.stockItems.reduce(
								(sum, si) => sum + Number(si.quantity),
								0,
							),
							price: v.stockItems[0]?.price ?? null,
						}));
						const totalQty = availableVariants.reduce(
							(sum, v) => sum + v.totalQty,
							0,
						);
						return {
							productId: String(p.id),
							name: p.name,
							description:
								(p.get('description') as string | undefined) || undefined,
							variants: availableVariants,
							totalQty,
						};
					})
					.sort((a, b) => b.totalQty - a.totalQty);

			// Flatten multi-variant products: each variant becomes its own entry
			type FlatSuggestion = ProductListEntry & { totalQty: number };
			const flatProducts: FlatSuggestion[] = [];
			for (const p of allProducts) {
				if (p.variants.length === 1) {
					flatProducts.push(p);
				} else {
					for (const v of p.variants) {
						flatProducts.push({ ...p, variants: [v], totalQty: v.totalQty });
					}
				}
			}

			const productList: ProductListEntry[] = flatProducts
				.slice(0, MAX_PRODUCT_RESULTS)
				.map(
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					({ totalQty: _, ...p }) => p,
				);
			const remainingProducts: ProductListEntry[] = flatProducts
				.slice(MAX_PRODUCT_RESULTS)
				.map(
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					({ totalQty: _, ...p }) => p,
				);

			return { replyText: '', products: productList, remainingProducts };
		} catch (error) {
			console.error('[WhatsApp Agent] Error building suggestions:', error);
			this.logService
				.logError({ context: 'buildSuggestions', error })
				.catch(e =>
					console.error('[WhatsApp Agent] Failed to save error log:', e),
				);
			return {
				replyText:
					'No lo tenemos disponible en este momento. ¿Puedo ayudarte con otro insumo? 😊',
				products: [],
				remainingProducts: [],
			};
		}
	};
}
