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

export interface CreateProductVariantDto {
	name: string;
	productId: string;
	requestedBy: string;
}

export interface UpdateProductVariantDto {
	id: string;
	name: string;
	active: boolean;
	stockIds?: string[];
	requestedBy: string;
}

/**
 * `blocked` es inventario vivo: no se borra de ninguna forma. `logical` guarda
 * la fila porque hay documentos que la referencian, y `physical` la quita
 */
export interface ProductVariantDeletionPlan {
	mode: 'physical' | 'logical' | 'blocked';
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
}

export interface ProductVariantFilters {
	vId?: string;
	productName?: string;
	variantName?: string;
	productDescription?: string;
	productCategoryName?: string;
	showActiveOnly?: boolean | null; // null: activas e inactivas
}
