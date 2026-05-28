export interface BufferEntry {
	botPhoneNumberId: string;
	texts: string[];
	timer: ReturnType<typeof setTimeout>;
}

export interface ProductListEntry {
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
}

export interface CartItem {
	productId: string;
	productVariantId?: string;
	stockItemId?: string | null;
	productName: string;
	variantName?: string;
	quantity: number;
	unitPrice: string | null;
	currency: string;
}

export interface PendingQuoteFlow {
	step:
		| 'awaiting_cart_confirmation'
		| 'awaiting_customer_data'
		| 'awaiting_address'
		| 'awaiting_city_selection'
		| 'awaiting_confirmation';
	collectedData?: {
		fullName?: string;
		dni?: string;
		phoneNumber?: string;
		location?: string;
		cityId?: number;
		cityName?: string;
		customerId?: string;
		personId?: string;
	};
	cityCandidates?: Array<{ id: number; name: string; regionName: string }>;
	outOfStockItems?: string[];
}

export interface PendingPurchaseFlow {
	step:
		| 'awaiting_out_of_stock_resolution'
		| 'awaiting_quote_confirmation'
		| 'awaiting_customer_data'
		| 'awaiting_address'
		| 'awaiting_city_selection'
		| 'awaiting_confirmation'
		| 'awaiting_payment_confirmation'
		| 'awaiting_receipt';
	/** true solo cuando el usuario confirmó explícitamente proceder desde la cotización */
	purchaseFromQuote?: boolean;
	/** ID de la cotización vinculada (para eliminarla al confirmar pago) */
	quoteId?: string;
	/** Serial de la cotización vinculada (para mostrar referencia) */
	quoteSerial?: string;
	collectedData?: {
		fullName?: string;
		dni?: string;
		phoneNumber?: string;
		location?: string;
		cityId?: number;
		cityName?: string;
		customerId?: string;
		personId?: string;
	};
	cityCandidates?: Array<{ id: number; name: string; regionName: string }>;
	/** Ítems del pedido (del carrito o de la cotización) */
	items?: CartItem[];
	/** Total del pedido en la moneda correspondiente */
	total?: number;
	/** Moneda del pedido */
	currency?: string;
	/** Referencia única de pago (UUID) generada al mostrar el link */
	paymentRef?: string;
	/** Link de pago enviado al cliente */
	paymentLink?: string;
	/** Método de pago utilizado (se guarda al confirmar el pago) */
	paymentMethod?: string;
	/** stockId de la tienda obtenido directamente desde la cotización (para no depender de lastCountryInfo) */
	quoteStockId?: string;
	/** shopId de la tienda obtenido directamente desde la cotización */
	quoteShopId?: string;
	/** Ítems con stock insuficiente pendientes de resolución por el cliente */
	blockedItemsContext?: Array<{
		item: CartItem;
		availableStock: number;
		alternatives: Array<{
			variantId: string;
			name: string;
			stock: number;
			unitPrice: string | null;
		}>;
	}>;
}

/** Campos compartidos entre PendingQuoteFlow y PendingPurchaseFlow usados por handleCommonCollectionSteps */
export interface CollectionFlow {
	step: string;
	collectedData?: {
		fullName?: string;
		dni?: string;
		phoneNumber?: string;
		location?: string;
		cityId?: number;
		cityName?: string;
		customerId?: string;
		personId?: string;
	};
	cityCandidates?: Array<{ id: number; name: string; regionName: string }>;
}

export interface UserSession {
	lastProductList?: ProductListEntry[];
	remainingProductList?: ProductListEntry[];
	awaitingMoreProducts?: boolean;
	lastSearchQuery?: string;
	lastCountryInfo?: {
		currency: string;
		stockIds: string[];
		shopId: string;
		isoCode: string;
	} | null;
	selectedProduct?: string;
	selectedVariantName?: string;
	lastActivityAt?: number;
	lastBotMessage?: string;
	cart?: CartItem[];
	pendingQuoteFlow?: PendingQuoteFlow | null;
	pendingPurchaseFlow?: PendingPurchaseFlow | null;
	/** ID de la última cotización creada para este cliente */
	lastQuoteId?: string;
	/** Serial de la última cotización creada para este cliente */
	lastQuoteSerial?: string;
	/** Cantidad capeada al stock cuando fue insuficiente; el siguiente "Sí" la confirma */
	pendingStockConfirmQty?: number;
	/** true si el número NUNCA ha interactuado con el bot según los logs (se evalúa una vez por sesión) */
	isFirstEverInteraction?: boolean;
	/** Nombre completo del cliente en BD (cacheado en Redis para evitar query repetido) */
	knownCustomerName?: string;
	/** true después de que el bot ya se presentó como Gema y/o saludó por nombre en esta sesión */
	hasIntroducedByName?: boolean;
	/** true después de que el bot ya mencionó al cliente por nombre en el primer show_cart de esta sesión */
	hasShownCartByName?: boolean;
	/** Título base del documento RAG usado en el último turno. Se usa para detectar si el producto ya fue presentado. */
	lastRagDocTitle?: string;
	/** Nombre del producto RAG que no está disponible en stock (pero sí tiene alternativas). Se usa para informar al cliente cuando dice "Sí" en el siguiente turno. */
	outOfStockRagProductName?: string;
}
