import { sequelize } from '../../config/database';
import { BillingStatus } from '../billing/types';
import { ProductCategoryModel } from '../product-category/model';
import { ProductModel } from '../product/model';
import { StockItemModel } from '../stock-item/model';
import { StockItemService } from '../stock-item/service';
import { ProductVariantModel } from './model';
import {
	CreateProductVariantDto,
	ProductVariantDeletionPlan,
	ProductVariantFilters,
	UpdateProductVariantDto,
} from './types';
import { Op, QueryTypes, Transaction } from 'sequelize';

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
						...(filters?.showActiveOnly !== null && {
							active: filters?.showActiveOnly ?? true,
						}),
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

	update = async (
		{ id, name, active, stockIds, requestedBy }: UpdateProductVariantDto,
		transaction?: Transaction,
	) => {
		// Si no llega de `ProductService.update`, abre la suya: `setActiveStocks`
		// actualiza varias bodegas y un fallo a mitad dejaba unas sí y otras no
		const ownsTransaction = !transaction;
		const t = transaction ?? (await sequelize.transaction());
		try {
			const productVariantToUpdate = await this.productVariantModel.findByPk(
				id,
				{ transaction: t },
			);
			if (!productVariantToUpdate) {
				throw new Error(
					`No se encontró la presentación de producto con id ${id}`,
				);
			}

			await productVariantToUpdate.update(
				{
					name,
					active,
					updatedBy: requestedBy,
				},
				{ transaction: t },
			);

			if (stockIds) {
				await this.stockItemService.setActiveStocks(
					id,
					stockIds as string[],
					t,
				);
			}

			if (ownsTransaction) await t.commit();

			return productVariantToUpdate.dataValues;
		} catch (error) {
			if (ownsTransaction) await t.rollback();
			console.error(
				'ServiceError actualizando presentación de producto: ',
				error,
			);
			throw error;
		}
	};

	/**
	 * Decide qué puede pasar con una presentación antes de tocar nada. Lo usan el
	 * borrado y la consulta previa del panel, para que el aviso y lo que de hecho
	 * ocurre salgan de la misma cuenta.
	 *
	 * Las filas se cuentan sin mirar su `deletedDate`: lo que importa aquí es si
	 * algo referencia a esta presentación, y una factura anulada también lo hace
	 */
	getDeletionPlan = async (
		productVariantId: string,
		transaction?: Transaction,
	): Promise<ProductVariantDeletionPlan> => {
		try {
			/**
			 * Dos cifras por cada tipo de documento. `*Rows` cuenta todas las filas,
			 * sin mirar si el documento está anulado o borrado, porque cualquiera de
			 * ellas referencia esta presentación y basta una para que el borrado no
			 * pueda ser físico. Los conteos sin sufijo son solo de documentos vivos:
			 * son los que se le muestran al usuario, para que el número del aviso
			 * coincida con el que ve en el listado de facturas
			 */
			const [history] = await sequelize.query<{
				billingRows: string;
				quoteRows: string;
				transactionRows: string;
				billingItems: string;
				quoteItems: string;
				transactionItems: string;
			}>(
				`
					SELECT
						(SELECT COUNT(*) FROM billing_item WHERE "productVariantId" = :productVariantId) AS "billingRows",
						(SELECT COUNT(*) FROM quote_item WHERE "productVariantId" = :productVariantId) AS "quoteRows",
						(SELECT COUNT(*) FROM transaction_item WHERE "productVariantId" = :productVariantId) AS "transactionRows",
						(
							SELECT COUNT(*)
							FROM billing_item bi
							INNER JOIN billing b ON b.id = bi."billingId"
							WHERE bi."productVariantId" = :productVariantId
								AND bi."deletedDate" IS NULL
								AND b."deletedDate" IS NULL
								AND b.status <> :canceled
						) AS "billingItems",
						(
							SELECT COUNT(*)
							FROM quote_item qi
							INNER JOIN quote q ON q.id = qi."quoteId"
							WHERE qi."productVariantId" = :productVariantId
								AND qi."deletedDate" IS NULL
								AND q."deletedDate" IS NULL
						) AS "quoteItems",
						(
							SELECT COUNT(*)
							FROM transaction_item ti
							INNER JOIN "transaction" tr ON tr.id = ti."transactionId"
							WHERE ti."productVariantId" = :productVariantId
								AND ti."deletedDate" IS NULL
								AND ti.success = true
								AND tr."deletedDate" IS NULL
						) AS "transactionItems"
				`,
				{
					replacements: {
						productVariantId,
						canceled: BillingStatus.CANCELED,
					},
					type: QueryTypes.SELECT,
					transaction,
				},
			);

			const stocksWithUnits = await sequelize.query<{
				name: string;
				quantity: number;
			}>(
				`
					SELECT s.name, si.quantity
					FROM stock_item_product_variant sipv
					INNER JOIN stock_item si ON si.id = sipv."stockItemId"
					INNER JOIN stock s ON s.id = si."stockId"
					WHERE sipv."productVariantId" = :productVariantId
						AND si.quantity <> 0
					ORDER BY s.name ASC
				`,
				{
					replacements: { productVariantId },
					type: QueryTypes.SELECT,
					transaction,
				},
			);

			const historyRows =
				Number(history.billingRows) +
				Number(history.quoteRows) +
				Number(history.transactionRows);

			const mode =
				stocksWithUnits.length > 0
					? 'blocked'
					: historyRows > 0
						? 'logical'
						: 'physical';

			return {
				mode,
				historyRows,
				billingItems: Number(history.billingItems),
				quoteItems: Number(history.quoteItems),
				transactionItems: Number(history.transactionItems),
				stocksWithUnits,
			};
		} catch (error) {
			console.error(
				'ServiceError calculando el borrado de la presentación: ',
				error,
			);
			throw error;
		}
	};

	/**
	 * El id del producto y el de la presentación llegan por separado desde el
	 * panel y nada garantiza que vayan juntos. Sin esta comprobación, un par
	 * cruzado borraría la presentación de un producto y evaluaría el borrado de
	 * otro distinto
	 */
	assertBelongsToProduct = async (
		productVariantId: string,
		productId: string,
		transaction?: Transaction,
	) => {
		const productVariant = await this.productVariantModel.findByPk(
			productVariantId,
			{ attributes: ['id', 'productId'], transaction },
		);

		if (!productVariant) {
			throw new Error(
				'La presentación ya no existe. Actualiza la tabla y vuelve a intentarlo',
			);
		}

		if (productVariant.getDataValue('productId') !== productId) {
			throw new Error('La presentación no pertenece a este producto');
		}
	};

	delete = async (productVariantId: string, transaction?: Transaction) => {
		const ownsTransaction = !transaction;
		const t = transaction ?? (await sequelize.transaction());
		try {
			const productVariantToDelete = await this.productVariantModel.findByPk(
				productVariantId,
				{ transaction: t },
			);
			if (!productVariantToDelete)
				throw new Error(
					'No se encontró la presentación del producto que intentas eliminar',
				);

			const plan = await this.getDeletionPlan(productVariantId, t);

			if (plan.mode === 'blocked') {
				const detail = plan.stocksWithUnits
					.map(stock => `${stock.name} (${stock.quantity})`)
					.join(', ');

				/**
				 * No se ofrece desactivarla: `setActiveStocks` rechaza desactivar un
				 * item con unidades, así que el único camino real es sacarlas
				 */
				throw new Error(
					`No se puede eliminar la presentación, porque tiene unidades en stock: ${detail}. Sácalas con un movimiento de salida y vuelve a intentarlo`,
				);
			}

			// Sin documentos detrás, sus filas de bodega no guardan historial: se
			// van con ella. Con documentos, la fila se queda marcada como borrada y
			// las bodegas no se tocan
			if (plan.mode === 'physical') {
				await this.stockItemService.deleteByProductVariant(productVariantId, t);
			}

			await productVariantToDelete.destroy({
				force: plan.mode === 'physical',
				transaction: t,
			});

			if (ownsTransaction) await t.commit();

			return { productVariant: productVariantToDelete, mode: plan.mode };
		} catch (error) {
			if (ownsTransaction) await t.rollback();
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

	/**
	 * `includeDeleted` cuenta también las presentaciones marcadas como borradas,
	 * que son las que impiden borrar el producto definitivamente
	 */
	count = async (
		productId: string,
		transaction?: Transaction,
		includeDeleted = false,
	) => {
		try {
			const productVariantsCount = await this.productVariantModel.count({
				where: { productId },
				paranoid: !includeDeleted,
				transaction,
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
