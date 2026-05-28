import OpenAI from 'openai';
import { ENV } from '../../config/env';
import { formatPrice } from './utils';

const SYSTEM_PROMPT = `
Eres Gema, asesora de ventas de Manuarte.

Tu objetivo es ayudar al cliente a encontrar productos, resolver dudas y guiarlo hacia una compra de forma natural y cercana.

ESTILO DE COMUNICACIÓN:
- Habla siempre en español.
- Usa un tono natural, amigable y profesional.
- Escribe como una persona real, no como un sistema.
- Usa frases cortas y claras.
- Evita lenguaje técnico o robótico.
- No uses formato markdown (sin asteriscos, sin guiones para listas, sin negrillas). El texto debe quedar limpio.
- Evita expresiones que suenan artificiales o repetitivas como "Genial".
- Puedes empezar la respuesta con palabras como "Perfecto", "Vale", "Claro", "Listo", "Dale", o continuar directamente sin muletillas si suena más natural.
- No inicies cada mensaje con un saludo.
- No digas "Hola" ni te presentes nuevamente si la conversación ya está en curso.
- Solo saluda cuando sea el primer mensaje o cuando el cliente salude después de mucho tiempo.

SALUDO INICIAL:
- En el primer saludo, NO menciones el giro de la tienda ni detalles sobre productos (velas, jabones, insumos, etc.).
- El cliente ya sabe a qué se dedica Manuarte.
- Haz el saludo sencillo, sin detalles sobre productos o la tienda. Menciona tu nombre.
- Dependiendo de la hora del día (horario Colombia o Ecuador), puedes usar saludos como "buenos días", "buenas tardes" o "buenas noches" de forma natural, pero no es obligatorio.
- La pregunta final del saludo es SIEMPRE una de estas cuatro opciones, copia exacta sin ninguna variación: "¿En qué le puedo ayudar?", "¿En qué le puedo ayudar el día de hoy?", "¿En qué puedo ayudarle?", o "¿En qué puedo ayudarle el día de hoy?". PROHIBIDO usar cualquier otra pregunta diferente, reformulación o variante.
- Solo menciona detalles de la tienda o productos si el cliente lo pregunta explícitamente.
- Trata siempre al cliente de usted, no de tú.
- CRÍTICO: el mensaje de saludo inicial es MUY CORTO. SOLO contiene: (1) saludo opcional con horario, (2) presentación como Gema si aplica, (3) UNA de las preguntas aprobadas. TERMINA AHÍ. No añadas NINGUNA frase guía, aclaración ni explicación adicional después de la pregunta.

EMOJIS:
- Usa emojis con moderación: máximo 1 por mensaje y no en todos los mensajes.
- Varía los emojis según el contexto: puede ser 👋, ✨, 🕯️, 🧴, 💛, 👌, 🙌, etc.
- Nunca uses 😊 de forma repetitiva ni lo pongas como cierre automático de cada mensaje.
- Si el mensaje es informativo o de seguimiento, omite el emoji.

REGLAS IMPORTANTES:
- Nunca menciones que eres un bot o una IA.
- Nunca inventes productos, precios o disponibilidad.
- Usa únicamente la información que se te proporcione.
- Si no tienes suficiente información, pide más detalles de forma natural.
- No repitas siempre las mismas frases.
- Evita estructuras rígidas tipo sistema.
- Prioriza fluidez sobre formalidad.
- Si una frase suena como interfaz o software, reescríbela de forma conversacional.
- Usa el artículo y género gramatical correcto para cada producto. Infiere el género por el nombre. Ejemplos: "un colorante", "una cera", "un aceite", "una fragancia", "una mecha", "un molde". NUNCA digas "un cera" ni "una colorante".

COMPORTAMIENTO:
- Siempre intenta entender qué necesita el cliente.
- Da respuestas útiles, no solo informativas.
- Después de responder sobre productos o cotizaciones, guía con una frase que oriente al siguiente paso. EXCEPCIÓN: en el saludo inicial, la pregunta de bienvenida ya es suficiente, no añadas nada más. Para respuestas informativas (ubicación, envíos, costos, formas de pago, horarios, políticas, etc.), NUNCA termines con una pregunta — termina SOLO con una frase declarativa de disposición, y ÚNICAMENTE si el mensaje anterior de Gema no terminó con una; si ya hubo una, no añadas nada al final.
- Adapta tus respuestas según lo que diga el cliente.

CUANDO HAY PRODUCTOS:
-No uses asteriscos ni markdown para resaltar.
-No agregues información descriptiva ni promocional que no se haya pedido. Nombre, precio y cantidad: nada más.
-Si hay UN SOLO producto con UNA SOLA variante, no hagas lista: preséntalo en una frase breve y directa. Ejemplo: "Tenemos [nombre] a [precio]." No añadas descripciones, ventajas ni texto de relleno. Usa preguntas en singular: "¿Le interesa?" o "¿Lo lleva?".
-Si un producto tiene VARIAS variantes, muéstralas SIEMPRE como sub-ítems bajo el nombre del producto, NUNCA como ítems numerados separados. Formato obligatorio:
	Nombre del producto:
	- Variante 1 – precio
	- Variante 2 – precio
	CRÍTICO: NUNCA pongas cada variante como "1. Nombre – precio" y "2. Nombre – precio". Las variantes del MISMO producto van con guion (-), no numeradas.
-Si hay VARIOS productos distintos, preséntalos en lista numerada:
	1. Nombre – precio
	2. Nombre – precio
-Si hay VARIOS productos, haz una sola pregunta directa para que el cliente elija, por ejemplo: "¿Cuál le interesa?" o "¿Cuál desea llevar?".
-No preguntes si quiere saber más sobre los productos ni des opciones para preguntar.
-Guía siempre hacia la elección y cotización.
-Usa preguntas directas y simples.
-Evita frases largas antes de la pregunta.
-No des conclusiones como "ambos son excelentes" si no aportan a la decisión.

CUANDO EL CLIENTE ELIGE UN PRODUCTO:
- Nunca uses frases como:
  "Has elegido", "Seleccionaste", "Has seleccionado", "Elegiste"
- Nunca anuncies la selección como si fuera un sistema.
- Responde como si ya estuvieran hablando naturalmente del producto.
- Empieza la respuesta de forma natural, por ejemplo:
  "Perfecto", "Vale", "Claro", "Genial", o directamente con la explicación.
- Menciona el nombre del producto dentro de la explicación de forma natural.
- No lo presentes como título ni como selección confirmada.
- Ejemplo correcto: "La cera de soja es ideal..." en lugar de "Has elegido la cera de soja".
- CRÍTICO: Usa ÚNICAMENTE los datos de nombre, variante, precio y disponibilidad que se te proporcionen. NUNCA inventes ni uses datos de tu entrenamiento (presentaciones, gramajes, precios, cantidades). Si el dato no está en el contexto, no lo menciones.
- Invita a continuar, pero NUNCA ofrezcas hacer una cotización a menos que el cliente lo pida explícitamente.
- Haz solo UNA pregunta al final.
- La pregunta debe ser corta, clara y directa.
- Evita preguntas dobles o largas.
- No hagas preguntas abiertas después de mostrar un producto.
- No preguntes si quiere más información.
- Asume intención de compra y guía hacia cantidad o siguiente paso.

CUANDO EL CLIENTE INDICA UNA CANTIDAD:
- Confirma la cantidad de forma natural incluyendo: cantidad, nombre del producto, variante, precio unitario y total.
- Varía la frase inicial cada vez. Ejemplos: "Listo, serían...", "Perfecto, serían...", "Dale, van...", "Vale, serían...", "Claro, serían...". No repitas siempre la misma.
- Si no tienes el precio, confirma solo la cantidad y el nombre.
- Después de la confirmación, agrega SOLO UNA pregunta corta como "¿Necesita algo más?" o "¿Desea continuar con el pedido?"
- PROHIBIDO usar frases como: "Puedo reservarte", "hay cantidades suficientes", "sin problema", "Es una excelente opción", "con gusto".
- NO añadas comentarios sobre el producto ni frases de cortesía adicionales.

- No siempre empieces con "La [producto]..."
- A veces puedes usar:
  - "Es una..."
  - "Le sirve mucho para..."
  - "Funciona muy bien para..."
- Pero asegúrate de que el producto quede claro en el mensaje.

CUANDO HAY OBJECIONES:
- Si el cliente dice que está caro, ofrece una presentación más pequeña o más económica, SOLO si existe y está disponible. Nunca inventes productos, precios o disponibilidad.
- Si dice que lo va a pensar, que después o que te avisa, despídete con calidez y deja la puerta abierta.
- Nunca presiones ni repitas el precio.
- Sé breve y humano.
- Ejemplo espera: "Sin problema, aquí estoy cuando lo necesites."

CUANDO NO ENCUENTRES LO QUE BUSCA:
- No digas simplemente "no encontrado".
- Responde de forma natural.
- Pide más detalles o reformula la pregunta.

VENTA (MUY IMPORTANTE):
- Si puedes, haz preguntas para entender mejor:
  - ¿Para qué lo va a usar?
  - ¿Busca algo económico o de mejor calidad?
- Sugiere ayuda sin ser insistente.

CONTEXTO:
- Si el cliente ya estaba hablando de un producto, tenlo en cuenta.
- Si el cliente hace preguntas cortas ("precio?", "tienes más barato?"), interpreta el contexto.

OBJETIVO FINAL:
- Que el cliente sienta que está hablando con una persona real.
- Generar confianza.
- Facilitar la compra.
`;

export interface OpenAIProductVariant {
	name: string;
	totalQty: number;
	price: string | null;
}

export interface OpenAIProduct {
	name: string;
	description?: string;
	variants: OpenAIProductVariant[];
}

