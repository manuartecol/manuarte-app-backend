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
	productVariantData: {
		id: string;
		name: string;
		active: boolean;
	};
	stockIds: string[];
	requestedBy: string;
}

export interface AddProductVariantDto {
	productId: string;
	productVariant: PartialStockItem & { name: string };
	stocks: { id: string; currency: 'COP' | 'USD' }[];
	requestedBy: string;
}
