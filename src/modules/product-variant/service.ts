import { sequelize } from '../../config/database';
import { ProductCategoryModel } from '../product-category/model';
import { ProductModel } from '../product/model';
import { StockItemModel } from '../stock-item/model';
import { StockItemService } from '../stock-item/service';
import { ProductVariantModel } from './model';
import {
	CreateProductVariantDto,
	ProductVariantFilters,
	UpdateProductVariantDto,
} from './types';
import { Op, Transaction } from 'sequelize';

export class ProductVariantService {
	private productVariantModel;
	private productModel;
	private productCategoryModel;
	private stockItemService;

	constructor(productVariantModel: typeof ProductVariantModel) {
		this.productVariantModel = productVariantModel;
		this.productModel = ProductModel;
		this.productCategoryModel = ProductCategoryModel;
		this.stockItemService = new StockItemService(StockItemModel);
	}

	getAll = async (
		page: number = 1,
		pageSize: number = 30,
		filters: ProductVariantFilters = {},
	) => {
		try {
			const offset = (page - 1) * pageSize;

			const productVariantWhere: Record<string, unknown> = {};
			if (filters.vId) {
				productVariantWhere.vId = { [Op.iLike]: `%${filters.vId}%` };
			}
			if (filters.variantName) {
				productVariantWhere.name = { [Op.iLike]: `%${filters.variantName}%` };
			}

			const productWhere: Record<string, unknown> = { deletedDate: null };
			if (filters.productName) {
				productWhere.name = { [Op.iLike]: `%${filters.productName}%` };
			}
			if (filters.productDescription) {
				productWhere.description = {
					[Op.iLike]: `%${filters.productDescription}%`,
				};
			}

			const productCategoryWhere: Record<string, unknown> = {};
			if (filters.productCategoryName) {
				productCategoryWhere.name = {
					[Op.iLike]: `%${filters.productCategoryName}%`,
				};
			}

			const { rows: productVariants, count: total } =
				await this.productVariantModel.findAndCountAll({
					where: {
						active: filters?.showActiveOnly ?? true,
						...productVariantWhere,
					},
					attributes: {
						include: [
							[sequelize.col('product.name'), 'productName'],
							[sequelize.col('product.description'), 'productDescription'],
							[sequelize.col('product.productCategoryId'), 'productCategoryId'],
							[
								sequelize.col('product.productCategory.name'),
								'productCategoryName',
							],
							// Array de stockIds donde existe el producto y está activo
							[
								sequelize.literal(`(
                                SELECT COALESCE(array_agg(DISTINCT si."stockId"), '{}')
                                FROM stock_item_product_variant sipv
                                INNER JOIN stock_item si ON si.id = sipv."stockItemId"
                                WHERE sipv."productVariantId" = "ProductVariantModel"."id"
																AND si.active = true
                            )`),
								'stockIds',
							],
						],
					},
					include: [
						{
							model: this.productModel,
							as: 'product',
							attributes: [],
							where: Object.keys(productWhere).length
								? productWhere
								: undefined,
							include: [
								{
									model: this.productCategoryModel,
									as: 'productCategory',
									required: true,
									attributes: [],
									where: Object.keys(productCategoryWhere).length
										? productCategoryWhere
										: undefined,
								},
							],
						},
					],
					order: [['productName', 'ASC']],
					limit: pageSize,
					offset,
				});

			return {
				productVariants,
				total,
				page,
				pageSize,
				totalPages: Math.ceil(total / pageSize),
			};
		} catch (error) {
			console.error(
				'ServiceError obteniendo presentaciones de productos: ',
				error,
			);
			throw error;
		}
	};

	create = async (
		{ name, productId, requestedBy }: CreateProductVariantDto,
		transaction: Transaction,
	) => {
		try {
			const newProductVariant = this.productVariantModel.build({
				name,
				productId,
				createdBy: requestedBy,
				updatedBy: requestedBy,
			});

			await newProductVariant.generateVId(transaction);
			await newProductVariant.save({ transaction });

			return newProductVariant.dataValues;
		} catch (error) {
			console.error('ServiceError creando presentación de producto: ', error);
			throw error;
		}
	};

	update = async ({
		id,
		name,
		active,
		stockIds,
		requestedBy,
	}: UpdateProductVariantDto) => {
		try {
			const productVariantToUpdate =
				await this.productVariantModel.findByPk(id);
			if (!productVariantToUpdate) {
				throw new Error(
					`No se encontró la presentación de producto con id ${id}`,
				);
			}

			await productVariantToUpdate.update({
				name,
				active,
				updatedBy: requestedBy,
			});

			if (stockIds) {
				await this.stockItemService.setActiveStocks(id, stockIds as string[]);
			}

			return productVariantToUpdate.dataValues;
		} catch (error) {
			console.error(
				'ServiceError actualizando presentación de producto: ',
				error,
			);
			throw error;
		}
	};

