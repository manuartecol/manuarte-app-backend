import { ProductModel } from './model';
import { ProductCategoryModel } from '../product-category/model';
import { ProductVariantService } from '../product-variant/service';
import { ProductVariantModel } from '../product-variant/model';
import {
	AddProductVariantDto,
	CreateProductDto,
	UpdateProductDto,
} from './types';
import { StockItemService } from '../stock-item/service';
import { StockItemModel } from '../stock-item/model';
import { sequelize } from '../../config/database';

export class ProductService {
	private productModel;
	private productCategoryModel;
	private productVariantService;
	private stockItemService;

	constructor(productModel: typeof ProductModel) {
		this.productModel = productModel;
		this.productCategoryModel = ProductCategoryModel;
		this.productVariantService = new ProductVariantService(ProductVariantModel);
		this.stockItemService = new StockItemService(StockItemModel);
	}

	getAll = async () => {
		try {
			const products = await this.productModel.findAll({
				attributes: ['id', 'name'],
				order: [['name', 'ASC']],
			});

			return products;
		} catch (error) {
			console.error('ServiceError obteniendo productos: ', error);
			throw error;
		}
	};

	create = async ({
		productData,
		productVariants,
		stocks,
		requestedBy,
	}: CreateProductDto) => {
		const transaction = await sequelize.transaction();
		try {
			const newProduct = this.productModel.build({
				...productData,
				createdBy: requestedBy,
				updatedBy: requestedBy,
			});

			await newProduct.generatePId();
			await newProduct.save({ transaction });

			const newProductVariants = [];
			if (productVariants?.length > 0) {
				for (const pv of productVariants) {
					const { name, ...stockItemData } = pv;

					const newProductVariant = await this.productVariantService.create(
						{
							name,
							productId: newProduct.id,
							requestedBy,
						},
						transaction,
					);
					newProductVariants.push(newProductVariant);

					if (stocks?.length > 0) {
						await this.stockItemService.createInMultipleStocks(
							newProductVariant.id,
							stockItemData,
							stocks,
							transaction,
						);
					}
				}
			}

			const categoryName = await this.getCategoryName(
				newProduct?.productCategoryId,
			);

			await transaction.commit();

			return {
				...newProduct.dataValues,
				productCategoryName: categoryName,
				productVariants: newProductVariants,
			};
		} catch (error) {
			await transaction.rollback();
			console.error('ServiceError creando producto: ', error);
			throw error;
		}
	};

	update = async ({
		id,
		productData,
		productVariantData,
		stockIds,
		requestedBy,
	}: UpdateProductDto) => {
		// Producto y presentación en una sola transacción: antes, si la
		// presentación fallaba (nombre repetido, stock que no se puede desactivar),
		// el producto quedaba guardado a medias
		const transaction = await sequelize.transaction();
		try {
			const productToUpdate = await this.productModel.findByPk(id, {
				transaction,
			});
			if (!productToUpdate)
				throw new Error(`No fue posible encontrar el producto`);

			await productToUpdate.update(
				{
					...productData,
					updatedBy: requestedBy,
				},
				{ transaction },
			);

			const updatedProductVariant = await this.productVariantService.update(
				{
					id: productVariantData.id,
					name: productVariantData.name,
					active: productVariantData.active,
					stockIds,
					requestedBy,
				},
				transaction,
			);

			await transaction.commit();

			const categoryName = await this.getCategoryName(
				productToUpdate?.productCategoryId,
			);

			return {
				...productToUpdate.dataValues,
				productCategoryName: categoryName,
				productVariant: updatedProductVariant,
			};
		} catch (error) {
			await transaction.rollback();
			console.error('ServiceError actualizando producto: ', error);
			throw error;
		}
	};

	addVariant = async ({
		productId,
		productVariant,
		stocks,
		requestedBy,
	}: AddProductVariantDto) => {
		const transaction = await sequelize.transaction();
		try {
			const { name, ...pvRest } = productVariant;

			const newProductVariant = await this.productVariantService.create(
				{
					name,
					productId,
					requestedBy,
				},
				transaction,
			);

			if (stocks?.length > 0) {
				await this.stockItemService.createInMultipleStocks(
					newProductVariant.id,
					pvRest,
					stocks,
					transaction,
				);
			}

			const product = await this.productModel.findByPk(productId);
			let productCategoryName;
			if (product) {
				productCategoryName = await this.getCategoryName(
					product?.productCategoryId,
				);
			}

			await transaction.commit();

			return {
				...newProductVariant,
				productId,
				productName: product?.name,
				productDescription: product?.description,
				productCategoryId: product?.productCategoryId,
				productCategoryName,
			};
		} catch (error) {
			await transaction.rollback();
			console.error('ServiceError agregando presentación de producto: ', error);
			throw error;
		}
	};

	delete = async (productId: string, productVariantId: string) => {
		try {
			const productVariantDeleted =
				await this.productVariantService.delete(productVariantId);

			const count = await this.productVariantService.count(productId);

			let productDeleted = 0;
			if (count === 0) {
				productDeleted = await this.productModel.destroy({
					where: { id: productId },
				});

				return { productVariantDeleted, productDeleted };
			}

			return { productVariantDeleted, productDeleted };
		} catch (error) {
			console.error('ServiceError eliminando producto: ', error);
			throw error;
		}
	};

	count = async (productCategoryId: string) => {
		try {
			const productsCount = await this.productModel.count({
				where: { productCategoryId },
			});

			return productsCount;
		} catch (error) {
			console.error('ServiceError en el conteo de productos: ', error);
			throw error;
		}
	};

	getCategoryName = async (id: string) => {
		try {
			const category = await this.productCategoryModel.findByPk(id, {
				attributes: ['name'],
			});

			if (!category) throw new Error('Categoría no encontrada');

			return category.name;
		} catch (error) {
			console.error(
				'ServiceError obteniendo nombre de la categoría de producto: ',
				error,
			);
			throw new Error('Error interno del servidor');
		}
	};
}
