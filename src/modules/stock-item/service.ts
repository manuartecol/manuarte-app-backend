import {
	col,
	FindAndCountOptions,
	fn,
	Op,
	Transaction,
	where,
} from 'sequelize';
import { sequelize } from '../../config/database';
import { StockItemModel } from './model';
import { ProductVariantModel } from '../product-variant/model';
import { ProductModel } from '../product/model';
import { TransactionItemModel } from '../transaction-item/model';
import { TransactionModel } from '../transaction/model';
import { BillingItemModel } from '../billing-item/model';
import { BillingModel } from '../billing/model';
import { StockModel } from '../stock/model';
import { StockItemPriceModel } from '../stock-item-price/model';
import { PriceTypeModel } from '../price-type/model';
import {
	CreateStockItemDto,
	PartialStockItem,
	PricesAndCosts,
	StockItemFilters,
	StockItemFiltersHistory,
	StockOperation,
	UpdateMultipleStockItemDto,
	UpdateStockItemDto,
	UpdateStockItemQtyDto,
} from './types';
import { BillingStatus } from '../billing/types';
import { ProductCategoryModel } from '../product-category/model';
import { ProductCategoryGroupModel } from '../product-category-group/model';
import { endOfDay, parseISO, startOfDay } from 'date-fns';
import { StockItemPriceService } from '../stock-item-price/service';

export class StockItemService {
	private stockItemModel;
	private stockItemPriceService;

	constructor(stockItemModel: typeof StockItemModel) {
		this.stockItemModel = stockItemModel;
		this.stockItemPriceService = new StockItemPriceService(StockItemPriceModel);
	}

