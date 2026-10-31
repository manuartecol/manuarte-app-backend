import { sequelize } from '../../config/database';
import { ProductCategoryGroupModel } from '../product-category-group/model';
import { ProductModel } from '../product/model';
import { ProductCategoryModel } from './model';
import { CreateProductCategoryDto, UpdateProductCategoryDto } from './types';

export class ProductCategoryService {
	private productCategoryModel;
	private productModel;

	constructor(productCategoryModel: typeof ProductCategoryModel) {
		this.productCategoryModel = productCategoryModel;
		this.productModel = ProductModel;
	}

	getAll = async () => {
		try {
			const categories = await this.productCategoryModel.findAll({
				attributes: {
					include: [[sequelize.col('productCategoryGroup.name'), 'groupName']],
				},
				include: [
					{
						model: ProductCategoryGroupModel,
						as: 'productCategoryGroup',
						attributes: [],
					},
				],
				order: [['cId', 'ASC']],
			});

			return categories;
		} catch (error) {
			console.error('ServiceError obteniendo categorías de producto: ', error);
			throw error;
		}
	};

	getGroups = async () => {
		try {
			return await ProductCategoryGroupModel.findAll({
				attributes: ['id', 'name'],
				where: { deletedDate: null },
				order: [['name', 'ASC']],
			});
		} catch (error) {
			console.error('ServiceError obteniendo grupos de categoría: ', error);
			throw error;
		}
	};

	create = async ({
		name,
		productCategoryGroupId,
		requestedBy,
	}: CreateProductCategoryDto) => {
		try {
			const newProductCategory = this.productCategoryModel.build({
				name,
				productCategoryGroupId: productCategoryGroupId ?? null,
				createdBy: requestedBy,
				updatedBy: requestedBy,
			});

			await newProductCategory.generateCId();

			await newProductCategory.save();

			return await this.withGroupName(newProductCategory);
		} catch (error) {
			console.error('ServiceError creando categoría de producto: ', error);
			throw error;
		}
	};

	update = async ({
		id,
		name,
		productCategoryGroupId,
		requestedBy,
	}: UpdateProductCategoryDto) => {
		try {
			const productCategoryToUpdate =
				await this.productCategoryModel.findByPk(id);
			if (!productCategoryToUpdate) {
				throw new Error(
					`No se encontró la categoría del producto con id ${id}`,
				);
			}

			await productCategoryToUpdate.update({
				name,
				productCategoryGroupId,
				updatedBy: requestedBy,
			});

			return await this.withGroupName(productCategoryToUpdate);
		} catch (error) {
			console.error('ServiceError actualizando categoría de producto: ', error);
			throw error;
		}
	};

	// Misma forma que `getAll`, para que la tabla pinte el grupo sin recargar
	private withGroupName = async (productCategory: ProductCategoryModel) => {
		const groupId = productCategory.getDataValue('productCategoryGroupId');
		const group = groupId
			? await ProductCategoryGroupModel.findByPk(groupId, {
					attributes: ['name'],
				})
			: null;

		return {
			...productCategory.dataValues,
			groupName: group?.getDataValue('name') ?? null,
		};
	};

	delete = async (id: string) => {
		try {
			const productsCount = await this.productModel.count({
				where: { productCategoryId: id },
			});

			if (productsCount > 0) {
				return {
					success: false,
					message:
						'No se puede eliminar la categoría, porque tiene productos asociados',
				};
			}

			await this.productCategoryModel.destroy({
				where: { id },
			});

			return {
				success: true,
				message: 'La categoría de producto fue eliminada con éxito',
			};
		} catch (error) {
			console.error('ServiceError eliminando categoría de producto: ', error);
			throw error;
		}
	};
}