export interface OpenAICartItem {
	productName: string;
	variantName?: string;
	quantity: number;
	unitPrice: string | null;
	currency: string;
}

export interface OpenAIContext {
	userMessage: string;
	products?: OpenAIProduct[];
	hasMoreProducts?: boolean;
	isShowingMore?: boolean;
	selectedProduct?: OpenAIProduct;
	selectedProducts?: OpenAIProduct[];
	resumptionProduct?: OpenAIProduct;
	currency?: string;
	isFirstInteraction?: boolean;
	intent?: string;
	lastBotMessage?: string;
	quantity?: number;
	cart?: OpenAICartItem[];
	outOfStockProductName?: string;
	/** Producto removido del carrito (para edit_cart) */
	removedProduct?: string;
	/** Producto agregado/actualizado en carrito (para edit_cart) */
	addedProduct?: OpenAIProduct;
	addedQuantity?: number;
	/** Cantidad que el cliente pidió originalmente (antes de limitar al stock) */
	requestedQuantity?: number;
	/** Nota personalizada de stock excedido (reemplaza el mensaje genérico cuando las unidades no representan la cantidad que el cliente entiende) */
	stockExceededNote?: string;
	/** Datos recopilados del cliente en flujo de cotización */
	quoteFlowData?: {
		fullName?: string;
		dni?: string;
		phoneNumber?: string;
		location?: string;
		cityName?: string;
	};
	/** Datos recopilados del cliente en flujo de compra */
	purchaseFlowData?: {
		fullName?: string;
		dni?: string;
		phoneNumber?: string;
		location?: string;
		cityName?: string;
	};
	/** Candidatos de ciudad para selección */
	cityCandidates?: Array<{ index: number; name: string; region: string }>;
	/** Número de serie de cotización creada */
	quoteSerialNumber?: string;
	/** Aviso de productos sin stock suficiente para incluir en el mensaje antes de la pregunta de confirmación */
	outOfStockNote?: string;
	/** true si el número nunca ha interactuado con el bot según los logs */
	isFirstEverInteraction?: boolean;
	/** Nombre completo del cliente registrado en BD (solo cuando es una persona, no empresa) */
	knownCustomerName?: string;
	/** true cuando el bot ya nombró al cliente en el primer show_cart de esta sesión */
	hasShownCartByName?: boolean;
	/** Contexto externo recuperado por el sistema RAG (fichas técnicas, FAQs, etc.) */
	ragContext?: string;
	/** Tipo del documento RAG encontrado: 'faq' para preguntas frecuentes, 'datasheet' para fichas técnicas */
	ragType?: 'faq' | 'datasheet';
	/** true cuando el RAG devuelve un documento que no se había mencionado antes en la conversación */
	isFirstRagMention?: boolean;
}

export type AIDetectedIntent =
	| 'select_product'
	| 'search_product'
	| 'show_more'
	| 'show_cart'
	| 'edit_cart'
	| 'request_quote'
	| 'purchase_intent'
	| 'greeting'
	| 'objection'
	| 'general_question'
	| 'unknown';

export interface QuoteCorrectionResult {
	fullName?: string;
	dni?: string;
	phoneNumber?: string;
	location?: string;
	city?: string;
	productsToAdd?: Array<{
		productHint: string;
		quantity: number;
		variantHint?: string;
		unit?: string;
	}>;
}

export interface AIIntentResult {
	intent: AIDetectedIntent;
	searchQuery?: string;
	selectionIndexes?: number[];
	variantHint?: string;
	quantity?: number;
	/** Cantidades por producto cuando se seleccionan varios; paralelo a selectionIndexes */
	quantities?: number[];
	/** Fragmento del nombre del producto a ELIMINAR del carrito */
	removeProductHint?: string;
	/** Fragmento del nombre del producto a AGREGAR/ACTUALIZAR en cantidad */
	addProductHint?: string;
	/** Para actualizaciones de DOS O MÁS productos simultáneamente en el carrito */
	cartEdits?: Array<{ productHint: string; quantity: number }>;
	/** Lista de productos con cantidades cuando el cliente pide cotización con lista en el mismo mensaje */
	productList?: Array<{
		productHint: string;
		quantity: number;
		variantHint?: string;
		unit?: string;
	}>;
}

export class OpenAIService {
	private client: OpenAI;

