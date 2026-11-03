import { PartialStockItem } from '../stock-item/types';

export interface ProductAttr {
	id?: string;
	name: string;
	description?: string | null;
	pId?: string;
	productCategoryId: string;
	createdBy: string;
	updatedBy: string;
	createdDate?: Date;
	updatedDate?: Date;
	deletedDate?: Date | null;
}

export interface CreateProductDto {
	productData: Partial<ProductAttr>;
	productVariants: (PartialStockItem & { name: string })[];
	stocks: { id: string; currency: 'COP' | 'USD' }[];
	requestedBy: string;
}

export interface UpdateProductDto {
	id: string;
	productData: Partial<ProductAttr>;
	/**
	 * Opcionales: editar el producto y editar una presentación son dos acciones
	 * distintas desde que el modal está separado. Antes llegaban siempre juntas y
	 * el nombre del producto viajaba como nombre de la presentación
	 */
	productVariantData?: {
		id: string;
		name: string;
		active: boolean;
	};
	stockIds?: string[];
	requestedBy: string;
}

export interface ProductFilters {
	pId?: string;
	name?: string;
	description?: string;
	productCategoryName?: string;
}

export interface ProductWithVariants {
	id: string;
	pId: string;
	name: string;
	description: string | null;
	productCategoryId: string;
	productCategoryName: string;
	variantsCount: number;
	productVariants: {
		id: string;
		vId: string;
		name: string;
		active: boolean;
		productId: string;
		// Las bodegas donde está activa, y en cuántas existe en total
		stockIds: string[];
		stocksCount: number;
	}[];
}

export interface AddProductVariantDto {
	productId: string;
	productVariant: PartialStockItem & { name: string };
	stocks: { id: string; currency: 'COP' | 'USD' }[];
	requestedBy: string;
}
