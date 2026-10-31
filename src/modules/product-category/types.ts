export interface ProductCategoryAttr {
	id?: string;
	name: string;
	cId?: string;
	createdBy: string;
	updatedBy: string;
	createdDate?: Date;
	updatedDate?: Date;
	deletedDate?: Date | null;
}

export interface CreateProductCategoryDto {
	name: string;
	// null quita el grupo; undefined lo deja como está
	productCategoryGroupId?: string | null;
	requestedBy: string;
}

export interface UpdateProductCategoryDto extends CreateProductCategoryDto {
	id: string;
}