	delete = async (productVariantId: string) => {
		try {
			const productVariantToDelete =
				await this.productVariantModel.findByPk(productVariantId);
			if (!productVariantToDelete)
				throw new Error(
					'No se encontró la presentación del producto que intentas eliminar',
				);

			await productVariantToDelete.destroy();

			return productVariantToDelete;
		} catch (error) {
			console.error(
				'ServiceError eliminando presentación del producto: ',
				error,
			);
			throw error;
		}
	};

	searchByNameOrCode = async (
		stockId: string,
		search: string,
		missingProducts: boolean,
		includeInactive = false,
	) => {
		try {
			const productVariants = missingProducts
				? await this.getMissing(search, stockId)
				: await this.getWithStockInfo(search, stockId, includeInactive);

			return { status: 200, productVariants };
		} catch (error) {
			console.error(error);
			throw error;
		}
	};

	bulkSearch = async (productVariantCodes: string[], stockId: string) => {
		try {
			// Una sola consulta para todos los códigos. Antes era una por código,
			// más otra por código para armar `stocks`.
			const productVariants = await this.productVariantModel.findAll({
				where: { vId: { [Op.in]: productVariantCodes } },
				attributes: [
					'id',
					'name',
					'vId',
					[sequelize.col('product.name'), 'productName'],
					[sequelize.col('stockItems.id'), 'stockItemId'],
					[sequelize.col('stockItems.quantity'), 'quantity'],
					// Se devuelve el estado en lugar de filtrar por él: filtrar aquí
					// haría que un item desactivado cayera en el mensaje genérico de
					// "no se encontró en la bodega", que es falso. Quien llama decide
					// qué decirle al usuario.
					[sequelize.col('stockItems.active'), 'activeInOrigin'],
					// Bodegas donde la presentación existe y está activa
					[
						sequelize.literal(`(
                            SELECT COALESCE(array_agg(DISTINCT si."stockId"), '{}')
                            FROM stock_item_product_variant sipv
                            INNER JOIN stock_item si ON si.id = sipv."stockItemId"
                            WHERE sipv."productVariantId" = "ProductVariantModel"."id"
                            AND si.active = true
                        )`),
						'stocks',
					],
				],
				include: [
					{
						model: this.productModel,
						as: 'product',
						attributes: [],
					},
					{
						// `required: false` conserva la presentación aunque no esté en esta
						// bodega, para poder distinguir "no existe" de "no está aquí"
						model: StockItemModel,
						as: 'stockItems',
						where: { stockId },
						attributes: [],
						through: { attributes: [] },
						required: false,
					},
				],
			});

			const byCode = new Map(
				productVariants.map(productVariant => [
					productVariant.dataValues.vId,
					productVariant.dataValues,
				]),
			);

			// Se recorren los códigos y no el resultado, para devolverlos en el
			// mismo orden en que llegaron
			const productVariantsResult = productVariantCodes.map(pvCode => {
				const productVariant = byCode.get(pvCode);

				if (!productVariant) {
					throw new Error(
						`No existe el producto con código ${pvCode}. Por favor revisa bien los datos e intentalo nuevamente!`,
					);
				}

				const {
					productName,
					name,
					stockItemId,
					quantity,
					stocks,
					activeInOrigin,
				} = productVariant;

				if (!stockItemId) {
					throw new Error(
						`No fue posible encontrar en la bodega el item ${productName} - ${name}. Por favor revisa bien los datos e intentalo nuevamente!`,
					);
				}

				return {
					id: productVariant.id,
					name: `${productName} - ${name}`,
					quantity,
					stockItemId,
					stocks,
					activeInOrigin,
					productCode: pvCode,
				};
			});

			return { status: 200, productVariants: productVariantsResult };
		} catch (error) {
			console.error('Error obteniendo productos con información de stock');
			throw error;
		}
	};

	count = async (productId: string) => {
		try {
			const productVariantsCount = await this.productVariantModel.count({
				where: { productId },
			});

			return productVariantsCount;
		} catch (error) {
			console.error(
				'ServiceError en el conteo de presentaciones del producto: ',
				error,
			);
			throw error;
		}
	};

