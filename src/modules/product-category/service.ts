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
					include: [
						[sequelize.col('productCategoryGroup.name'), 'groupName'],
						// Para que el aviso de borrado diga cuántos productos tiene en vez
						// de dejar al usuario confirmar y recibir un error
						[
							sequelize.literal(`(
								SELECT COUNT(*)::int
								FROM product p
								WHERE p."productCategoryId" = "ProductCategoryModel".id
									AND p."deletedDate" IS NULL
							)`),
							'productsCount',
						],
					],
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

		// El conteo va también aquí: si faltara, la tabla se quedaría sin él tras
		// crear o editar y el aviso de borrado diría que la categoría está vacía
		const productsCount = await this.productModel.count({
			where: { productCategoryId: productCategory.getDataValue('id') },
		});

		return {
			...productCategory.dataValues,
			groupName: group?.getDataValue('name') ?? null,
			productsCount,
		};
	};

	delete = async (id: string) => {
		const transaction = await sequelize.transaction();
		try {
			const productsCount = await this.productModel.count({
				where: { productCategoryId: id },
				transaction,
			});

			if (productsCount > 0) {
				await transaction.rollback();

				return {
					success: false,
					message:
						'No se puede eliminar la categoría, porque tiene productos asociados',
				};
			}

			const productCategoryToDelete = await this.productCategoryModel.findByPk(
				id,
				{ transaction },
			);

			if (!productCategoryToDelete) {
				await transaction.rollback();

				return {
					success: false,
					message: 'No se encontró la categoría que intentas eliminar',
				};
			}

			// Los productos borrados siguen referenciando su categoría, así que
			// mientras quede alguna fila la categoría solo se marca como borrada
			const remainingProducts = await this.productModel.count({
				where: { productCategoryId: id },
				paranoid: false,
				transaction,
			});

			await productCategoryToDelete.destroy({
				force: remainingProducts === 0,
				transaction,
			});

			/**
			 * Se vuelve a contar después de borrar, no antes: un producto creado
			 * entre el primer conteo y el borrado seguiría vivo apuntando a una
			 * categoría marcada como borrada. Contar aquí sí lo ve, porque la
			 * inserción ya está confirmada, y entonces se deshace todo
			 */
			const productsAfter = await this.productModel.count({
				where: { productCategoryId: id },
				transaction,
			});

			if (productsAfter > 0) {
				await transaction.rollback();

				return {
					success: false,
					message:
						'No se puede eliminar la categoría, porque tiene productos asociados',
				};
			}

			await transaction.commit();

			return {
				success: true,
				message: 'La categoría de producto fue eliminada con éxito',
			};
		} catch (error) {
			await transaction.rollback();
			console.error('ServiceError eliminando categoría de producto: ', error);
			throw error;
		}
	};
}
