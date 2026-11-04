import { PendingTransfer } from '../transaction/types';

export interface ProductVariantAttr {
	id?: string;
	name: string;
	quantity: number;
	productId: string;
	vId?: string;
	createdBy: string;
	updatedBy: string;
	createdDate?: Date;
	updatedDate?: Date;
	deletedDate?: Date | null;
}

/**
 * `name` y `axes` son excluyentes en la práctica: con `axes` el nombre se
 * compone de los ejes y lo que venga en `name` se ignora. `name` sigue
 * aceptándose porque las 944 presentaciones de hoy no están estructuradas y
 * hasta el backfill del punto 5 se tienen que poder editar por su nombre
 */
export interface CreateProductVariantDto {
	name?: string;
	productId: string;
	axes?: VariantAxesDto;
	requestedBy: string;
}

export interface UpdateProductVariantDto {
	id: string;
	name?: string;
	active: boolean;
	stockIds?: string[];
	axes?: VariantAxesDto;
	requestedBy: string;
}

/**
 * `blocked` es inventario vivo: no se borra de ninguna forma. `logical` guarda
 * la fila porque hay documentos que la referencian, y `physical` la quita
 */
export interface ProductVariantDeletionPlan {
	mode: 'physical' | 'logical' | 'blocked';
	/**
	 * El motivo redactado, o null si no está bloqueado. `mode === 'blocked'` es
	 * exactamente `blockedMessage !== null`: un solo dato decide las dos cosas,
	 * así que no hay forma de que queden en desacuerdo.
	 *
	 * Lo redacta el backend porque el mismo texto lo muestra el modal antes de
	 * confirmar y lo lanza el borrado si se confirma de todas formas
	 */
	blockedMessage: string | null;
	/**
	 * Todas las filas que referencian la presentación, incluidas las de facturas
	 * anuladas o borradas: son las que deciden si el borrado puede ser físico.
	 * Los tres conteos de abajo son solo de documentos vivos, que es lo que se le
	 * muestra al usuario, y pueden sumar menos que esto
	 */
	historyRows: number;
	billingItems: number;
	quoteItems: number;
	transactionItems: number;
	stocksWithUnits: { name: string; quantity: number }[];
	/**
	 * Transferencias creadas y sin aceptar. Sus unidades no están en ninguna
	 * bodega, así que `stocksWithUnits` no las ve: van aparte
	 */
	pendingTransfers: PendingTransfer[];
}

export type MeasurementDimension = 'mass' | 'volume' | 'count' | 'length';

export interface VariantUnit {
	id: string;
	code: string;
	label: string;
	name: string;
	dimension: MeasurementDimension;
	// DECIMAL: `pg` lo devuelve como string, y la composición lo convierte
	factorToBase: string | number;
}

export interface VariantContainer {
	id: string;
	code: string;
	label: string;
}

export interface VariantAttributeType {
	id: string;
	code: string;
	label: string;
	valueTemplate: string;
	sortOrder: number;
}

export interface VariantAttributeInput {
	type: VariantAttributeType;
	value: string;
}

/**
 * Los ejes resueltos, con las filas de catálogo ya cargadas. Es lo que recibe la
 * composición, que es pura y no consulta nada
 */
export interface VariantAxes {
	quantityValue?: number | null;
	unit?: VariantUnit | null;
	isCapacity?: boolean;
	container?: VariantContainer | null;
	attributes?: VariantAttributeInput[];
}

/**
 * Lo que llega del formulario: identificadores, no filas. El servicio los
 * resuelve contra el catálogo antes de componer, y así un id inventado se
 * rechaza en vez de producir un nombre a medias
 */
export interface VariantAxesDto {
	quantityValue?: number | null;
	unitId?: string | null;
	isCapacity?: boolean;
	containerId?: string | null;
	attributes?: { attributeTypeId: string; value: string }[];
}

export interface VariantCatalog {
	units: VariantUnit[];
	containers: VariantContainer[];
	attributeTypes: VariantAttributeType[];
}

export interface ProductVariantFilters {
	vId?: string;
	productName?: string;
	variantName?: string;
	productDescription?: string;
	productCategoryName?: string;
	showActiveOnly?: boolean | null; // null: activas e inactivas
}