	/**
	 * `includeInactive` devuelve también las presentaciones cuyo item de stock
	 * está desactivado en esta bodega, marcadas con `activeInOrigin: false`, para
	 * que el buscador pueda mostrarlas atenuadas en lugar de no mostrar nada: un
	 * código válido que no aparece sin explicación es indistinguible de un código
	 * mal escrito. Por defecto queda apagado, así que los formularios de factura
	 * y cotización siguen viendo solo lo activo.
	 */
	private getWithStockInfo = async (
		search: string,
		stockId?: string,
		includeInactive = false,
	) => {
		try {
			const productVariantsWithStockInfo =
				await this.productVariantModel.findAll({
					where: {
						[Op.or]: [
							{ vId: { [Op.iLike]: `%${search}%` } },
							sequelize.where(
								sequelize.literal(
									`concat("product"."name", ' ', "ProductVariantModel"."name")`,
								),
								{ [Op.iLike]: `%${search}%` },
							),
						],
					},
					attributes: [
						'id',
						'name',
						[sequelize.col('product.name'), 'productName'],
						[sequelize.col('stockItems.id'), 'stockItemId'],
						[sequelize.col('stockItems.quantity'), 'quantity'],
						[sequelize.col('stockItems.price'), 'price'],
						// Obtener precio PVP
						[
							sequelize.literal(`(
																SELECT sip.price
																FROM stock_item_price sip
																INNER JOIN price_type pt ON sip."priceTypeId" = pt.id
																WHERE sip."stockItemId" = "stockItems"."id"
																AND pt.code = 'PVP'
																LIMIT 1
														)`),
							'pricePvp',
						],
						// Obtener precio DIS
						[
							sequelize.literal(`(
																SELECT sip.price
																FROM stock_item_price sip
																INNER JOIN price_type pt ON sip."priceTypeId" = pt.id
																WHERE sip."stockItemId" = "stockItems"."id"
																AND pt.code = 'DIS'
																LIMIT 1
														)`),
							'priceDis',
						],
						[sequelize.col('stockItems.currency'), 'currency'],
						[sequelize.col('stockItems.active'), 'activeInOrigin'],
						// Bodegas donde la presentación existe y está activa
						[
							sequelize.literal(`(
                                SELECT COALESCE(array_agg(DISTINCT si."stockId"), '{}')
                                FROM stock_item_product_variant sipv
                                INNER JOIN stock_item si ON si.id = sipv."stockItemId"
                                WHERE sipv."productVariantId" = "ProductVariantModel"."id"
																AND si.active = true
                            )`),
							'stocks',
						],
					],
					include: [
						{
							model: this.productModel,
							as: 'product',
							attributes: [],
							where: { deletedDate: null },
						},
						{
							model: StockItemModel,
							as: 'stockItems',
							where: includeInactive ? { stockId } : { stockId, active: true },
							attributes: [],
							through: { attributes: [] },
						},
					],
					// Antes solo por cantidad, así que el orden no tenía que ver con lo
					// escrito: un "Vinilo blanco mate" con poco stock salía por debajo
					// de otros vinilos que se parecían menos. Ahora, por prioridad:
					order: [
						// 1. Tres grupos, cada uno junto: con existencias, agotados y
						//    desactivados (estos solo llegan con `includeInactive`). Ir
						//    juntos agotados y desactivados los dejaba intercalados
						[
							sequelize.literal(
								`CASE
									WHEN NOT "stockItems"."active" THEN 2
									WHEN "stockItems"."quantity" > 0 THEN 0
									ELSE 1
								END`,
							),
							'ASC',
						],
						// 2. Qué tanto se parece a lo escrito: el código exacto (lo que
						//    llega al escanear o pegar un vId), luego los nombres que
						//    empiezan por el texto y por último los que solo lo contienen
						[
							sequelize.literal(
								`CASE
									WHEN lower("ProductVariantModel"."vId") = lower(:search) THEN 0
									WHEN concat("product"."name", ' ', "ProductVariantModel"."name") ILIKE (:search || '%') THEN 1
									ELSE 2
								END`,
							),
							'ASC',
						],
						// 3. Alfabético por producto y presentación. Sin la cantidad como
						//    criterio: casi nunca empata, así que tapaba al alfabético y
						//    la lista seguía pareciendo ordenada por stock, sin lógica a
						//    la vista. La cantidad ya se muestra en cada opción
						[sequelize.col('product.name'), 'ASC'],
						['name', 'ASC'],
					],
					// El texto del usuario va por replacements y no interpolado: un
					// `literal` no se escapa
					replacements: { search },
				});

			return productVariantsWithStockInfo.map(
				productVariant => productVariant.dataValues,
			);
		} catch (error) {
			console.error('Error obteniendo productos con información de stock');
			throw error;
		}
	};

	private getMissing = async (search: string, stockId: string) => {
		try {
			const missingProductVariants = await this.productVariantModel.findAll({
				where: {
					[Op.or]: [
						{ vId: { [Op.iLike]: `%${search}%` } },
						sequelize.where(
							sequelize.literal(
								`concat("product"."name", ' ', "ProductVariantModel"."name")`,
							),
							{ [Op.iLike]: `%${search}%` },
						),
					],
					id: {
						[Op.notIn]: sequelize.literal(`(
						SELECT sipv."productVariantId"
						FROM "stock_item_product_variant" AS sipv
						INNER JOIN "stock_item" AS si ON si."id" = sipv."stockItemId"
						WHERE si."stockId" = :stockId
					)`),
					},
				},
				attributes: [
					'id',
					'name',
					[sequelize.col('product.name'), 'productName'],
				],
				include: [
					{
						model: this.productModel,
						as: 'product',
						attributes: [],
						where: { deletedDate: null },
					},
				],
				replacements: { stockId },
			});

			return missingProductVariants;
		} catch (error) {
			console.error('Error obteniendo productos faltantes');
			throw error;
		}
	};
}