	getAllByStock = async (
		stockId: string,
		page: number = 1,
		pageSize: number = 30,
		filters: StockItemFilters = {},
		report: boolean = false,
	) => {
		const offset = (page - 1) * pageSize;

		const productWhere: Record<string, unknown> = {};
		if (filters.productName) {
			const normalizedSearch = filters.productName
				.normalize('NFD')
				.replace(/[\u0300-\u036f]/g, '')
				.toLowerCase();

			productWhere.name = where(
				fn('unaccent', fn('lower', col('productVariants.product.name'))),
				Op.iLike,
				`%${normalizedSearch}%`,
			);
		}

		const productVariantWhere: Record<string, unknown> = { deletedDate: null };
		if (filters.productVariantName) {
			const normalizedSearch = filters.productVariantName
				.normalize('NFD')
				.replace(/[\u0300-\u036f]/g, '')
				.toLowerCase();

			productVariantWhere.name = where(
				fn('unaccent', fn('lower', col('productVariants.name'))),
				Op.iLike,
				`%${normalizedSearch}%`,
			);
		}

		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const baseAttributes: any[] = [
				'id',
				[sequelize.col('productVariants.product.name'), 'productName'],
				[sequelize.col('productVariants.name'), 'productVariantName'],
				[
					sequelize.col(
						'productVariants.product.productCategory.productCategoryGroup.name',
					),
					'productCategoryGroupName',
				],
				[sequelize.col('productVariants.id'), 'productVariantId'],
				[sequelize.col('productVariants.vId'), 'vId'],
				'stockId',
				'currency',
				'price',
				// Obtener precio PVP
				[
					sequelize.literal(`(
                    SELECT sip.price
                    FROM stock_item_price sip
                    INNER JOIN price_type pt ON sip."priceTypeId" = pt.id
                    WHERE sip."stockItemId" = "StockItemModel"."id"
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
                    WHERE sip."stockItemId" = "StockItemModel"."id"
                    AND pt.code = 'DIS'
                    LIMIT 1
                )`),
					'priceDis',
				],
				'quantity',
				'cost',
				'minQty',
				'maxQty',
				'updatedDate',
				[
					sequelize.literal(`(
							SELECT COALESCE(SUM(ti.quantity), 0)
							FROM transaction_item ti
							INNER JOIN transaction t ON ti."transactionId" = t.id
							WHERE ti."productVariantId" = "productVariants"."id"
							AND t.type = 'TRANSFER' 
							AND t."toId" = "StockItemModel"."stockId" 
							AND t.state = 'PROGRESS'
					)`),
					'quantityInTransit',
				],
			];

			if (report) {
				const mainStock = await StockModel.findOne({ where: { isMain: true } });

				if (mainStock && mainStock.dataValues.id !== stockId) {
					baseAttributes.push([
						sequelize.literal(`(
						SELECT COALESCE(si.quantity, 0)
						FROM stock_item si
						INNER JOIN stock_item_product_variant sipv ON sipv."stockItemId" = si.id
						WHERE sipv."productVariantId" = "productVariants"."id"
						AND si."stockId" = '${mainStock.dataValues.id}'
					)`),
						'mainStockQuantity',
					]);
				}
			}

			const queryOptions: FindAndCountOptions = {
				where: { stockId: stockId, active: true },
				attributes: baseAttributes,
				include: [
					{
						model: ProductVariantModel,
						as: 'productVariants',
						attributes: [],
						required: true,
						where: Object.keys(productVariantWhere).length
							? productVariantWhere
							: undefined,
						through: { attributes: [] },
						include: [
							{
								model: ProductModel,
								as: 'product',
								attributes: [],
								required: true,
								where: Object.keys(productWhere).length
									? productWhere
									: undefined,
								include: [
									{
										model: ProductCategoryModel,
										as: 'productCategory',
										attributes: [],
										required: true,
										include: [
											{
												model: ProductCategoryGroupModel,
												as: 'productCategoryGroup',
												attributes: [],
												required: true,
											},
										],
									},
								],
							},
						],
					},
				],
				order: [[sequelize.col('productVariants.product.name'), 'ASC']],
				subQuery: false,
			};

			if (!report) {
				queryOptions.limit = pageSize;
				queryOptions.offset = offset;
			}

			const { rows: stockItems, count: total } =
				await this.stockItemModel.findAndCountAll(queryOptions);

			return {
				status: 200,
				data: {
					stockItems,
					total,
					page,
					pageSize,
					totalPages: Math.ceil(total / pageSize),
				},
			};
		} catch (error) {
			console.error('Error getting stock items');
			throw error;
		}
	};

	getOneByStock = async (productVariantId: string, stockId: string) => {
		try {
			const stockItem = await this.stockItemModel.findOne({
				where: { stockId },
				attributes: [
					'id',
					'quantity',
					'currency',
					'price',
					// Obtener precio PVP
					[
						sequelize.literal(`(
                    SELECT sip.price
                    FROM stock_item_price sip
                    INNER JOIN price_type pt ON sip."priceTypeId" = pt.id
                    WHERE sip."stockItemId" = "StockItemModel"."id"
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
                    WHERE sip."stockItemId" = "StockItemModel"."id"
                    AND pt.code = 'DIS'
                    LIMIT 1
                )`),
						'priceDis',
					],
					'cost',
					[sequelize.col('stock.name'), 'stockName'],
					// Obtener array de stockIds donde existe este productVariant
					[
						sequelize.literal(`(
                        SELECT ARRAY_AGG(DISTINCT si."stockId")
                        FROM stock_item si
                        INNER JOIN stock_item_product_variant sipv ON sipv."stockItemId" = si.id
                        WHERE sipv."productVariantId" = :productVariantId
                    )`),
						'stocks',
					],
				],
				include: [
					{
						model: ProductVariantModel,
						as: 'productVariants',
						where: { id: productVariantId },
						attributes: [],
						through: { attributes: [] },
					},
					{
						model: StockModel,
						as: 'stock',
						attributes: [],
						required: true,
					},
				],
				// El id iba interpolado dentro del literal. Sequelize no escapa lo
				// que va en un `literal`, así que lo sustituye él con replacements
				replacements: { productVariantId },
			});

			return stockItem;
		} catch (error) {
			console.error('Error obteniendo item de stock');
			throw error;
		}
	};

	getOneById = async (id: string, transaction?: Transaction) => {
		try {
			const stockItem = await this.stockItemModel.findByPk(id, {
				attributes: [
					'id',
					'quantity',
					'maxQty',
					'minQty',
					'stockId',
					[sequelize.col('productVariants.product.name'), 'productName'],
					[sequelize.col('productVariants.id'), 'productVariantId'],
					[sequelize.col('productVariants.name'), 'productVariantName'],
				],
				include: [
					{
						model: ProductVariantModel,
						as: 'productVariants',
						required: true,
						attributes: [],
						include: [
							{
								model: ProductModel,
								as: 'product',
								attributes: [],
							},
						],
					},
				],
				transaction,
			});

			return stockItem;
		} catch (error) {
			console.error('Error getting stock item by id');
			throw error;
		}
	};

	getHistory = async (
		id: string,
		page: number = 1,
		pageSize: number = 30,
		filters: StockItemFiltersHistory = {},
	) => {
		try {
			const stockItem = await this.getOneById(id);
			if (!stockItem) {
				throw new Error('Item de stock no encontrado');
			}
			const {
				stockId,
				quantity,
				maxQty,
				minQty,
				productVariantId,
				productName,
				productVariantName,
			} = stockItem.dataValues;

			const stock = await StockModel.findOne({
				where: { id: stockId },
				attributes: ['id', 'shopId'],
			});

			const normalize = (str: string) =>
				str
					.normalize('NFD')
					.replace(/[\u0300-\u036f]/g, '')
					.toLowerCase();

			// --- Filtros dinámicos ---
			const dateFilter =
				filters.dateStart && filters.dateEnd
					? {
							[Op.between]: [
								startOfDay(parseISO(filters.dateStart)),
								endOfDay(parseISO(filters.dateEnd)),
							],
						}
					: undefined;

			// Filtro de type múltiple
			// Normaliza el filtro type a array y mayúsculas
			const types = filters.type
				? Array.isArray(filters.type)
					? filters.type.map(t => (typeof t === 'string' ? t.toUpperCase() : t))
					: [
							typeof filters.type === 'string'
								? filters.type.toUpperCase()
								: filters.type,
						]
				: [];

			const hasBillingType = types.includes('BILLING');
			const hasTransactionType = types.some(t =>
				['ENTER', 'EXIT', 'TRANSFER'].includes(t),
			);

			// Filtro identifier sin acentos ni mayúsculas
			let identifierFilter: ReturnType<typeof where> | undefined = undefined;
			if (filters.identifier) {
				const normalized = normalize(filters.identifier);
				identifierFilter = where(
					fn('unaccent', fn('lower', col('transaction.description'))),
					Op.iLike,
					`%${normalized}%`,
				);
			}

			let billingIdentifierFilter: ReturnType<typeof where> | undefined =
				undefined;
			if (filters.identifier) {
				const normalized = normalize(filters.identifier);
				billingIdentifierFilter = where(
					fn('unaccent', fn('lower', col('billing.serialNumber'))),
					Op.iLike,
					`%${normalized}%`,
				);
			}
			// --- CONSULTAS ---
			let enters: TransactionItemModel[] = [];
			let exits: TransactionItemModel[] = [];
			let billings: BillingItemModel[] = [];

			// Si no hay filtro de tipo o está vacío, devolver todo
			if (!filters.type || types.length === 0) {
				// Consultar BILLINGS
				billings = await BillingItemModel.findAll({
					where: {
						productVariantId,
						...(billingIdentifierFilter && {
							'$billing.serialNumber$': billingIdentifierFilter,
						}),
						...(dateFilter && { '$billing.effectiveDate$': dateFilter }),
					},
					attributes: [
						'id',
						'billingId',
						'currency',
						'quantity',
						[sequelize.col('billing.effectiveDate'), 'createdDate'],
						[sequelize.literal(`'BILLING'`), 'type'],
						[sequelize.col('billing.serialNumber'), 'identifier'],
						[sequelize.col('billing.shopId'), 'shopId'],
						[sequelize.col('billing.status'), 'state'],
					],
					include: [
						{
							model: BillingModel,
							as: 'billing',
							where: {
								status: BillingStatus.PAID,
								shopId: stock?.dataValues?.shopId,
							},
							attributes: [],
						},
					],
					order: [['createdDate', 'DESC']],
				});

				// Consultar ENTRADAS
				enters = await TransactionItemModel.findAll({
					where: {
						productVariantId,
						...(identifierFilter && {
							'$transaction.description$': identifierFilter,
						}),
						...(dateFilter && { createdDate: dateFilter }),
					},
					attributes: [
						'id',
						'transactionId',
						'quantity',
						'stockBefore',
						'createdDate',
						[sequelize.col('transaction.type'), 'type'],
						[sequelize.col('transaction.fromId'), 'fromId'],
						[sequelize.col('transaction.stockFrom.name'), 'fromName'],
						[sequelize.col('transaction.toId'), 'toId'],
						[sequelize.col('transaction.stockTo.name'), 'toName'],
						[sequelize.col('transaction.description'), 'identifier'],
						[sequelize.col('transaction.state'), 'state'],
					],
					include: [
						{
							model: TransactionModel,
							as: 'transaction',
							where: { type: 'ENTER', toId: stockId },
							attributes: [],
							include: [
								{ model: StockModel, as: 'stockFrom', attributes: [] },
								{ model: StockModel, as: 'stockTo', attributes: [] },
							],
						},
					],
					order: [['createdDate', 'DESC']],
				});

				// Consultar SALIDAS
				exits = await TransactionItemModel.findAll({
					where: {
						productVariantId,
						...(identifierFilter && {
							'$transaction.description$': identifierFilter,
						}),
						...(dateFilter && { createdDate: dateFilter }),
					},
					attributes: [
						'id',
						'transactionId',
						'quantity',
						'stockBefore',
						'createdDate',
						[sequelize.col('transaction.type'), 'type'],
						[sequelize.col('transaction.fromId'), 'fromId'],
						[sequelize.col('transaction.stockFrom.name'), 'fromName'],
						[sequelize.col('transaction.toId'), 'toId'],
						[sequelize.col('transaction.stockTo.name'), 'toName'],
						[sequelize.col('transaction.description'), 'identifier'],
						[sequelize.col('transaction.state'), 'state'],
					],
					include: [
						{
							model: TransactionModel,
							as: 'transaction',
							where: {
								type: { [Op.in]: ['EXIT', 'TRANSFER'] },
								fromId: stockId,
							},
							attributes: [],
							include: [
								{ model: StockModel, as: 'stockFrom', attributes: [] },
								{ model: StockModel, as: 'stockTo', attributes: [] },
							],
						},
					],
					order: [['createdDate', 'DESC']],
				});
			} else {
				// Si hay filtro de tipo, consultar solo los tipos solicitados
				if (hasBillingType) {
					billings = await BillingItemModel.findAll({
						where: {
							productVariantId,
							...(billingIdentifierFilter && {
								'$billing.serialNumber$': billingIdentifierFilter,
							}),
							...(dateFilter && { '$billing.effectiveDate$': dateFilter }),
						},
						attributes: [
							'id',
							'billingId',
							'currency',
							'quantity',
							[sequelize.col('billing.effectiveDate'), 'createdDate'],
							[sequelize.literal(`'BILLING'`), 'type'],
							[sequelize.col('billing.serialNumber'), 'identifier'],
							[sequelize.col('billing.shopId'), 'shopId'],
							[sequelize.col('billing.status'), 'state'],
						],
						include: [
							{
								model: BillingModel,
								as: 'billing',
								where: {
									status: BillingStatus.PAID,
									shopId: stock?.dataValues?.shopId,
								},
								attributes: [],
							},
						],
						order: [['createdDate', 'DESC']],
					});
				}

				if (hasTransactionType) {
					const transactionTypes = types.filter(t =>
						['ENTER', 'EXIT', 'TRANSFER'].includes(t),
					);

					// Si se filtra ENTER específicamente o hay tipos de transacción
					if (transactionTypes.includes('ENTER')) {
						enters = await TransactionItemModel.findAll({
							where: {
								productVariantId,
								...(identifierFilter && {
									'$transaction.description$': identifierFilter,
								}),
								...(dateFilter && { createdDate: dateFilter }),
							},
							attributes: [
								'id',
								'transactionId',
								'quantity',
								'stockBefore',
								'createdDate',
								[sequelize.col('transaction.type'), 'type'],
								[sequelize.col('transaction.fromId'), 'fromId'],
								[sequelize.col('transaction.stockFrom.name'), 'fromName'],
								[sequelize.col('transaction.toId'), 'toId'],
								[sequelize.col('transaction.stockTo.name'), 'toName'],
								[sequelize.col('transaction.description'), 'identifier'],
								[sequelize.col('transaction.state'), 'state'],
							],
							include: [
								{
									model: TransactionModel,
									as: 'transaction',
									where: { type: 'ENTER', toId: stockId },
									attributes: [],
									include: [
										{ model: StockModel, as: 'stockFrom', attributes: [] },
										{ model: StockModel, as: 'stockTo', attributes: [] },
									],
								},
							],
							order: [['createdDate', 'DESC']],
						});
					}

					// Si se filtran EXIT o TRANSFER
					const exitTypes = transactionTypes.filter(t =>
						['EXIT', 'TRANSFER'].includes(t),
					);
					if (exitTypes.length > 0) {
						exits = await TransactionItemModel.findAll({
							where: {
								productVariantId,
								...(identifierFilter && {
									'$transaction.description$': identifierFilter,
								}),
								...(dateFilter && { createdDate: dateFilter }),
							},
							attributes: [
								'id',
								'transactionId',
								'quantity',
								'stockBefore',
								'createdDate',
								[sequelize.col('transaction.type'), 'type'],
								[sequelize.col('transaction.fromId'), 'fromId'],
								[sequelize.col('transaction.stockFrom.name'), 'fromName'],
								[sequelize.col('transaction.toId'), 'toId'],
								[sequelize.col('transaction.stockTo.name'), 'toName'],
								[sequelize.col('transaction.description'), 'identifier'],
								[sequelize.col('transaction.state'), 'state'],
							],
							include: [
								{
									model: TransactionModel,
									as: 'transaction',
									where: {
										type: { [Op.in]: exitTypes },
										fromId: stockId,
									},
									attributes: [],
									include: [
										{ model: StockModel, as: 'stockFrom', attributes: [] },
										{ model: StockModel, as: 'stockTo', attributes: [] },
									],
								},
							],
							order: [['createdDate', 'DESC']],
						});
					}
				}
			}

			const historyAsc = [...enters, ...exits, ...billings].sort(
				(a, b) =>
					new Date(a.createdDate).getTime() - new Date(b.createdDate).getTime(),
			);

			let lastTransactionStockAfter = null;
			let lastBillingStockBefore = null;

			for (const item of historyAsc) {
				const type = item.getDataValue('type');

				if (['ENTER', 'EXIT', 'TRANSFER'].includes(type)) {
					const stockBefore = 'stockBefore' in item && item.stockBefore;
					const quantity = item.getDataValue('quantity');

					const delta = type === 'ENTER' ? quantity : -quantity;
					lastTransactionStockAfter = stockBefore + delta;

					lastBillingStockBefore = null;
				}

				if (type === 'BILLING') {
					const quantity = item.getDataValue('quantity');

					if (
						lastBillingStockBefore === null &&
						lastTransactionStockAfter !== null
					) {
						item.setDataValue('stockBefore', lastTransactionStockAfter);
						lastBillingStockBefore = lastTransactionStockAfter - quantity;
					} else if (lastBillingStockBefore !== null) {
						item.setDataValue('stockBefore', lastBillingStockBefore);
						lastBillingStockBefore -= quantity;
					} else {
						item.setDataValue('stockBefore', 0);
						lastBillingStockBefore = -quantity;
					}
				}
			}

			const history = historyAsc.sort(
				(a, b) =>
					new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime(),
			);

			const total = history.length;
			const offset = (page - 1) * pageSize;
			const paginatedHistory = history.slice(offset, offset + pageSize);

			return {
				status: 200,
				stockItem: {
					productName,
					productVariantName,
					quantity,
					maxQty,
					minQty,
				},
				history: paginatedHistory,
				page,
				pageSize,
				total,
				totalPages: Math.ceil(total / pageSize),
			};
		} catch (error) {
			console.error('Error getting stock item history');
			throw error;
		}
	};

	createInMultipleStocks = async (
		productVariantId: string,
		stockItemData: PartialStockItem,
		stocks: { id: string; currency: 'COP' | 'USD' }[],
		transaction: Transaction,
	) => {
		try {
			const { pvpCop, pvpUsd, disCop, disUsd, costCop, costUsd, ...rest } =
				stockItemData;

			for (const stock of stocks) {
				const sanitizedPrices = this.sanitizePrices({
					pvpCop,
					pvpUsd,
					disCop,
					disUsd,
					costCop,
					costUsd,
					currency: stock.currency,
				});

				await this.create(
					{
						productVariantId,
						stockId: stock.id,
						currency: stock.currency,
						...sanitizedPrices,
						...rest,
					},
					transaction,
				);
			}

			return { status: 201 };
		} catch (error) {
			console.error('Error creating stock items');
			throw error;
		}
	};

	create = async (
		stockItemData: CreateStockItemDto,
		externalTransaction?: Transaction,
	) => {
		const transaction = externalTransaction ?? (await sequelize.transaction());
		try {
			const { productVariantId, prices, ...stockItemRest } = stockItemData;

			const newStockItem = await this.stockItemModel.create(
				{ ...stockItemRest, quantity: 0 },
				{ transaction },
			);

			const productVariant = await this.getProductAttrs(
				productVariantId,
				transaction,
			);

			await newStockItem.addProductVariant(productVariantId, {
				transaction,
			});

			// Crear precios múltiples si se proporcionan
			if (prices) {
				// Obtener tipos de precio por código
				const [pvpType, disType] = await Promise.all([
					PriceTypeModel.findOne({ where: { code: 'PVP' }, transaction }),
					PriceTypeModel.findOne({ where: { code: 'DIS' }, transaction }),
				]);

				if (!pvpType) {
					throw new Error('Tipo de precio PVP no está configurado');
				}

				// Crear precios (DIS es opcional)
				const pricePromises = [
					this.stockItemPriceService.create(
						newStockItem.id,
						pvpType.id,
						prices.PVP,
						transaction,
					),
				];

				// Solo crear precio DIS si está presente y es válido
				if (prices.DIS !== undefined && prices.DIS !== null && disType) {
					pricePromises.push(
						this.stockItemPriceService.create(
							newStockItem.id,
							disType.id,
							prices.DIS,
							transaction,
						),
					);
				}

				await Promise.all(pricePromises);

				// Sincronizar precio base con PVP
				await newStockItem.update({ price: prices.PVP }, { transaction });
			} else if (stockItemData.price) {
				// Si no se especifican precios, crear solo PVP con el precio base
				const pvpType = await PriceTypeModel.findOne({
					where: { code: 'PVP' },
					transaction,
				});

				if (pvpType) {
					await this.stockItemPriceService.create(
						newStockItem.id,
						pvpType.id,
						stockItemData.price,
						transaction,
					);
				}
			}

			if (!externalTransaction) {
				await transaction.commit();
			}

			return {
				status: 201,
				newStockItem: {
					...newStockItem.dataValues,
					productName: productVariant?.dataValues.productName,
					productVariantName: productVariant?.dataValues.name,
					productVariantId: productVariant?.dataValues.id,
					pricePvp: prices?.PVP || stockItemData.price || null,
					priceDis: prices?.DIS || null,
				},
			};
		} catch (error) {
			if (!externalTransaction) {
				await transaction.rollback();
			}
			console.error('Error creating stock item');
			throw error;
		}
	};

	updateInMultipleStocks = async ({
		id,
		stockIds,
		stockItemData,
	}: UpdateMultipleStockItemDto) => {
		try {
			const { productVariantId } = stockItemData;

			const missingStocks: string[] = [];

			const stockItems = [
				{ id, currency: 'COP' },
				...(await Promise.all(
					stockIds.map(async stockId => {
						const stock = await StockModel.findByPk(stockId);
						const stockItem = await this.getOneByStock(
							productVariantId,
							stockId,
						);

						const stockName = stock?.dataValues.name;
						const itemStockName = stockItem?.dataValues.stockName || '';

						if (stockName && !itemStockName.includes(stockName)) {
							missingStocks.push(stockName);
						}

						return {
							id: stockItem?.dataValues.id,
							currency: stockItem?.dataValues.currency,
						};
					}),
				)),
			];

			if (missingStocks.length > 0) {
				throw new Error(
					`El item no existe en: ${missingStocks.map(stock => `◾ ${stock}`).join(' ')}`,
				);
			}

			const results = await Promise.all(
				stockItems.map(({ id, currency }) => {
					const sanitizedPrices = this.sanitizePrices({
						...stockItemData,
						currency,
					});

					return this.update({
						id,
						stockItemData: {
							...stockItemData,
							...sanitizedPrices,
						},
					});
				}),
			);

			const result = results[0];

			return {
				status: result?.status,
				updatedStockItem: result?.updatedStockItem,
			};
		} catch (error) {
			console.error('Error updating stock items');
			throw error;
		}
	};

	update = async ({ id, stockItemData }: UpdateStockItemDto) => {
		try {
			const { productVariantId, prices, ...stockItemRest } = stockItemData;

			if ('quantity' in stockItemData) {
				throw new Error(
					'No se puede modificar directamente la cantidad en stock',
				);
			}

			const stockItemToUpdate = await this.stockItemModel.findByPk(id);
			if (!stockItemToUpdate) {
				throw new Error('Stock de producto no encontrado');
			}

			await stockItemToUpdate.update({ ...stockItemRest });

			// Actualizar precios si se proporcionan
			if (prices && (prices.PVP !== undefined || prices.DIS !== undefined)) {
				// Obtener tipos de precio por código
				const [pvpType, disType] = await Promise.all([
					PriceTypeModel.findOne({ where: { code: 'PVP' } }),
					PriceTypeModel.findOne({ where: { code: 'DIS' } }),
				]);

				if (!pvpType) {
					throw new Error('Tipo de precio PVP no está configurado');
				}

				// Upsert precios
				const updatePromises = [];
				if (prices.PVP !== undefined && prices.PVP !== null) {
					updatePromises.push(
						this.stockItemPriceService.update(id, pvpType.id, prices.PVP),
					);

					// Sincronizar precio base con PVP
					updatePromises.push(stockItemToUpdate.update({ price: prices.PVP }));
				}
				// Solo actualizar DIS si está presente, es válido y el tipo existe
				if (prices.DIS !== undefined && prices.DIS !== null && disType) {
					updatePromises.push(
						this.stockItemPriceService.update(id, disType.id, prices.DIS),
					);
				}

				await Promise.all(updatePromises);
			}

			if (!productVariantId) {
				throw new Error('No se pudo determinar el producto asociado');
			}

			const productVariant = await this.getProductAttrs(productVariantId);

			return {
				status: 200,
				updatedStockItem: {
					...stockItemToUpdate.dataValues,
					productName: productVariant?.dataValues.productName,
					productVariantName: productVariant?.dataValues.name,
					productVariantId: productVariant?.dataValues.id,
					pricePvp: prices?.PVP || null,
					priceDis: prices?.DIS || null,
				},
			};
		} catch (error) {
			console.error('Error updating stock item');
			throw error;
		}
	};

	updateQuantity = async (
		{ quantity, name, productVariantId, stockId }: UpdateStockItemQtyDto,
		operation: StockOperation = StockOperation.SUBTRACT,
		transaction: Transaction,
	) => {
		try {
			const stockItemToUpdate = await this.getOneByStock(
				productVariantId,
				stockId as string,
			);

			if (!stockItemToUpdate) {
				throw new Error(`No fue posible encontrar el producto ${name}`);
			}

			const currentQty = Number(stockItemToUpdate?.quantity);
			const delta = Number(quantity);

			if (isNaN(currentQty) || isNaN(delta)) {
				throw new Error(`Ocurrió un error con las cantidades del item ${name}`);
			}

			if (operation === StockOperation.SUBTRACT && currentQty < delta) {
				throw new Error(`No hay suficiente stock (${currentQty}) para ${name}`);
			}

			const newQuantity =
				operation === StockOperation.ADD
					? currentQty + delta
					: currentQty - delta;

			await stockItemToUpdate.update(
				{ quantity: newQuantity },
				{ transaction },
			);
		} catch (error) {
			console.error('Error updating stock item quantity');
			throw error;
		}
	};

	delete = async (id: string) => {
		try {
			const stockItem = await this.stockItemModel.findByPk(id);
			if (!stockItem)
				throw new Error(
					'No existe en el stock el producto que estás intentando eliminar',
				);

			if (Number(stockItem?.quantity) > 0) {
				throw new Error(
					`No puedes eliminar un item con cantidad en stock (${stockItem?.quantity} unds)`,
				);
			}

			const result = await this.stockItemModel.destroy({ where: { id } });

			if (result === 1) {
				return {
					status: 200,
					message: 'Producto eliminado del stock con éxito',
				};
			}

			return { status: 404, message: 'Stock de producto no encontrado' };
		} catch (error) {
			console.error('Error deleting stock item');
			throw error;
		}
	};

	getPrice = async (
		stockItemId: string,
		priceTypeCode: 'PVP' | 'DIS',
		transaction?: Transaction,
	): Promise<number> => {
		try {
			const price = await this.stockItemPriceService.getPriceByType(
				stockItemId,
				priceTypeCode,
				transaction,
			);

			if (price) return price;

			// Fallback al precio base del stock_item
			const stockItem = await StockItemModel.findByPk(stockItemId, {
				transaction,
			});
			if (stockItem && stockItem.price) {
				console.warn(
					`Usando precio base para stock_item ${stockItemId} con tipo ${priceTypeCode}`,
				);
				return parseFloat(stockItem.price.toString());
			}

			throw new Error('Precio no encontrado para este tipo');
		} catch (error) {
			console.error('Error getting price by type');
			throw error;
		}
	};

	sanitizePrices = (
		stockItemData: { currency: 'COP' | 'USD' } & PricesAndCosts,
	) => {
		const { currency, pvpCop, pvpUsd, disCop, disUsd, costCop, costUsd } =
			stockItemData;

		const disPrice = currency === 'COP' ? disCop : disUsd;

		const prices: { PVP: number; DIS?: number } = {
			PVP: currency === 'COP' ? pvpCop : pvpUsd,
		};

		// Solo incluir DIS si tiene un valor válido
		if (disPrice !== undefined && disPrice !== null) {
			prices.DIS = disPrice;
		}

		return {
			price: currency === 'COP' ? pvpCop : pvpUsd,
			prices,
			cost: currency === 'COP' ? costCop : costUsd,
		};
	};

	setActiveStocks = async (
		productVariantId: string,
		activeStockIds: string[], // Solo los stocks donde debe estar activo
		transaction?: Transaction,
	) => {
		try {
			// Obtener todos los stock items del producto
			// Con transacción, las filas quedan bloqueadas hasta el commit: así un
			// movimiento de stock no puede sumar unidades entre la validación y la
			// desactivación. Solo `stock_item`, porque `stock` va por LEFT JOIN y
			// Postgres no permite bloquear el lado nullable
			const allStockItems = await this.stockItemModel.findAll({
				transaction,
				...(transaction && {
					lock: { level: transaction.LOCK.UPDATE, of: this.stockItemModel },
				}),
				include: [
					{
						model: ProductVariantModel,
						as: 'productVariants',
						where: { id: productVariantId },
						through: { attributes: [] },
					},
					{
						model: StockModel,
						as: 'stock',
						attributes: ['id', 'name'],
					},
				],
			});

			if (allStockItems.length === 0) {
				throw new Error('El producto no existe en ningún stock');
			}

			// Validar que todos los stockIds en activeStockIds existan
			const existingStockIds = allStockItems.map(item => item.stockId);
			const invalidStockIds = activeStockIds?.filter(
				stockId => !existingStockIds.includes(stockId),
			);

			if (invalidStockIds.length > 0) {
				const invalidStocks = await StockModel.findAll({
					where: { id: { [Op.in]: invalidStockIds } },
					attributes: ['id', 'name'],
				});

				const stockNames = invalidStocks.map(stock => stock.name).join(', ');

				throw new Error(
					`El producto no existe en los siguientes stocks: ${stockNames}`,
				);
			}

			// Actualizar cada stock item según si está en la lista o no. En serie y
			// validando antes de escribir: con `Promise.all`, un item que no se podía
			// desactivar rechazaba la promesa con las demás escrituras aún en vuelo
			for (const item of allStockItems) {
				const shouldBeActive = activeStockIds.includes(item.stockId);

				if (!shouldBeActive && Number(item.quantity) > 0 && item.active) {
					throw new Error(
						`No se puede desactivar el item en ${item.getDataValue('stock').name}, ya que tiene ${item.quantity} unidades en el stock.`,
					);
				}
			}

			for (const item of allStockItems) {
				await item.update(
					{ active: activeStockIds.includes(item.stockId) },
					{ transaction },
				);
			}

			const activatedCount = activeStockIds.length;
			const deactivatedCount = allStockItems.length - activatedCount;

			return {
				status: 200,
				message: `Producto configurado: ${activatedCount} stock(s) activo(s), ${deactivatedCount} desactivado(s)`,
			};
		} catch (error) {
			console.error('Error setting active stocks');
			throw error;
		}
	};

	private getProductAttrs = async (
		productVariantId: string,
		transaction?: Transaction,
	) => {
		try {
			const productVariant = await ProductVariantModel.findByPk(
				productVariantId,
				{
					attributes: [
						'id',
						'name',
						[sequelize.col('product.name'), 'productName'],
					],
					include: [
						{
							model: ProductModel,
							as: 'product',
							attributes: [],
						},
					],
					transaction,
				},
			);

			if (!productVariant) {
				throw new Error(
					'La presentación de producto con el ID proporcionado no existe',
				);
			}

			return productVariant;
		} catch (error) {
			console.error('Error getting product info');
			throw error;
		}
	};
}
