import { QueryTypes } from 'sequelize';
import { normalizeSearch } from '../product-variant/helpers/search';
import { ProductModel } from './model';
import { ProductCategoryModel } from '../product-category/model';
import { ProductVariantService } from '../product-variant/service';
import { ProductVariantModel } from '../product-variant/model';
import {
	AddProductVariantDto,
	CreateProductDto,
	ProductFilters,
	ProductWithVariants,
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
				// `productCategoryId` para el formulario de agregar presentación: de
				// la categoría depende si el campo de medida se llama Cantidad o
				// Capacidad, y eligiendo el producto en el select no había forma de
				// saberlo, así que el mismo producto decía una cosa u otra según por
				// dónde se hubiera abierto el modal
				attributes: ['id', 'name', 'productCategoryId'],
				order: [['name', 'ASC']],
			});

			return products;
		} catch (error) {
			console.error('ServiceError obteniendo productos: ', error);
			throw error;
		}
	};

	/**
	 * El producto con sus presentaciones anidadas, paginando por producto y no
	 * por presentación. Va en SQL y no en un include de Sequelize porque con
	 * `limit` sobre un `hasMany` hay que elegir entre paginar mal o traer el
	 * catálogo entero, y porque cada presentación necesita su array de bodegas,
	 * que es una subconsulta propia
	 */
	getAllWithVariants = async (
		page: number = 1,
		pageSize: number = 30,
		filters: ProductFilters = {},
	) => {
		try {
			const conditions: string[] = ['p."deletedDate" IS NULL'];
			const replacements: Record<string, unknown> = {};

			if (filters.pId) {
				conditions.push('p."pId" ILIKE :pId');
				replacements.pId = `%${filters.pId}%`;
			}
			if (filters.name) {
				conditions.push('unaccent(lower(p.name)) LIKE :name');
				replacements.name = `%${normalizeSearch(filters.name)}%`;
			}
			if (filters.description) {
				conditions.push('unaccent(lower(p.description)) LIKE :description');
				replacements.description = `%${normalizeSearch(filters.description)}%`;
			}
			if (filters.productCategoryName) {
				conditions.push('unaccent(lower(pc.name)) LIKE :productCategoryName');
				replacements.productCategoryName = `%${normalizeSearch(filters.productCategoryName)}%`;
			}

			const where = conditions.join('\n\t\t\t\t\t\tAND ');

			const [{ total }] = await sequelize.query<{ total: string }>(
				`
					SELECT COUNT(*) AS total
					FROM product p
					INNER JOIN product_category pc ON pc.id = p."productCategoryId"
					WHERE ${where}
				`,
				{ replacements, type: QueryTypes.SELECT },
			);

			const products = await sequelize.query<ProductWithVariants>(
				`
					SELECT
						p.id,
						p."pId",
						p.name,
						p.description,
						p."productCategoryId",
						pc.name AS "productCategoryName",
						COALESCE(v.total, 0) AS "variantsCount",
						COALESCE(v.variants, '[]'::json) AS "productVariants"
					FROM product p
					INNER JOIN product_category pc ON pc.id = p."productCategoryId"
					LEFT JOIN LATERAL (
						SELECT COUNT(*) AS total,
								json_agg(
									x ORDER BY x."quantityBase" ASC NULLS LAST, x.name ASC
								) AS variants
						FROM (
							SELECT
								pv.id,
								pv."vId",
								pv.name,
								pv.active,
								pv."productId",
								pv."quantityValue"::float8 AS "quantityValue",
								pv."unitId",
								pv."containerId",
								pv."isCapacity",
								pv."quantityBase"::float8 AS "quantityBase",
								mu.code AS "unitCode",
								mu.label AS "unitLabel",
								c.label AS "containerLabel",
								/**
								 * Los atributos salen agregados aquí y no en una consulta
								 * aparte: esta ya es SQL cruda y la tabla hija cuelga de la
								 * presentación, no de la página, así que no afecta al LIMIT
								 */
								COALESCE((
									SELECT json_agg(
										json_build_object(
											'attributeTypeId', at.id,
											'code', at.code,
											'label', at.label,
											'value', pva.value
										) ORDER BY at."sortOrder"
									)
									FROM product_variant_attribute pva
									INNER JOIN attribute_type at ON at.id = pva."attributeTypeId"
									WHERE pva."productVariantId" = pv.id
								), '[]'::json) AS attributes,
								COALESCE((
									SELECT array_agg(DISTINCT si."stockId")
									FROM stock_item_product_variant sipv
									INNER JOIN stock_item si ON si.id = sipv."stockItemId"
									WHERE sipv."productVariantId" = pv.id
										AND si.active = true
								), '{}') AS "stockIds",
								(
									SELECT COUNT(DISTINCT si."stockId")
									FROM stock_item_product_variant sipv
									INNER JOIN stock_item si ON si.id = sipv."stockItemId"
									WHERE sipv."productVariantId" = pv.id
								) AS "stocksCount"
							FROM product_variant pv
							LEFT JOIN measurement_unit mu ON mu.id = pv."unitId"
							LEFT JOIN container c ON c.id = pv."containerId"
							WHERE pv."productId" = p.id
								AND pv."deletedDate" IS NULL
						) x
					) v ON true
					WHERE ${where}
					ORDER BY p.name ASC
					LIMIT :limit OFFSET :offset
				`,
				{
					replacements: {
						...replacements,
						limit: pageSize,
						offset: (page - 1) * pageSize,
					},
					type: QueryTypes.SELECT,
				},
			);

			return {
				products: products.map(product => ({
					...product,
					variantsCount: Number(product.variantsCount),
				})),
				total: Number(total),
				page,
				pageSize,
				totalPages: Math.ceil(Number(total) / pageSize),
			};
		} catch (error) {
			console.error(
				'ServiceError obteniendo productos con sus presentaciones: ',
				error,
			);
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
					const { name, axes, ...stockItemData } = pv;

					const newProductVariant = await this.productVariantService.create(
						{
							name,
							axes,
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

			// Solo si llega: editar el producto no toca ninguna presentación
			const updatedProductVariant = productVariantData
				? await this.productVariantService.update(
						{
							id: productVariantData.id,
							name: productVariantData.name,
							active: productVariantData.active,
							axes: productVariantData.axes,
							stockIds,
							requestedBy,
						},
						transaction,
					)
				: undefined;

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
			const { name, axes, ...pvRest } = productVariant;

			const newProductVariant = await this.productVariantService.create(
				{
					name,
					axes,
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

	/**
	 * Lo que el panel muestra antes de confirmar un borrado. Sale del mismo
	 * cálculo que `delete`, para que el aviso no pueda contradecir lo que ocurre
	 * después
	 */
	getDeletionPreview = async (productId: string, productVariantId: string) => {
		try {
			await this.productVariantService.assertBelongsToProduct(
				productVariantId,
				productId,
			);

			const plan =
				await this.productVariantService.getDeletionPlan(productVariantId);

			const liveVariants = await this.productVariantService.count(productId);

			return {
				...plan,
				deletesProduct: plan.mode !== 'blocked' && liveVariants <= 1,
			};
		} catch (error) {
			console.error('ServiceError calculando el borrado del producto: ', error);
			throw error;
		}
	};

	delete = async (productId: string, productVariantId: string) => {
		// Presentación y producto en la misma transacción: si el producto falla, la
		// presentación no puede quedarse borrada por su cuenta
		const transaction = await sequelize.transaction();
		try {
			await this.productVariantService.assertBelongsToProduct(
				productVariantId,
				productId,
				transaction,
			);

			const { mode } = await this.productVariantService.delete(
				productVariantId,
				transaction,
			);

			const liveVariants = await this.productVariantService.count(
				productId,
				transaction,
			);

			let productDeleted = false;

			if (liveVariants === 0) {
				const productToDelete = await this.productModel.findByPk(productId, {
					transaction,
				});

				if (productToDelete) {
					/**
					 * Solo se borra de verdad si no le queda ninguna fila de
					 * presentación, ni siquiera marcada como borrada: esas filas
					 * referencian el producto y se quedarían huérfanas
					 */
					const remainingRows = await this.productVariantService.count(
						productId,
						transaction,
						true,
					);

					await productToDelete.destroy({
						force: remainingRows === 0,
						transaction,
					});

					productDeleted = true;
				}
			}

			await transaction.commit();

			return { productDeleted, mode };
		} catch (error) {
			await transaction.rollback();
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
