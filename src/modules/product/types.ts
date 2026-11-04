import { PartialStockItem } from '../stock-item/types';
import { VariantAxesDto } from '../product-variant/types';

/**
 * Lo que el formulario manda por cada presentación. `name` sigue aceptándose
 * para las que todavía no están estructuradas; con `axes`, el nombre se compone
 * y lo que venga en `name` se ignora
 */
type ProductVariantPayload = PartialStockItem & {
	name?: string;
	axes?: VariantAxesDto;
};

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
	productVariants: ProductVariantPayload[];
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
		name?: string;
		active: boolean;
		axes?: VariantAxesDto;
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
		// Los ejes, con las etiquetas ya resueltas para no pedir el catálogo al
		// pintar la tabla. Todo en null mientras la presentación no esté estructurada
		quantityValue: number | null;
		unitId: string | null;
		unitCode: string | null;
		unitLabel: string | null;
		containerId: string | null;
		containerLabel: string | null;
		isCapacity: boolean;
		quantityBase: number | null;
		attributes: {
			attributeTypeId: string;
			code: string;
			label: string;
			value: string;
		}[];
		// Las bodegas donde está activa, y en cuántas existe en total
		stockIds: string[];
		stocksCount: number;
	}[];
}

export interface AddProductVariantDto {
	productId: string;
	productVariant: ProductVariantPayload;
	stocks: { id: string; currency: 'COP' | 'USD' }[];
	requestedBy: string;
}