	constructor() {
		this.client = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });
	}

	getEmbedding = async (text: string): Promise<number[]> => {
		const response = await this.client.embeddings.create({
			model: 'text-embedding-3-small',
			input: text,
		});
		return response.data[0].embedding;
	};

	generateReply = async (ctx: OpenAIContext): Promise<string> => {
		const userContent = this.buildUserContent(ctx);

		const response = await this.client.chat.completions.create({
			model: 'gpt-4o-mini',
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: userContent },
			],
			max_tokens: 400,
			temperature: 0.6,
		});

		return response.choices[0]?.message?.content?.trim() ?? '';
	};

	detectIntentWithAI = async (
		text: string,
		hasActiveProductList: boolean,
		activeProducts?: Array<{ index: number; label: string }>,
		awaitingMoreProducts?: boolean,
		currentSelectedProduct?: string,
		cart?: OpenAICartItem[],
		lastBotMessage?: string,
	): Promise<AIIntentResult> => {
		const selectedProductNote = currentSelectedProduct
			? `\nNota: el cliente tiene actualmente seleccionado el producto "${currentSelectedProduct}". Si el mensaje menciona EXPLÍCITAMENTE el nombre de otro producto de la lista, clasifícalo como "select_product". Si el mensaje es SOLO un número sin más contexto, o un número seguido de una presentación o tamaño (ej: "2 de 20 ml", "3 de 100 gramos", "1 de 30ml", "2 de 500 gr"), clasifícalo como "unknown" con quantity y variantHint con el tamaño/presentación si aplica.\n`
			: '';
		const productListSection =
			activeProducts && activeProducts.length > 0
				? `\nEl cliente tiene esta lista de productos activa:\n${activeProducts.map(p => `${p.index}. ${p.label}`).join('\n')}\n`
				: hasActiveProductList
					? '\nNota: el cliente tiene una lista de productos activa en la conversación.'
					: '';

		const showMoreNote = awaitingMoreProducts
			? '\nNota: hay más productos disponibles que no se le han mostrado al cliente todavía.\n'
			: '';

		const cartNote =
			cart && cart.length > 0
				? `\nEl cliente tiene estos productos en su pedido actual:\n${cart
						.map(item => {
							const name = item.variantName
								? `${item.productName} ${item.variantName}`
								: item.productName;
							return `- ${item.quantity}x ${name}`;
						})
						.join(
							'\n',
						)}\nSi el mensaje menciona cambiar cantidad, eliminar o modificar alguno de esos productos → clasifica como "edit_cart". IMPORTANTE: si el mensaje contiene verbos como "agrega", "añade", "suma", "quita", "saca" + nombre de un producto del pedido → es SIEMPRE "edit_cart", aunque haya una lista de productos activa con números. TAMBIÉN clasifica como "edit_cart" cuando: (1) el mensaje es solo [número] [nombre] sin verbo (ej: "5 fragancia chicle", "3 bases glicerina"); (2) el mensaje usa frases de corrección como "son N X", "deben ser N X", "mejor N X", "que sean N X", "en realidad N X". En ambos casos usa "addProductHint" con el nombre y "quantity" con el número. NUNCA generes "addProductHint" cuando el mensaje contiene SOLO un verbo de eliminación ("quita", "saca", "ya no quiero", "elimina") sin intención de agregar otro producto.\n`
				: '';

		const selectionInstructions =
			activeProducts && activeProducts.length > 0
				? `  - "select_product": el cliente elige uno o más productos de la lista activa (por número, nombre completo o fragmento del nombre). IMPORTANTE: si el cliente menciona una palabra o fragmento que coincide con cualquier parte del nombre de un producto de la lista (ej: "tr plus" coincide con "BASE DE GLICERINA EASY SOAP TR PLUS-TRANSPARENTE KILO"), clasifícalo como "select_product", NO como "search_product".\n`
				: '';

		const showMoreInstruction =
			hasActiveProductList || (activeProducts && activeProducts.length > 0)
				? `  - "show_more": el cliente pregunta si hay más opciones, más productos, más variantes, o pide ver más (incluyendo frases negativas como "¿no tienen más?", "¿no hay más?", "¿solo eso tienen?", "¿solo tienes esa?", "¿nada más?", "¿no tienes otra?"). IMPORTANTE: si el cliente dice "tienes más [nombre de producto]" (ej: "tienes más mechas"), clasifícalo como "search_product", no "show_more".\n`
				: '';

		const contextNote = lastBotMessage
			? `\nContexto: el último mensaje del bot fue: "${lastBotMessage.slice(0, 200)}". Si el mensaje del cliente es un seguimiento corto sin tema explícito (ej: "¿qué precio tiene?", "¿cuánto cuesta?"), resuélvelo en ese contexto. Para intent "general_question" en ese caso, incluye también "searchQuery" con la consulta concreta contextualizada (ej: bot habló de envíos + cliente pregunta "¿qué precio tiene?" → searchQuery: "costo de envío").\n`
			: '';
		const systemPrompt = `Eres un clasificador de intents para un chatbot de ventas.${selectedProductNote}${productListSection}${showMoreNote}${cartNote}${contextNote}
Analiza el mensaje del cliente y devuelve un JSON con:
- "intent": uno de estos valores exactos:
${selectionInstructions}${showMoreInstruction}  - "show_cart": el cliente pregunta por el resumen de su pedido, lo que lleva, el total, cuánto es todo, cuánto sería por todo, cuánto suma lo que lleva, o cualquier variante de solicitar el detalle o precio total de su pedido actual
  - "search_product": el cliente busca un producto que NO está en la lista actual, o pregunta por precio/disponibilidad de algo nuevo
  - "edit_cart": el cliente quiere MODIFICAR su pedido actual: eliminar un producto, cambiar cantidad de uno ya agregado, o reemplazar uno por otro
  - "request_quote": el cliente quiere cotizar o pide una cotización, presupuesto o proforma. Incluye el verbo "cotizar" y sus variantes (cotizame, cotíceme, me cotizas, me cotices, necesito cotizar, quiero cotizar, cotiza esto), y también frases como "quiero una cotización", "necesito una cotización", "quiero que me armen una cotización", "envíame la cotización", "genera la cotización"
  - "purchase_intent": el cliente dice que quiere comprar, pagar, finalizar su pedido o completar su compra (frases como "quiero comprar", "quiero pagar", "cómo pago", "cómo compro", "finalizar pedido", "completar la compra", "quiero proceder", "quiero el pedido", "quiero finalizarlo"). IMPORTANTE: si el mensaje contiene "voy a llevar [producto/cantidad]", "me llevo [producto]", "quiero llevar [producto]", "voy a llevar [número]" u otras frases donde "llevar" acompaña un nombre de producto o una cantidad, NO es "purchase_intent" — clasificar como "search_product" (si el producto no está en la lista activa) o "select_product" (si está en la lista activa). Ejemplos: "Voy a llevar 5 kilos de cera de palma" → search_product; "Me llevo esa" → select_product si hay lista activa
  - "objection": el cliente dice que está caro, que lo va a pensar, que después, que no tiene dinero, que no le interesa
  - "greeting": saludo puro sin consulta de producto ni pregunta específica
  - "general_question": pregunta sobre envíos, métodos de pago, tiempo de entrega, políticas, características o propiedades de un producto ya mencionado, u otras preguntas que no buscan un producto nuevo en catálogo. TAMBIÉN clasifica como "general_question" cuando el cliente responde con el uso o aplicación que quiere darle a un producto (ej: "fabricación de jabones", "para aromaterapia", "para hacer velas")
  - "unknown": no se puede clasificar con certeza
${activeProducts && activeProducts.length > 0 ? '- "selectionIndexes": array de números 1-based SOLO si intent es "select_product". Puede ser uno o varios. Ej: [1] o [1,3]\n- "variantHint": SOLO si intent es "select_product" y el producto elegido tiene múltiples variantes y el cliente menciona una variante específica. Extrae el fragmento del nombre de la variante mencionada. Ej: "quiero la apf" → variantHint: "apf"\n- "quantities": array de números SOLO si intent es "select_product" y el cliente menciona una cantidad distinta para cada producto. Misma longitud y orden que selectionIndexes. Ej: "3 de chicle y 2 de floral" con selectionIndexes:[2,3] → quantities:[3,2]. Si todos los productos tienen la misma cantidad o no hay cantidad, omite este campo y usa "quantity".\n' : ''}- "quantity": número entero SOLO si el cliente menciona UNA sola cantidad que aplica a todos los productos seleccionados, o a cualquier otro intent. Ej: "dame 5", "quiero 3 kilos" → quantity: 5 o 3. No usar junto a "quantities".
- "removeProductHint": SOLO si intent es "edit_cart" Y el cliente pide EXPLÍCITAMENTE quitar/eliminar un producto (frases como "ya no quiero", "quita", "saca", "elimina", "sin"). NO usar si el cliente solo cambia la cantidad. CRÍTICO: si el mensaje contiene SOLO un verbo de eliminación sin intención de agregar otro producto, genera ÚNICAMENTE "removeProductHint" y NUNCA "addProductHint" para el mismo producto. Ej: "ya no quiero la mecha 8D" → removeProductHint: "mecha 8D" (sin addProductHint). "que sean mejor 2 kilos de ácido esteárico" → NO removeProductHint (solo addProductHint con la nueva cantidad).
- "addProductHint": SOLO si intent es "edit_cart" Y el cliente modifica UN SOLO producto. Usa el fragmento MÁS ESPECÍFICO: las palabras que diferencian ese producto de otros en el pedido. Si hay varios productos del mismo tipo, DEBES incluir las palabras distintivas. Ej: "agrega 2 fragancias más de brisa marina" → addProductHint: "brisa marina" (NO "fragancia"). "agrega 1 kilo más de cera de coco" → addProductHint: "cera de coco"
- "cartEdits": SOLO si intent es "edit_cart" Y el cliente modifica DOS O MÁS productos del carrito en un mismo mensaje. Array de objetos {productHint, quantity}. No usar junto con addProductHint. Ej: "deben ser 4 de jazmin y 4 de brisa marina" → cartEdits: [{"productHint":"jazmin","quantity":4},{"productHint":"brisa marina","quantity":4}]
- "productList": SOLO si intent es "request_quote" Y el mensaje contiene una lista de dos o más productos con cantidades. Array de objetos {productHint, quantity, variantHint?, unit?}. "productHint" es el nombre descriptivo del producto (sin frases de contexto). "quantity" es el número entero pedido. "variantHint" es la presentación específica si aplica (ej: "20 ml", "100 gramos"). "unit" es la unidad de peso si la cantidad está en peso (ej: "kilos", "kg", "gramos"). Ej: "Cotizame 5 kilos de cera de palma, 3 fragancias de chicle de 20 ml y 7 mechas 8D" → productList: [{"productHint":"cera de palma","quantity":5,"unit":"kilos"},{"productHint":"fragancia chicle","quantity":3,"variantHint":"20 ml"},{"productHint":"mecha 8d","quantity":7}]
- "variantHint": TAMBIÉN para intent "search_product", si el cliente menciona una presentación, tamaño o formato específico del producto buscado (ej: "20 ml", "100 gramos", "1 litro", "medio kilo"). Extrae SOLO el fragmento de tamaño/presentación. Ej: "3 fragancias de chicle de 20 ml" → variantHint: "20 ml", "2 fragancias lavanda de 100 gramos" → variantHint: "100 gramos". No incluir si no hay presentación específica.
- "searchQuery": (A) SOLO si intent es "search_product" Y el producto mencionado NO aparece en la lista activa. (B) TAMBIÉN si intent es "general_question" Y el mensaje es un seguimiento corto ambiguo: extrae la consulta concreta contextualizada (ej: "costo de envío", "tiempo de entrega"). Extrae el nombre específico del producto incluyendo su descriptor propio (sabor, aroma, nombre de marca, tipo). Conserva "para velas" o "para jabones" si pueden ser parte del nombre del producto (hay productos exclusivos para uno u otro). Elimina SOLO frases de contexto de uso del cliente como "para hacer X", "para mis X", "para fabricar X", "para uso en X". Ejemplos: "fragancias para jabones" → "fragancia para jabones", "fragancia de chicle de 20 ml" → "fragancia chicle", "fragancia de lavanda para velas" → "fragancia lavanda para velas", "colorante para mis velas artesanales" → "colorante", "cera para hacer velas" → "cera", "3 kilos de cera de soya apf" → "cera soya apf".

Responde ÚNICAMENTE con el JSON, sin texto adicional.${activeProducts && activeProducts.length > 0 ? '\nEjemplos:\n{"intent":"select_product","selectionIndexes":[2]}\n{"intent":"select_product","selectionIndexes":[1,3]}\n{"intent":"select_product","selectionIndexes":[1],"quantity":5}\n{"intent":"select_product","selectionIndexes":[2],"variantHint":"apf","quantity":2}\n{"intent":"select_product","selectionIndexes":[1]}  // cliente dice "la tr plus" y el producto 1 contiene "TR PLUS" en su nombre\n{"intent":"select_product","selectionIndexes":[2,3],"quantities":[3,2]}  // cliente dice "3 de chicle y 2 de floral"\n{"intent":"edit_cart","removeProductHint":"mecha 8D"}  // SOLO removeProductHint cuando es eliminación pura, sin addProductHint\n{"intent":"edit_cart","addProductHint":"cera de coco","quantity":1}\n{"intent":"edit_cart","addProductHint":"fragancia chicle","quantity":5}  // "5 fragancia chicle" sin verbo, fragancia chicle está en el pedido\n{"intent":"edit_cart","addProductHint":"bases de glicerina white","quantity":4}  // "son 4 bases de glicerina white"\n{"intent":"edit_cart","cartEdits":[{"productHint":"jazmin","quantity":4},{"productHint":"brisa marina","quantity":4}]}\n{"intent":"search_product","searchQuery":"termometro","quantity":1}  // "1 termometro" cuando termometro no está en la lista\n{"intent":"unknown","quantity":3}' : '\nEjemplo: {"intent":"search_product","searchQuery":"cera de soja"}'}${awaitingMoreProducts ? '\n{"intent":"show_more"}' : ''}`;
		const response = await this.client.chat.completions.create({
			model: 'gpt-4o-mini',
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: text },
			],
			max_tokens: 150,
			temperature: 0,
			response_format: { type: 'json_object' },
		});

		const raw = response.choices[0]?.message?.content?.trim() ?? '{}';
		const parsed = JSON.parse(raw) as {
			intent?: string;
			searchQuery?: string;
			selectionIndexes?: unknown;
			variantHint?: unknown;
			quantity?: unknown;
			quantities?: unknown;
			removeProductHint?: unknown;
			addProductHint?: unknown;
			cartEdits?: unknown;
			productList?: unknown;
		};

		const validIntents: AIDetectedIntent[] = [
			'select_product',
			'search_product',
			'show_more',
			'show_cart',
			'edit_cart',
			'request_quote',
			'purchase_intent',
			'greeting',
			'objection',
			'general_question',
			'unknown',
		];
		const intent: AIDetectedIntent = validIntents.includes(
			parsed.intent as AIDetectedIntent,
		)
			? (parsed.intent as AIDetectedIntent)
			: 'unknown';

		const selectionIndexes: number[] | undefined =
			intent === 'select_product' && Array.isArray(parsed.selectionIndexes)
				? (parsed.selectionIndexes as unknown[])
						.map(Number)
						.filter(n => Number.isInteger(n) && n > 0)
				: undefined;

		const quantity: number | undefined =
			typeof parsed.quantity === 'number' && parsed.quantity > 0
				? parsed.quantity
				: undefined;

		const quantities: number[] | undefined =
			intent === 'select_product' && Array.isArray(parsed.quantities)
				? (parsed.quantities as unknown[])
						.map(Number)
						.filter(n => Number.isInteger(n) && n > 0)
				: undefined;

		return {
			intent,
			searchQuery:
				(intent === 'search_product' || intent === 'general_question') &&
				parsed.searchQuery
					? String(parsed.searchQuery)
					: undefined,
			selectionIndexes,
			variantHint:
				(intent === 'select_product' || intent === 'search_product') &&
				parsed.variantHint
					? String(parsed.variantHint)
					: undefined,
			quantity,
			quantities,
			removeProductHint:
				intent === 'edit_cart' && parsed.removeProductHint
					? String(parsed.removeProductHint)
					: undefined,
			addProductHint:
				intent === 'edit_cart' && parsed.addProductHint
					? String(parsed.addProductHint)
					: undefined,
			cartEdits:
				intent === 'edit_cart' && Array.isArray(parsed.cartEdits)
					? (parsed.cartEdits as unknown[]).filter(
							(e): e is { productHint: string; quantity: number } =>
								typeof e === 'object' &&
								e !== null &&
								typeof (e as Record<string, unknown>).productHint ===
									'string' &&
								typeof (e as Record<string, unknown>).quantity === 'number' &&
								(e as { quantity: number }).quantity > 0,
						)
					: undefined,
			productList:
				intent === 'request_quote' && Array.isArray(parsed.productList)
					? (parsed.productList as unknown[]).filter(
							(
								e,
							): e is {
								productHint: string;
								quantity: number;
								variantHint?: string;
								unit?: string;
							} =>
								typeof e === 'object' &&
								e !== null &&
								typeof (e as Record<string, unknown>).productHint ===
									'string' &&
								typeof (e as Record<string, unknown>).quantity === 'number' &&
								(e as { quantity: number }).quantity > 0,
						)
					: undefined,
		};
	};

	private buildUserContent = (ctx: OpenAIContext): string => {
		const parts: string[] = [`Cliente: ${ctx.userMessage}`];
		const currency = ctx.currency ?? 'COP';

		const isGenericGreeting = /^(hola|buenas|hey|holi|ola)$/i.test(
			ctx.userMessage.trim(),
		);

		if (ctx.isFirstInteraction) {
			if (ctx.isFirstEverInteraction && ctx.knownCustomerName) {
				// Primer contacto real: cliente existe en BD
				if (ctx.products && ctx.products.length > 0) {
					parts.push(
						`\nEs la primera vez que este cliente escribe al bot. Su nombre en el sistema es "${ctx.knownCustomerName}". Si ese nombre parece un nombre de persona (no de empresa), preséntate como Gema y salúdalo usando ÚNICAMENTE su PRIMER NOMBRE (no el apellido) con el honorífico apropiado (Sr./Sra.) en UNA línea breve, luego muestra los productos directamente. Por ejemplo, si el nombre es "Carlos Hernandez", escribe "Sr. Carlos", NO "Sr. Hernandez". Si parece nombre de empresa, preséntate como Gema sin usar el nombre. Usa siempre "usted" (nunca "tú"). No hagas el saludo y los productos como bloques separados.`,
					);
				} else {
					parts.push(
						`\nEs la primera vez que este cliente escribe al bot. Su nombre en el sistema es "${ctx.knownCustomerName}". Si ese nombre parece un nombre de persona (no de empresa), preséntate como Gema y salúdalo usando ÚNICAMENTE su PRIMER NOMBRE (no el apellido) con el honorífico apropiado (Sr./Sra.) de forma natural y breve. Por ejemplo, si el nombre es "Carlos Hernandez", escribe "Sr. Carlos", NO "Sr. Hernandez". Si parece nombre de empresa, preséntate como Gema sin usar el nombre. Usa siempre "usted" (nunca "tú"). No menciones productos ni el giro de la tienda. El mensaje debe terminar EXACTAMENTE con UNA de estas preguntas: "¿En qué le puedo ayudar?", "¿En qué le puedo ayudar el día de hoy?", "¿En qué puedo ayudarle?" o "¿En qué puedo ayudarle el día de hoy?". NO añadas NADA después de la pregunta.`,
					);
				}
			} else if (ctx.isFirstEverInteraction) {
				// Primer contacto real: cliente desconocido
				if (ctx.products && ctx.products.length > 0) {
					parts.push(
						'\nEs la primera vez que este cliente escribe al bot. Respóndele en un ÚNICO mensaje: empieza con una presentación muy breve de una sola línea (solo tu nombre, sin detalles de productos ni de la tienda), y a continuación muestra los productos directamente. Usa siempre "usted" (nunca "tú"). No hagas el saludo y los productos como bloques separados.',
					);
				} else {
					parts.push(
						'\nEs la primera vez que este cliente escribe. Preséntate brevemente como Gema. El mensaje debe ser MUY CORTO y terminar EXACTAMENTE con UNA de estas preguntas: "¿En qué le puedo ayudar?", "¿En qué le puedo ayudar el día de hoy?", "¿En qué puedo ayudarle?" o "¿En qué puedo ayudarle el día de hoy?". NO añadas NADA después de la pregunta. Usa siempre "usted" (nunca "tú").',
					);
				}
			} else {
				// Sesión Redis expirada, pero cliente ya conoce el bot
				if (ctx.products && ctx.products.length > 0) {
					parts.push(
						ctx.knownCustomerName
							? `\nEl cliente ya ha hablado antes con el bot pero su sesión expiró. Su nombre en el sistema es "${ctx.knownCustomerName}". Respóndele en un ÚNICO mensaje: empieza con un saludo breve y natural sin presentarte como Gema nuevamente. Si parece un nombre de persona (no de empresa), salúdalo usando ÚNICAMENTE su PRIMER NOMBRE (no el apellido) con el honorífico apropiado (Sr./Sra.). Por ejemplo, si el nombre es "Carlos Hernandez", escribe "Sr. Carlos", NO "Sr. Hernandez". A continuación muestra los productos. Usa siempre "usted" (nunca "tú").`
							: '\nEl cliente ya ha hablado antes con el bot pero su sesión expiró. Respóndele en un ÚNICO mensaje: empieza con un saludo breve y natural sin presentarte como Gema nuevamente, y a continuación muestra los productos. Usa siempre "usted" (nunca "tú").',
					);
				} else {
					parts.push(
						ctx.knownCustomerName
							? `\nEl cliente ya ha hablado antes con el bot pero su sesión expiró. Su nombre en el sistema es "${ctx.knownCustomerName}". Salúdalo de forma natural y breve sin presentarte como Gema nuevamente. Si parece un nombre de persona (no de empresa), salúdalo usando ÚNICAMENTE su PRIMER NOMBRE (no el apellido) con el honorífico apropiado (Sr./Sra.). Por ejemplo, si el nombre es "Carlos Hernandez", escribe "Sr. Carlos", NO "Sr. Hernandez". Termina con UNA pregunta corta natural. NO añadas frases de guía adicionales después de la pregunta. Usa siempre "usted" (nunca "tú").`
							: '\nEl cliente ya ha hablado antes con el bot pero su sesión expiró. Salúdalo de forma natural y breve sin presentarte como Gema nuevamente. Termina con UNA pregunta corta natural. NO añadas frases de guía adicionales después de la pregunta. Usa siempre "usted" (nunca "tú").',
					);
				}
			}
		} else {
			parts.push(
				'\nLa conversación ya está en curso. No saludes ni te presentes nuevamente. Continúa de forma directa.',
			);
		}

		if (ctx.intent === 'objection') {
			if (ctx.selectedProduct) {
				const p = ctx.selectedProduct;
				const variantDetails = p.variants
					.map(v => `  - ${v.name}: ${formatPrice(v.price, currency)}`)
					.join('\n');
				parts.push(
					`\nProducto sobre el que hay objeción:\nNombre: ${p.name}` +
						(p.description ? `\nDescripción: ${p.description}` : '') +
						`\nVariantes disponibles:\n${variantDetails}`,
				);
			}
			if (ctx.products && ctx.products.length > 0) {
				const productList = ctx.products
					.map((p, i) => {
						if (p.variants.length === 1) {
							const v = p.variants[0];
							const label = v.name
								? `${p.name} ${v.name}`
								: p.description
									? `${p.name} (${p.description})`
									: p.name;
							return `${i + 1}. ${label} – ${formatPrice(v.price, currency)}`;
						}
						const variantLines = p.variants
							.map((v, idx) => {
								const varLabel = v.name || `Opción ${idx + 1}`;
								return `  - ${varLabel}: ${formatPrice(v.price, currency)}`;
							})
							.join('\n');
						return `${i + 1}. ${p.name}\n${variantLines}`;
					})
					.join('\n');
				parts.push(
					`\nProductos disponibles en la conversación (solo estos existen, no inventes otros):\n${productList}`,
				);
			}
			parts.push(
				'\nEl cliente tiene una objeción de precio o dudas. Responde con empatía y de forma breve.' +
					'\nSi el producto tiene variantes más pequeñas o económicas en la lista anterior, preséntaselas directamente sin preguntar si quiere verlas. No inventes productos, precios o disponibilidad.' +
					'\nSi hay otros productos más económicos en la lista, mencionarlos directamente.' +
					'\nSi no hay alternativas disponibles y el cliente solo quiere pensarlo o esperar, despídete con calidez y deja la puerta abierta.' +
					'\nNunca presiones, nunca repitas el precio completo, nunca inventes productos o presentaciones que no estén en la lista.',
			);
		} else if (ctx.intent === 'affirmation') {
			if (ctx.lastBotMessage) {
				parts.push(
					`\nAntes de que el cliente respondiera, tú habías dicho: "${ctx.lastBotMessage}"`,
				);
				parts.push(
					'\nEl cliente está confirmando o dando su acuerdo. Interpreta qué preguntaste en tu mensaje anterior y continúa de forma natural en consecuencia. No preguntes qué quiso decir ni pidas aclaración.',
				);
			}
			if (ctx.products && ctx.products.length > 0) {
				const productList = ctx.products
					.map((p, i) => {
						if (p.variants.length === 1) {
							const v = p.variants[0];
							const label = v.name
								? `${p.name} ${v.name}`
								: p.description
									? `${p.name} (${p.description})`
									: p.name;
							return `${i + 1}. ${label} – ${formatPrice(v.price, currency)}`;
						}
						const variantLines = p.variants
							.map((v, idx) => {
								const varLabel = v.name || `Opción ${idx + 1}`;
								return `  - ${varLabel}: ${formatPrice(v.price, currency)}`;
							})
							.join('\n');
						return `${i + 1}. ${p.name}\n${variantLines}`;
					})
					.join('\n');
				parts.push(
					`\nProductos disponibles en la conversación actual (usa si son relevantes para continuar):\n${productList}`,
				);
				if (ctx.outOfStockProductName) {
					parts.push(
						`\nCRÍTICO: El cliente preguntó por "${ctx.outOfStockProductName}" pero NO está disponible. Aunque el mensaje del cliente contenga una cantidad, NO confirmes el pedido ni la cantidad. NO digas que sí lo tienes. PRIMERO di en UNA frase corta y natural que no lo tienes disponible, y LUEGO presenta la lista de alternativas disponibles sin ningún comentario adicional. Ejemplo: "La [nombre] no la tenemos disponible en este momento. Sí tenemos:"`,
					);
					parts.push(
						'\nTermina con la pregunta "¿Desea llevar alguno de estos?" o una variación natural similar. NO uses "¿Cuál le interesa?" ni "¿Cuál desea llevar?" en este caso.',
					);
				}
			} else if (ctx.outOfStockProductName) {
				parts.push(
					`\nCRÍTICO: El cliente preguntó por un producto que NO está disponible. Aunque el mensaje del cliente contenga una cantidad, NO confirmes el pedido ni la cantidad. Di en UNA frase corta y natural que no lo tienes disponible. Usa el nombre EXACTO del producto tal como está escrito aquí (sin cambiar mayúsculas ni reformatear): "${ctx.outOfStockProductName}". Termina con una pregunta simple como "¿Le puedo ayudar con algún otro producto?".`,
				);
			}
		} else if (ctx.selectedProducts && ctx.selectedProducts.length > 1) {
			// Múltiples productos seleccionados
			const productList = ctx.selectedProducts
				.map((p, i) => {
					const variantDetails = p.variants
						.map(v => `  - ${v.name}: ${formatPrice(v.price, currency)}`)
						.join('\n');
					return (
						`${i + 1}. ${p.name}` +
						(p.description ? ` — ${p.description}` : '') +
						`\n${variantDetails}`
					);
				})
				.join('\n');
			parts.push(
				`\nEl cliente seleccionó múltiples productos:\n${productList}\n` +
					(ctx.quantity
						? `\nEl cliente mencionó una cantidad de ${ctx.quantity} unidades.`
						: '') +
					'\nPreséntalos brevemente de forma natural, menciona precios y pregunta cómo quiere continuar.',
			);
			parts.push(
				'\nNo anuncies la selección como sistema. Integra los productos de forma conversacional.',
			);
		} else if (ctx.selectedProduct) {
			const p = ctx.selectedProduct;
			const totalQty = p.variants.reduce((sum, v) => sum + v.totalQty, 0);
			const variantDetails = p.variants
				.map(v => `  - ${v.name}: ${formatPrice(v.price, currency)}`)
				.join('\n');
			if (ctx.quantity) {
				const singleVariant =
					p.variants.length === 1 ? p.variants[0] : undefined;
				const unitPriceNum = singleVariant?.price
					? parseFloat(singleVariant.price)
					: null;
				const totalPriceNum =
					unitPriceNum !== null ? unitPriceNum * ctx.quantity : null;
				const formattedUnit = singleVariant
					? formatPrice(singleVariant.price, currency)
					: null;
				const formattedTotal =
					totalPriceNum !== null
						? formatPrice(totalPriceNum.toString(), currency)
						: null;
				const productLabel = singleVariant?.name
					? `${p.name} ${singleVariant.name}`
					: p.name;
				const isStockExceeded =
					(ctx.requestedQuantity !== undefined &&
						ctx.requestedQuantity > (ctx.quantity ?? 0)) ||
					!!ctx.stockExceededNote;
				if (isStockExceeded) {
					// Stock insuficiente: incluir datos del producto + nota de stock
					const stockNote =
						ctx.stockExceededNote ??
						`El cliente pidió ${ctx.requestedQuantity} unidades pero solo hay ${ctx.quantity} disponible(s). NO confirmes el pedido ni calcules total. Informa brevemente que solo hay ${ctx.quantity} disponible(s) y pregunta si quiere esa cantidad, por ejemplo: "Solo tenemos ${ctx.quantity}, ¿le agrego esa?" o "Solo hay ${ctx.quantity} disponible, ¿la quiere?" u otra variación natural. NUNCA uses frases como "te lo llevo", "te la llevo" ni similares.`;
					parts.push(
						`\nProducto: ${productLabel} a ${formattedUnit ?? 'precio no disponible'}.` +
							`\nIMPORTANTE: ${stockNote}`,
					);
				} else if (formattedUnit && formattedTotal) {
					// Confirmación limpia: NO incluir DATO EXACTO para evitar que el AI
					// mezcle info de disponibilidad con la confirmación
					parts.push(
						`\nResponde SOLO con este contenido: confirma que van ${ctx.quantity} unidades de ${productLabel} a ${formattedUnit} cada una, total ${formattedTotal}. Varía la frase inicial (usa "Listo", "Perfecto", "Dale", "Vale" u otra). Termina con UNA sola pregunta corta: "¿Necesita algo más?" o "¿Desea continuar con el pedido?". NO menciones disponibilidad, NO preguntes cuántas quiere, NO añadas nada más.`,
					);
				} else {
					parts.push(
						`\nEl cliente quiere ${ctx.quantity} unidades de ${productLabel}. Confirma en UNA frase corta. No uses frases como "Puedo reservarte" ni "hay cantidades suficientes". Termina con "¿Necesita algo más?".`,
					);
				}
			} else {
				// Sin cantidad: incluir datos completos del producto
				parts.push(
					`\nDATO EXACTO DEL PRODUCTO (usa ÚNICAMENTE estos datos para precio y disponibilidad, no uses conocimiento externo ni inventes valores):\nNombre: ${p.name}` +
						(p.description ? `\nDescripción: ${p.description}` : '') +
						`\nVariantes y precios:\n${variantDetails}`,
				);
				if (totalQty === 1) {
					parts.push(
						'\nEl cliente ya eligió este producto. No preguntes por cantidad. Confirma el producto y precio de forma natural y guía hacia el siguiente paso (datos de envío, método de pago, etc.).',
					);
				} else if (ctx.lastBotMessage) {
					parts.push(
						`\nTu último mensaje al cliente fue: "${ctx.lastBotMessage}"\nEl cliente está respondiendo a eso. Interpreta su respuesta en ese contexto y continúa de forma natural.`,
					);
				} else {
					parts.push(
						'\nMenciona el nombre del producto y el precio en UNA sola frase corta. No describas el producto ni añadas texto de relleno. Luego haz UNA pregunta directa como "¿Cuántas quiere?" o "¿Cuántas necesita?".',
					);
				}
			}
			parts.push(
				'\nNo anuncies la selección ni uses frases como "has elegido". Integra el producto de forma natural en la conversación.',
			);
		} else if (ctx.resumptionProduct && !isGenericGreeting) {
			// const p = ctx.resumptionProduct;
			// const variantDetails = p.variants
			// 	.map(
			// 		v =>
			// 			`  - ${v.name}: ${formatPrice(v.price, currency)} (${v.totalQty} disponibles)`,
			// 	)
			// 	.join('\n');
			parts.push(
				`\nEl cliente regresa después de un tiempo. Retoma la conversación de forma natural, sin repetir saludos innecesarios. Guía al cliente con una pregunta simple para continuar.`,
			);
		} else if (
			ctx.outOfStockProductName &&
			(!ctx.products || ctx.products.length === 0)
		) {
			// Producto sin stock y sin alternativas disponibles
			parts.push(
				`\nCRÍTICO: El cliente preguntó por un producto que NO está disponible y no hay alternativas. Aunque el mensaje del cliente contenga una cantidad, NO confirmes el pedido ni la cantidad. Di en UNA frase corta y natural que no lo tienes disponible. Usa el nombre EXACTO del producto tal como está escrito aquí (sin cambiar mayúsculas ni reformatear): "${ctx.outOfStockProductName}". Termina con una pregunta simple como "¿Le puedo ayudar con algún otro producto?".`,
			);
		} else if (ctx.products && ctx.products.length > 0) {
			const productList = ctx.products
				.map((p, i) => {
					if (p.variants.length === 1) {
						const v = p.variants[0];
						const label = v.name
							? `${p.name} ${v.name}`
							: p.description
								? `${p.name} (${p.description})`
								: p.name;
						return `${i + 1}. ${label} – ${formatPrice(v.price, currency)}`;
					}
					const variantLines = p.variants
						.map((v, idx) => {
							const varLabel = v.name || `Opción ${idx + 1}`;
							return `  - ${varLabel}: ${formatPrice(v.price, currency)}`;
						})
						.join('\n');
					return `${i + 1}. ${p.name}\n${variantLines}`;
				})
				.join('\n');
			parts.push(
				`\nEsta es la lista de productos que tienes disponibles para mostrarle al cliente:\n${productList}`,
			);
			if (ctx.outOfStockProductName) {
				parts.push(
					`\nCRÍTICO: El cliente preguntó por "${ctx.outOfStockProductName}" pero NO está disponible. Aunque el mensaje del cliente contenga una cantidad, NO confirmes el pedido ni la cantidad. NO digas que sí lo tienes. PRIMERO di en UNA frase corta y natural que no lo tienes disponible, y LUEGO presenta la lista de alternativas disponibles sin ningún comentario adicional. Ejemplo: "La [nombre] no la tenemos disponible en este momento. Sí tenemos:"`,
				);
			} else if (ctx.isShowingMore) {
				if (
					ctx.products.length === 1 &&
					ctx.products[0].variants.length === 1
				) {
					parts.push(
						'\nEl cliente pidió ver más opciones y solo queda este producto con una sola variante. Preséntalo de forma natural y conversacional. Usa frases como "También tenemos [producto]", "Claro, también contamos con [producto]", etc. Menciona el precio y disponibilidad de forma fluida. No hagas listas. Guía hacia la elección con una pregunta directa como "¿Le interesa?" o "¿Lo lleva?".',
					);
				} else {
					parts.push(
						'\nEl cliente pidió ver más opciones. DEBES empezar con una frase que incluya "también" para marcar continuidad, seguida de dos puntos y la lista. Ejemplos OBLIGATORIOS: "También tenemos:", "Claro, también tenemos:", "También contamos con:", "Sí, también hay:". NO uses "Te puedo ofrecer:", "Tenemos:", ni ninguna frase sin "también". No escribas frases largas antes de la lista. MUESTRA TODAS las variantes de cada producto.',
					);
				}
			} else {
				parts.push(
					'\nIntroduce la lista con una frase MUY corta de máximo 4 palabras seguida de dos puntos, y luego la lista. Ejemplos: "Tenemos:", "Le puedo ofrecer:", "Tenemos disponible:", "Aquí van:". NO añadas explicaciones, contexto, ni texto adicional antes o después de la lista (evita frases como "que pueden interesarle para sus X", "Aquí le dejo las opciones disponibles", etc.).',
				);
			}
			if (ctx.outOfStockProductName) {
				parts.push(
					'\nTermina con la pregunta "¿Desea llevar alguno de estos?" o una variación natural similar. NO uses "¿Cuál le interesa?" ni "¿Cuál desea llevar?" en este caso.',
				);
			} else if (ctx.hasMoreProducts) {
				parts.push(
					'\nTermina con una sola pregunta corta para que elija un producto. Varía la pregunta cada vez: "¿Cuál le interesa?", "Cuál desea llevar?", "¿Le interesa alguna?", etc. NO añadas ninguna frase sobre ver más opciones: el cliente ya sabe que puede pedirlas.',
				);
			} else if (
				ctx.products.length === 1 &&
				ctx.products[0].variants.length === 1
			) {
				parts.push(
					'\nSolo hay un producto con una sola variante. Preséntalo en UNA sola frase breve: nombre y precio. NO añadas descripción, ventajas ni texto de relleno. Al final haz una pregunta corta en singular como "¿Le interesa?" o "¿Lo lleva?". NO uses preguntas en plural.',
				);
			} else if (
				ctx.products.length === 1 &&
				ctx.products[0].variants.length > 1
			) {
				parts.push(
					`\nHay un solo producto pero con ${ctx.products[0].variants.length} variantes. DEBES mostrar TODAS las variantes de la lista para que el cliente elija. No omitas ninguna. Al final pregunta cuál va a llevar con una frase corta, por ejemplo, si el producto es por unidades usa "¿Cuál desea llevar?" o si el producto es por kilos/gramos "¿Cuánto desea llevar?" o "¿Cuánto necesita?".`,
				);
			} else {
				parts.push(
					'\nAl final haz una sola pregunta directa para que el cliente elija, por ejemplo: "¿Cuál le interesa?" o "¿Cuál desea llevar?".',
				);
			}
		} else if (ctx.intent === 'show_cart') {
			if (ctx.cart && ctx.cart.length > 0) {
				const cartLines = ctx.cart
					.map(item => {
						const name = item.variantName
							? `${item.productName} ${item.variantName}`
							: item.productName;
						const unitPrice = formatPrice(item.unitPrice, item.currency);
						const total = item.unitPrice
							? formatPrice(
									String(Number(item.unitPrice) * item.quantity),
									item.currency,
								)
							: null;
						return total
							? `- ${item.quantity}x ${name} a ${unitPrice} = ${total}`
							: `- ${item.quantity}x ${name} a ${unitPrice}`;
					})
					.join('\n');
				const grandTotal = ctx.cart.reduce((sum, item) => {
					return (
						sum + (item.unitPrice ? Number(item.unitPrice) * item.quantity : 0)
					);
				}, 0);
				const grandTotalFormatted = formatPrice(
					String(grandTotal),
					ctx.cart[0].currency,
				);
				parts.push(
					`\nEl cliente pide ver el resumen de su pedido. Estos son los productos que lleva:\n${cartLines}\nTotal: ${grandTotalFormatted}\n` +
						(ctx.knownCustomerName && !ctx.hasShownCartByName
							? `El nombre del cliente registrado es "${ctx.knownCustomerName}". Si parece un nombre de persona (no de empresa), inicia el resumen mencionándolo con el honorífico apropiado (Sr./Sra.) según el nombre, por ejemplo: "Listo, Sr. Carlos, su pedido es:". Si parece nombre de empresa, NO menciones el nombre. `
							: '') +
						'Muestra el resumen de forma natural y conversacional. Menciona cada producto con su cantidad, precio unitario y subtotal. Al final muestra el total general. Termina invitándolo a cerrar la compra con una pregunta directa como "¿Le ayudo a finalizar el pedido?" o "¿Finalizamos la compra?". NO preguntes "cómo quiere continuar" ni des opciones abiertas.',
				);
			} else {
				parts.push(
					'\nEl cliente pide ver su pedido pero no tiene ningún producto agregado todavía. Responde de forma natural y guíalo a elegir algo.',
				);
			}
		} else if (ctx.intent === 'edit_cart') {
			if (ctx.removedProduct) {
				parts.push(`\nSe eliminó del pedido: ${ctx.removedProduct}.`);
			}
			if (ctx.addedProduct && ctx.addedQuantity) {
				const v =
					ctx.addedProduct.variants.length === 1
						? ctx.addedProduct.variants[0]
						: undefined;
				const label = v?.name
					? `${ctx.addedProduct.name} ${v.name}`
					: ctx.addedProduct.name;
				const totalPrice =
					v?.price != null ? Number(v.price) * ctx.addedQuantity : null;
				const totalFmt =
					totalPrice !== null
						? formatPrice(String(totalPrice), ctx.currency ?? 'USD')
						: null;
				parts.push(
					`\nAhora hay en total ${ctx.addedQuantity}x ${label} en el pedido` +
						(totalFmt ? ` (subtotal ${totalFmt})` : '') +
						'. Usa EXACTAMENTE esa cantidad y ese total en tu respuesta, sin recalcular.',
				);
			} else if (ctx.cart && ctx.cart.length > 0) {
				const updatedLines = ctx.cart
					.map(item => {
						const name = item.variantName
							? `${item.productName} ${item.variantName}`
							: item.productName;
						return `- ${item.quantity}x ${name}`;
					})
					.join('\n');
				parts.push(`\nEl pedido actualizado queda así:\n${updatedLines}`);
			}
			parts.push(
				'\nConfirma el cambio con una frase corta, natural y variada. Evita frases robóticas como "Se quitó X y el pedido actualizado queda así". ' +
					'En cambio usa expresiones coloquiales como: "¡Listo!", "Perfecto, ya lo quité.", "Hecho, sin problema.", "Ya está, lo removí." seguidas de un resumen breve del pedido si aplica. ' +
					'Si se actualizó la cantidad, menciona la nueva cantidad y el precio total si está disponible. ' +
					(ctx.removedProduct
						? 'Menciona brevemente que se quitó el producto de forma natural. '
						: 'NO menciones eliminaciones. ') +
					'Luego pregunta si necesita algo más de forma breve.',
			);
		} else if (ctx.intent === 'general_question') {
			if (ctx.lastBotMessage) {
				parts.push(
					`\nContexto conversacional — tu mensaje anterior al cliente fue: "${ctx.lastBotMessage}"`,
				);
			}
			if (ctx.ragContext) {
				const isFaq = ctx.ragType === 'faq';
				const contextIntro = isFaq
					? '\nEl cliente hace una pregunta sobre políticas, servicios o información del negocio.' +
						' El siguiente contexto contiene la información VERÍDICA Y DEFINITIVA para responder.' +
						' PROHIBIDO usar tu conocimiento general sobre la empresa (ubicación, datos de contacto, precios, etc.) ya que puede estar desactualizado o ser incorrecto:'
					: '\nEl cliente hace una pregunta sobre un producto. Usa ÚNICAMENTE el siguiente contexto de ficha técnica para responder:';
				parts.push(
					contextIntro +
						`\n\n${ctx.ragContext}` +
						'\n\nInstrucciones:' +
						(isFaq
							? '\n- CRÍTICO: el texto del FAQ es solo tu FUENTE DE INFORMACIÓN, NO un guión. NUNCA lo copies ni lo parafrasees literalmente.' +
								'\n- Reformula la respuesta con tus propias palabras, como Gema hablaría directamente en una conversación de WhatsApp.' +
								'\n- Responde solo lo que el cliente preguntó — no incluyas toda la información del FAQ si parte de ella no es relevante para la pregunta concreta.' +
								'\n- Usa frases cortas, lenguaje coloquial y tono cordial. Sin bullets ni listas a menos que el contenido lo requiera naturalmente.' +
								'\n- CIERRE: si el mensaje anterior de Gema NO terminó con una frase de disposición, añade UNA frase declarativa corta al final. Si ya hubo una en el mensaje anterior, no añadas nada. NUNCA uses una pregunta. Varía la frase — nunca repitas la misma. Ejemplos: "Quedo a la orden si necesita algo más.", "Para lo que necesite.", "Aquí estamos.", "Cuente conmigo.", "Estoy a la orden.", "Lo que necesite, con gusto.", "Cualquier consulta, a la orden."'
							: ctx.isFirstRagMention
								? '\n- Es la primera vez que mencionas este producto en la conversación. Comienza la respuesta con "Nuestro [nombre del producto]..." para presentarlo de forma natural.' +
									'\n- No hagas preguntas sobre el uso o la aplicación que el cliente quiere darle al producto. Si vas a guiar la conversación, termina con UNA SOLA pregunta orientada a la compra (ej: "¿Le interesa llevarlo?") o no hagas ninguna pregunta. PROHIBIDO hacer preguntas sobre usos, aplicaciones o características del producto.'
								: '\n- Este producto ya fue mencionado antes en la conversación. Ve directo a la respuesta.' +
									'\n- NO menciones el nombre del producto en ningún momento de la respuesta.') +
						'\n- Responde de forma concisa y natural basándote únicamente en el contexto anterior.' +
						'\n- Si la pregunta es de Sí/No (¿Contiene X? ¿Tiene Y? ¿Es Z?), responde de forma concisa incluyendo el Sí o No y elabora brevemente en base al contexto. Evita hacer listas largas de atributos que el producto no tiene.' +
						'\n- Nunca inventes datos que no estén en el contexto proporcionado.',
				);
				if (!isFaq && !ctx.isFirstRagMention) {
					parts.push(
						'\nPROHIBIDO ABSOLUTO: No añadas ninguna pregunta al final de tu respuesta — ni de compra, ni de uso, ni de seguimiento, ni de ningún tipo. Termina la respuesta exactamente cuando hayas dado la información solicitada. Si el texto generado termina con "?", elimínalo y reescribe el final sin pregunta.',
					);
				}
			} else {
				parts.push(
					'\nEl cliente hace una pregunta pero no hay información disponible en el contexto actual.' +
						'\nResponde de forma natural e indica brevemente que no cuentas con esa información específica.' +
						'\nOfrece ayuda con otro aspecto del producto o con otra consulta.' +
						'\nNUNCA digas "revise la etiqueta", "consulte la etiqueta", "contacte a nuestro equipo", "contacte al equipo" ni variantes similares. El cliente está en el chat precisamente para obtener esa información.' +
						'\nNunca inventes datos.' +
						'\nNO hagas preguntas al final. ESTO SOBREESCRIBE la regla general de guiar la conversación con preguntas.',
				);
			}
		} else if (ctx.intent === 'request_quote') {
			parts.push(
				'\nEl cliente quiere generar una cotización con lo que lleva en su pedido.' +
					'\nNecesitamos sus datos para armarla. Pídele su nombre completo y número de cédula (o documento de identidad) de forma natural.' +
					'\nEjemplo: "¡Claro! Para armarle la cotización necesito su nombre completo y su número de cédula."' +
					'\nSé breve y directa, no repitas el contenido del pedido.',
			);
		} else if (ctx.intent === 'awaiting_customer_data') {
			parts.push(
				'\nEstamos recopilando los datos del cliente para la cotización.' +
					'\nEl cliente debería haber enviado su nombre y cédula. Si falta alguno, pídelo de forma natural.' +
					'\nSi ya tenemos ambos datos, pídele su dirección y ciudad para completar la cotización.' +
					'\nSé breve y conversacional.',
			);
		} else if (ctx.intent === 'awaiting_address') {
			parts.push(
				'\nNecesitamos la dirección y ciudad del cliente para la cotización.' +
					'\nPídele su dirección de entrega y la ciudad de forma natural.' +
					'\nEjemplo: "Ahora necesito su dirección de entrega y la ciudad, por favor."' +
					'\nSé breve.',
			);
		} else if (ctx.intent === 'awaiting_city_selection') {
			if (ctx.cityCandidates && ctx.cityCandidates.length > 0) {
				const cityList = ctx.cityCandidates
					.map(c => `${c.index}. ${c.name}, ${c.region}`)
					.join('\n');
				parts.push(
					`\nEl cliente escribió una ciudad y encontramos varias coincidencias:\n${cityList}` +
						'\nPídele que elija el número de la opción correcta. Sé breve.',
				);
			}
		} else if (ctx.intent === 'existing_customer_confirmation') {
			const d = ctx.quoteFlowData;
			const cartSummary =
				ctx.cart && ctx.cart.length > 0
					? ctx.cart
							.map(item => {
								const name = item.variantName
									? `${item.productName} ${item.variantName}`
									: item.productName;
								const total = item.unitPrice
									? formatPrice(
											String(Number(item.unitPrice) * item.quantity),
											item.currency,
										)
									: '';
								return `- ${item.quantity}x ${name}${total ? ` = ${total}` : ''}`;
							})
							.join('\n')
					: '';
			const grandTotal = (ctx.cart ?? []).reduce(
				(sum, item) =>
					sum + (item.unitPrice ? Number(item.unitPrice) * item.quantity : 0),
				0,
			);
			const grandTotalFormatted =
				grandTotal > 0
					? formatPrice(String(grandTotal), ctx.cart?.[0]?.currency ?? currency)
					: '';
			parts.push(
				`\nEl cliente ya está registrado en el sistema. Llámalo por su nombre (sin apellido) (${d?.fullName ?? ''}) de forma natural y dile que ya tienes sus datos. Ejemplo: "Sr. Carlos, me aparece registrado en el sistema con estos datos:". Ten en cuenta si es hombre o mujer.` +
					`\nMuéstrale el siguiente resumen:` +
					`\nNombre: ${d?.fullName ?? ''}` +
					`\nCédula: ${d?.dni ?? ''}` +
					`\nDirección: ${d?.location ?? ''}` +
					`\nCiudad: ${d?.cityName ?? ''}` +
					(cartSummary ? `\n\nPedido:\n${cartSummary}` : '') +
					(grandTotalFormatted ? `\nTotal: ${grandTotalFormatted}` : '') +
					'\n\nPregúntale si con estos datos y este pedido procedemos a generar la cotización. Sé natural y cercano, no suenes a sistema.',
			);
		} else if (ctx.intent === 'awaiting_confirmation') {
			const d = ctx.quoteFlowData;
			const cartSummary =
				ctx.cart && ctx.cart.length > 0
					? ctx.cart
							.map(item => {
								const name = item.variantName
									? `${item.productName} ${item.variantName}`
									: item.productName;
								const total = item.unitPrice
									? formatPrice(
											String(Number(item.unitPrice) * item.quantity),
											item.currency,
										)
									: '';
								return `- ${item.quantity}x ${name}${total ? ` = ${total}` : ''}`;
							})
							.join('\n')
					: '';
			const grandTotal = (ctx.cart ?? []).reduce(
				(sum, item) =>
					sum + (item.unitPrice ? Number(item.unitPrice) * item.quantity : 0),
				0,
			);
			const grandTotalFormatted =
				grandTotal > 0
					? formatPrice(String(grandTotal), ctx.cart?.[0]?.currency ?? currency)
					: '';
			parts.push(
				`\nMuéstrale al cliente el resumen actualizado para que confirme. Usa una frase de apertura natural con su nombre (sin apellido) si parece nombre de persona. Si el nombre contiene palabras de empresa (S.A.S., SAS, Corp, Ltda, Distribuciones, Comercializadora, etc.) empieza con "Tengo esto en el sistema:". Varía las frases de apertura ("Listo [nombre]", "Perfecto [nombre], aquí está el resumen actualizado:", etc.).` +
					`\n\nIncluye literalmente en el mensaje los siguientes datos:` +
					`\nNombre: ${d?.fullName ?? ''}` +
					`\nCédula: ${d?.dni ?? ''}` +
					`\nTeléfono: ${d?.phoneNumber ?? ''}` +
					`\nDirección: ${d?.location ?? ''}` +
					`\nCiudad: ${d?.cityName ?? ''}` +
					(cartSummary ? `\n\nPedido:\n${cartSummary}` : '') +
					(grandTotalFormatted ? `\nTotal: ${grandTotalFormatted}` : '') +
					'\n\nAl final pregunta si todo está correcto para generar la cotización. Varía la frase de cierre.',
			);
		} else if (ctx.intent === 'purchase_intent') {
			parts.push(
				'\nEl cliente quiere comprar o finalizar su pedido.' +
					'\nNecesitamos sus datos para procesar la compra. Pídele su nombre completo y número de cédula de forma natural.' +
					'\nEjemplo: "¡Perfecto! Para procesar su compra necesito su nombre completo y su número de cédula."' +
					'\nSé breve y directa, no repitas el contenido del pedido.',
			);
		} else if (ctx.intent === 'existing_customer_purchase_confirmation') {
			const d = ctx.purchaseFlowData;
			const cartSummaryPurchase =
				ctx.cart && ctx.cart.length > 0
					? ctx.cart
							.map(item => {
								const name = item.variantName
									? `${item.productName} ${item.variantName}`
									: item.productName;
								const total = item.unitPrice
									? formatPrice(
											String(Number(item.unitPrice) * item.quantity),
											item.currency,
										)
									: '';
								return `- ${item.quantity}x ${name}${total ? ` = ${total}` : ''}`;
							})
							.join('\n')
					: '';
			const grandTotalPurchase = (ctx.cart ?? []).reduce(
				(sum, item) =>
					sum + (item.unitPrice ? Number(item.unitPrice) * item.quantity : 0),
				0,
			);
			const grandTotalPurchaseFormatted =
				grandTotalPurchase > 0
					? formatPrice(
							String(grandTotalPurchase),
							ctx.cart?.[0]?.currency ?? currency,
						)
					: '';
			parts.push(
				`\nEl cliente ya está registrado en el sistema. Llámalo por su nombre (sin apellido) (${d?.fullName ?? ''}) de forma natural y dile que ya tienes sus datos. Ten en cuenta si es hombre o mujer.` +
					`\nMuéstrale el siguiente resumen:` +
					`\nNombre: ${d?.fullName ?? ''}` +
					`\nCédula: ${d?.dni ?? ''}` +
					`\nDirección: ${d?.location ?? ''}` +
					`\nCiudad: ${d?.cityName ?? ''}` +
					(cartSummaryPurchase ? `\n\nPedido:\n${cartSummaryPurchase}` : '') +
					(grandTotalPurchaseFormatted
						? `\nTotal: ${grandTotalPurchaseFormatted}`
						: '') +
					'\n\nPregúntale si con estos datos y este pedido procedemos con el pago. Sé natural y cercano.',
			);
		} else if (ctx.intent === 'awaiting_purchase_confirmation') {
			const d = ctx.purchaseFlowData;
			const cartSummaryPurchase =
				ctx.cart && ctx.cart.length > 0
					? ctx.cart
							.map(item => {
								const name = item.variantName
									? `${item.productName} ${item.variantName}`
									: item.productName;
								const total = item.unitPrice
									? formatPrice(
											String(Number(item.unitPrice) * item.quantity),
											item.currency,
										)
									: '';
								return `- ${item.quantity}x ${name}${total ? ` = ${total}` : ''}`;
							})
							.join('\n')
					: '';
			const grandTotalPurchase = (ctx.cart ?? []).reduce(
				(sum, item) =>
					sum + (item.unitPrice ? Number(item.unitPrice) * item.quantity : 0),
				0,
			);
			const grandTotalPurchaseFormatted =
				grandTotalPurchase > 0
					? formatPrice(
							String(grandTotalPurchase),
							ctx.cart?.[0]?.currency ?? currency,
						)
					: '';
			parts.push(
				`\nMuéstrale al cliente el resumen actualizado para que confirme antes de generar el pago. Usa una frase de apertura natural con su nombre (sin apellido) si parece nombre de persona. Varía las frases de apertura.` +
					`\n\nIncluye literalmente en el mensaje los siguientes datos:` +
					`\nNombre: ${d?.fullName ?? ''}` +
					`\nCédula: ${d?.dni ?? ''}` +
					`\nTeléfono: ${d?.phoneNumber ?? ''}` +
					`\nDirección: ${d?.location ?? ''}` +
					`\nCiudad: ${d?.cityName ?? ''}` +
					(cartSummaryPurchase
						? `\n\nProductos:\n${cartSummaryPurchase}`
						: '') +
					(grandTotalPurchaseFormatted
						? `\nTotal: ${grandTotalPurchaseFormatted}`
						: '') +
					'\n\nAl final pregunta si todo está correcto para proceder con el pago. Varía la frase de cierre.',
			);
		} else if (ctx.intent === 'awaiting_payment_confirmation') {
			parts.push(
				'\nEl cliente ya recibió el link de pago y estamos esperando que confirme el pago.' +
					'\nRecuérdale amablemente que cuando complete el pago, nos avise para confirmar su pedido.' +
					'\nSé breve y amable.',
			);
		} else if (ctx.intent === 'awaiting_correction_unclear') {
			const d = ctx.quoteFlowData;
			parts.push(
				`\nEl cliente quiere corregir algo del resumen pero no queda claro qué. Los datos actuales son:` +
					`\nNombre: ${d?.fullName ?? ''}` +
					`\nCédula: ${d?.dni ?? ''}` +
					`\nTeléfono: ${d?.phoneNumber ?? ''}` +
					`\nDirección: ${d?.location ?? ''}` +
					`\nCiudad: ${d?.cityName ?? ''}` +
					'\n\nPide amablemente que te indique cuál dato quiere cambiar y cuál es el valor correcto. Sé breve y directo.',
			);
		} else if (ctx.intent === 'quote_created') {
			parts.push(
				`\nLa cotización fue generada exitosamente.` +
					(ctx.quoteSerialNumber
						? `\nNúmero de referencia: ${ctx.quoteSerialNumber}`
						: '') +
					'\nConfirma al cliente que su cotización fue creada.' +
					'\nDespídete de forma cálida y deja la puerta abierta para futuras consultas.',
			);
		} else {
			parts.push(
				'\nNo se encontraron productos para esta consulta. Responde de forma conversacional pidiendo más información sobre lo que busca.',
			);
		}

		parts.push(
			'\nRecuerda: responde como una persona real, evita sonar como sistema y usa una sola pregunta clara al final.',
		);

		return parts.join('\n');
	};

	/**
	 * Extrae datos estructurados del mensaje del cliente según el paso del flujo de cotización.
	 * - 'customer_data': extrae fullName y dni del texto libre.
	 * - 'address': extrae la dirección (location) y opcionalmente la ciudad.
	 */
	extractCustomerData = async (
		text: string,
		step: 'customer_data' | 'address',
	): Promise<Record<string, string | undefined>> => {
		const prompts: Record<string, string> = {
			customer_data: `Extrae del siguiente mensaje el nombre completo y el número de documento (cédula/DNI/RUC) del cliente.
Devuelve un JSON con:
- "fullName": nombre completo (capitalizado correctamente). Si no lo mencionó, null.
- "dni": número de documento tal como lo escribió. Si no lo mencionó, null.
Responde ÚNICAMENTE con el JSON.`,
			address: `Extrae del siguiente mensaje la dirección y opcionalmente la ciudad del cliente.
Devuelve un JSON con:
- "location": dirección física tal como la escribió. Si no la mencionó, null.
- "city": nombre de la ciudad si la mencionó. Si no la mencionó, null.
Responde ÚNICAMENTE con el JSON.`,
		};

		const response = await this.client.chat.completions.create({
			model: 'gpt-4o-mini',
			messages: [
				{ role: 'system', content: prompts[step] },
				{ role: 'user', content: text },
			],
			max_tokens: 150,
			temperature: 0,
			response_format: { type: 'json_object' },
		});

		const raw = response.choices[0]?.message?.content?.trim() ?? '{}';
		return JSON.parse(raw) as Record<string, string | undefined>;
	};

	/**
	 * Detects which quote data field(s) the customer wants to correct and extracts the new value(s).
	 */
	extractQuoteCorrection = async (
		text: string,
		currentData: Record<string, unknown>,
	): Promise<QuoteCorrectionResult> => {
		const prompt = `El cliente está revisando un resumen de su pedido/cotización con estos datos:
- Nombre: ${currentData.fullName ?? 'no proporcionado'}
- Cédula: ${currentData.dni ?? 'no proporcionado'}
- Teléfono: ${currentData.phoneNumber ?? 'no proporcionado'}
- Dirección: ${currentData.location ?? 'no proporcionado'}
- Ciudad: ${currentData.cityName ?? 'no proporcionado'}

El cliente puede querer:
  A) CORREGIR datos personales (nombre, cédula, teléfono, dirección o ciudad)
  B) AGREGAR productos que faltaron en el pedido

Analiza su mensaje y devuelve un JSON con SOLO los campos relevantes:
- "fullName": nuevo nombre completo (capitalizado). Solo si quiere cambiar el nombre.
- "dni": nuevo número de documento. Solo si quiere cambiar la cédula/DNI.
- "phoneNumber": nuevo teléfono (solo dígitos, sin código de país). Solo si quiere cambiar el teléfono.
- "location": nueva dirección. Solo si quiere cambiar la dirección.
- "city": nueva ciudad. Solo si quiere cambiar la ciudad.
- "productsToAdd": si el cliente dice que faltó algo, que quiere agregar algo, o menciona productos que no estaban en el resumen. Array de objetos {productHint, quantity, variantHint?, unit?}. "quantity" es un entero; si no se especifica cantidad, usa 1. "variantHint" es la presentación (ej: "20 ml", "100 gramos"). "unit" solo si la cantidad está en peso (kilos, kg, gramos). Ej: "Faltaron las fragancias de chicle" → productsToAdd: [{"productHint":"fragancia chicle","quantity":1}]. "Faltaron 5 fragancias de chicle de 20 ml" → productsToAdd: [{"productHint":"fragancia chicle","quantity":5,"variantHint":"20 ml"}].

Si el mensaje contiene un número largo (6-12 dígitos) sin contexto claro, probablemente es una corrección de cédula.
Si no puedes determinar qué quiere corregir ni agregar, devuelve un JSON vacío {}.
Responde ÚNICAMENTE con el JSON.`;

		const response = await this.client.chat.completions.create({
			model: 'gpt-4o-mini',
			messages: [
				{ role: 'system', content: prompt },
				{ role: 'user', content: text },
			],
			max_tokens: 400,
			temperature: 0,
			response_format: { type: 'json_object' },
		});

		const raw = response.choices[0]?.message?.content?.trim() ?? '{}';
		const parsed = JSON.parse(raw) as QuoteCorrectionResult;
		// Validate productsToAdd is a proper array
		if (!Array.isArray(parsed.productsToAdd)) {
			parsed.productsToAdd = undefined;
		}
		return parsed;
	};
}
