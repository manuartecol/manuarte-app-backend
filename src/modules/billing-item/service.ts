import { Op, QueryTypes, Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { CreateBillingItemDto, MonthlySalesData } from './types';
import { BillingItemModel } from './model';
import { monthNames } from './consts';
import { StockItemService } from '../stock-item/service';
import { StockItemModel } from '../stock-item/model';
import { BillingModel } from '../billing/model';
import { BillingStatus } from '../billing/types';
import { ProductVariantModel } from '../product-variant/model';
import { ProductModel } from '../product/model';
import { ProductCategoryModel } from '../product-category/model';
import { ProductCategoryGroupModel } from '../product-category-group/model';
import { StockOperation } from '../stock-item/types';

const FLETE = 'e0490768-3cdb-4abe-9a3d-c87cda126f45';
const DESCUENTO = '07d7284f-547e-4bbd-a4bb-2cf94b0c2e1a';

export class BillingItemService {
	private billingItemModel;
	private stockItemService;

	constructor(billingItemModel: typeof BillingItemModel) {
		this.billingItemModel = billingItemModel;
		this.stockItemService = new StockItemService(StockItemModel);
	}

	create = async (
		billingItemData: CreateBillingItemDto,
		deductFromStock: boolean,
		transaction: Transaction,
	) => {
		try {
			const newBillingItem = await this.billingItemModel.create(
				billingItemData,
				{ transaction },
			);

			if (!deductFromStock) {
				return newBillingItem;
			}

			await this.stockItemService.updateQuantity(
				billingItemData,
				StockOperation.SUBTRACT,
				transaction,
			);

			return newBillingItem;
		} catch (error) {
			console.error('Error creando items de factura');
			throw error;
		}
	};

	cancel = async ({
		billingItemData,
		stockId,
		transaction,
	}: {
		billingItemData: CreateBillingItemDto;
		stockId: string;
		transaction: Transaction;
	}) => {
		try {
			await this.stockItemService.updateQuantity(
				{ ...billingItemData, stockId },
				StockOperation.ADD,
				transaction,
			);
		} catch (error) {
			console.error('Error cancelando items de factura');
			throw error;
		}
	};

	getSales = async (year?: number) => {
		try {
			const currentYear = year ?? new Date().getFullYear();
			const startOfYear = new Date(currentYear, 0, 1);
			const startOfNextYear = new Date(currentYear + 1, 0, 1);

			const rawSales = await BillingModel.findAll({
				attributes: [
					[
						sequelize.fn('DATE_PART', 'month', sequelize.col('effectiveDate')),
						'month',
					],
					[sequelize.col('billingItems.currency'), 'currency'],
					[
						sequelize.literal(`
							SUM(
								CASE
									WHEN "BillingModel"."discountType" = 'PERCENTAGE'
										THEN "billingItems"."totalPrice" * (1 - "BillingModel"."discount" / 100)
									WHEN "BillingModel"."discountType" = 'FIXED'
										THEN "billingItems"."totalPrice" * (1 - "BillingModel"."discount" / NULLIF("BillingModel"."subtotal", 0))
									ELSE "billingItems"."totalPrice"
								END
							)
							`),
						'totalSales',
					],
				],
				where: {
					effectiveDate: {
						[Op.gte]: startOfYear,
						[Op.lt]: startOfNextYear,
					},
					status: BillingStatus.PAID,
				},
				include: [
					{
						model: this.billingItemModel,
						as: 'billingItems',
						attributes: [],
						required: true,
						include: [
							{
								model: ProductVariantModel,
								as: 'productVariant',
								attributes: [],
								where: { deletedDate: null },
							},
						],
					},
				],
				group: [
					sequelize.fn('DATE_PART', 'month', sequelize.col('effectiveDate')),
					'billingItems.currency',
				],
				order: [[sequelize.literal('month'), 'ASC']],
				raw: true,
			});

			const sales = rawSales as unknown as MonthlySalesData[];

			const formattedSales = sales.reduce(
				(acc, item) => {
					const month = item.month;
					const currency = item.currency;
					const totalSales = item.totalSales;

					let monthData = acc.find(entry => entry.month === month);

					if (!monthData) {
						monthData = { month };
						acc.push(monthData);
					}

					monthData[currency] = Number(totalSales);
					return acc;
				},
				[] as { month: number; [currency: string]: number | undefined }[],
			);

			const salesWithMonthNames = formattedSales.map(item => ({
				month: monthNames[item.month - 1],
				COP: item.COP ?? 0,
				USD: item.USD ?? 0,
			}));

			const yearlyTotals = salesWithMonthNames.reduce(
				(acc, item) => {
					acc.COP += item.COP;
					acc.USD += item.USD;
					return acc;
				},
				{ COP: 0, USD: 0 },
			);

			return { monthlyTotals: salesWithMonthNames, yearlyTotals };
		} catch (error) {
			console.error('ServiceError obteniendo ventas por mes: ', error);
			throw error;
		}
	};

	getTopSalesProducts = async (year?: number, month?: number) => {
		try {
			const now = new Date();
			const targetYear = year ?? now.getFullYear();
			const targetMonth = month ?? now.getMonth();

			// Ejecutar consultas COP y USD en paralelo
			const [topCOP, topUSD] = await Promise.all([
				this.getTopSellingProducts('COP', targetYear, targetMonth),
				this.getTopSellingProducts('USD', targetYear, targetMonth),
			]);

			const formatResults = (
				data: Array<{
					productVariantId: string;
					productName: string;
					baseProductName: string;
					totalQuantity: string;
				}>,
			) =>
				data.map(item => ({
					productVariantId: item.productVariantId,
					productName: `${item.baseProductName} - ${item.productName}`,
					totalQuantity: parseFloat(item.totalQuantity),
				}));

			return {
				month: monthNames[targetMonth],
				year: targetYear,
				topCOP: formatResults(topCOP),
				topUSD: formatResults(topUSD),
			};
		} catch (error) {
			console.error(error);
			throw error;
		}
	};

	private getTopSellingProducts = async (
		currency: string,
		targetYear: number,
		targetMonth: number,
		limit = 15,
	) => {
		try {
			const startOfMonth = new Date(targetYear, targetMonth, 1);
			const startOfNextMonth = new Date(targetYear, targetMonth + 1, 1);

			const result = await this.billingItemModel.findAll({
				where: {
					currency,
					productVariantId: { [Op.notIn]: [FLETE, DESCUENTO] },
				},
				attributes: [
					[
						sequelize.col('BillingItemModel.productVariantId'),
						'productVariantId',
					],
					[sequelize.col('productVariant.name'), 'productName'],
					[sequelize.col('productVariant.product.name'), 'baseProductName'],
					[
						sequelize.fn('SUM', sequelize.col('BillingItemModel.quantity')),
						'totalQuantity',
					],
				],
				include: [
					{
						model: BillingModel,
						as: 'billing',
						attributes: [],
						where: {
							effectiveDate: {
								[Op.gte]: startOfMonth,
								[Op.lt]: startOfNextMonth,
							},
							status: BillingStatus.PAID,
						},
					},
					{
						model: ProductVariantModel,
						as: 'productVariant',
						required: true,
						attributes: [],
						include: [
							{
								model: ProductModel,
								as: 'product',
								required: true,
								attributes: [],
							},
						],
					},
				],
				group: [
					'BillingItemModel.productVariantId',
					'productVariant.name',
					'productVariant.product.name',
				],
				order: [
					[
						sequelize.fn('SUM', sequelize.col('BillingItemModel.quantity')),
						'DESC',
					],
				],
				limit,
				raw: true,
			});

			return result as unknown as Array<{
				productVariantId: string;
				productName: string;
				baseProductName: string;
				totalQuantity: string;
			}>;
		} catch (error) {
			console.error(error);
			throw error;
		}
	};

	getDetailedSalesReport = async (
		currency: 'COP' | 'USD',
		startDate: Date,
		endDate: Date,
	) => {
		try {
			// 1. Resumen general del período
			// const summary = await this.getSalesSummary(currency, startDate, endDate);

			// 2. Ventas por ProductCategoryGroup
			// const salesByGroup = await this.getSalesByProductCategoryGroup(
			// 	currency,
			// 	startDate,
			// 	endDate,
			// );

			// 3. Desglose por categoría dentro de cada grupo
			// const salesByCategory = await this.getSalesByProductCategory(
			// 	currency,
			// 	startDate,
			// 	endDate,
			// );

			// 4. Todos los productos activos con sus ventas del período (incluyendo ventas en cero), ordenados de mayor a menor
			const products = await this.getAllProductsSales(
				currency,
				startDate,
				endDate,
			);

			// 5. Comparación con período anterior
			const comparison = await this.getComparisonWithPreviousPeriod(
				currency,
				startDate,
				endDate,
			);

			return {
				period: {
					start: startDate,
					end: endDate,
					currency,
				},
				products,
				comparison,
			};
		} catch (error) {
			console.error('Error generando informe detallado de ventas', error);
			throw error;
		}
	};

	private getSalesSummary = async (
		currency: string,
		startDate: Date,
		endDate: Date,
	) => {
		const result = await this.billingItemModel.findOne({
			where: { currency },
			attributes: [
				[
					sequelize.fn('SUM', sequelize.col('BillingItemModel.quantity')),
					'totalQuantity',
				],
				[
					sequelize.literal(`
						SUM(
							CASE
								WHEN "billing"."discountType" = 'PERCENTAGE'
									THEN "BillingItemModel"."totalPrice" * (1 - "billing"."discount" / 100)
								WHEN "billing"."discountType" = 'FIXED'
									THEN "BillingItemModel"."totalPrice" * (1 - "billing"."discount" / NULLIF("billing"."subtotal", 0))
								ELSE "BillingItemModel"."totalPrice"
							END
						)
					`),
					'totalRevenue',
				],
				[
					sequelize.fn('COUNT', sequelize.literal('DISTINCT "billing"."id"')),
					'totalOrders',
				],
				[
					sequelize.literal(`
						AVG(
							CASE
								WHEN "billing"."discountType" = 'PERCENTAGE'
									THEN "billing"."subtotal" * (1 - "billing"."discount" / 100)
								WHEN "billing"."discountType" = 'FIXED'
									THEN "billing"."subtotal" - "billing"."discount"
								ELSE "billing"."subtotal"
							END
						)
					`),
					'avgOrderValue',
				],
			],
			include: [
				{
					model: BillingModel,
					as: 'billing',
					attributes: [],
					where: {
						effectiveDate: { [Op.between]: [startDate, endDate] },
						status: BillingStatus.PAID,
					},
				},
				{
					model: ProductVariantModel,
					as: 'productVariant',
					attributes: [],
					where: { deletedDate: null },
				},
			],
			raw: true,
		});

		return result;
	};

	private getSalesByProductCategoryGroup = async (
		currency: string,
		startDate: Date,
		endDate: Date,
	) => {
		const result = await this.billingItemModel.findAll({
			where: {
				currency,
				productVariantId: { [Op.ne]: FLETE },
			},
			attributes: [
				[
					sequelize.col(
						'productVariant.product.productCategory.productCategoryGroup.id',
					),
					'groupId',
				],
				[
					sequelize.col(
						'productVariant.product.productCategory.productCategoryGroup.name',
					),
					'groupName',
				],
				[
					sequelize.fn('SUM', sequelize.col('BillingItemModel.quantity')),
					'totalQuantity',
				],
				[
					sequelize.literal(`
						SUM(
							CASE
								WHEN "billing"."discountType" = 'PERCENTAGE'
									THEN "BillingItemModel"."totalPrice" * (1 - "billing"."discount" / 100)
								WHEN "billing"."discountType" = 'FIXED'
									THEN "BillingItemModel"."totalPrice" * (1 - "billing"."discount" / NULLIF("billing"."subtotal", 0))
								ELSE "BillingItemModel"."totalPrice"
							END
						)
					`),
					'totalRevenue',
				],
			],
			include: [
				{
					model: BillingModel,
					as: 'billing',
					attributes: [],
					where: {
						effectiveDate: { [Op.between]: [startDate, endDate] },
						status: BillingStatus.PAID,
					},
				},
				{
					model: ProductVariantModel,
					as: 'productVariant',
					required: true,
					attributes: [],
					include: [
						{
							model: ProductModel,
							as: 'product',
							required: true,
							attributes: [],
							include: [
								{
									model: ProductCategoryModel,
									as: 'productCategory',
									required: true,
									attributes: [],
									include: [
										{
											model: ProductCategoryGroupModel,
											as: 'productCategoryGroup',
											required: true,
											attributes: [],
										},
									],
								},
							],
						},
					],
				},
			],
			group: [
				'productVariant.product.productCategory.productCategoryGroup.id',
				'productVariant.product.productCategory.productCategoryGroup.name',
			],
			order: [
				[
					sequelize.literal(`
						SUM(
							CASE
								WHEN "billing"."discountType" = 'PERCENTAGE'
									THEN "BillingItemModel"."totalPrice" * (1 - "billing"."discount" / 100)
								WHEN "billing"."discountType" = 'FIXED'
									THEN "BillingItemModel"."totalPrice" * (1 - "billing"."discount" / NULLIF("billing"."subtotal", 0))
								ELSE "BillingItemModel"."totalPrice"
							END
						)
					`),
					'DESC',
				],
			],
			raw: true,
		});

		return result;
	};

	private getSalesByProductCategory = async (
		currency: string,
		startDate: Date,
		endDate: Date,
	) => {
		const result = await this.billingItemModel.findAll({
			where: {
				currency,
				productVariantId: { [Op.ne]: FLETE },
			},
			attributes: [
				[
					sequelize.col(
						'productVariant.product.productCategory.productCategoryGroup.id',
					),
					'groupId',
				],
				[
					sequelize.col(
						'productVariant.product.productCategory.productCategoryGroup.name',
					),
					'groupName',
				],
				[
					sequelize.col('productVariant.product.productCategory.id'),
					'categoryId',
				],
				[
					sequelize.col('productVariant.product.productCategory.name'),
					'categoryName',
				],
				[
					sequelize.fn('SUM', sequelize.col('BillingItemModel.quantity')),
					'totalQuantity',
				],
				[
					sequelize.literal(`
						SUM(
							CASE
								WHEN "billing"."discountType" = 'PERCENTAGE'
									THEN "BillingItemModel"."totalPrice" * (1 - "billing"."discount" / 100)
								WHEN "billing"."discountType" = 'FIXED'
									THEN "BillingItemModel"."totalPrice" * (1 - "billing"."discount" / NULLIF("billing"."subtotal", 0))
								ELSE "BillingItemModel"."totalPrice"
							END
						)
					`),
					'totalRevenue',
				],
			],
			include: [
				{
					model: BillingModel,
					as: 'billing',
					attributes: [],
					where: {
						effectiveDate: { [Op.between]: [startDate, endDate] },
						status: BillingStatus.PAID,
					},
				},
				{
					model: ProductVariantModel,
					as: 'productVariant',
					required: true,
					attributes: [],
					include: [
						{
							model: ProductModel,
							as: 'product',
							required: true,
							attributes: [],
							include: [
								{
									model: ProductCategoryModel,
									as: 'productCategory',
									required: true,
									attributes: [],
									include: [
										{
											model: ProductCategoryGroupModel,
											as: 'productCategoryGroup',
											required: true,
											attributes: [],
										},
									],
								},
							],
						},
					],
				},
			],
			group: [
				'productVariant.product.productCategory.productCategoryGroup.id',
				'productVariant.product.productCategory.productCategoryGroup.name',
				'productVariant.product.productCategory.id',
				'productVariant.product.productCategory.name',
			],
			order: [
				[
					sequelize.col(
						'productVariant.product.productCategory.productCategoryGroup.name',
					),
					'ASC',
				],
				[
					sequelize.literal(`
						SUM(
							CASE
								WHEN "billing"."discountType" = 'PERCENTAGE'
									THEN "BillingItemModel"."totalPrice" * (1 - "billing"."discount" / 100)
								WHEN "billing"."discountType" = 'FIXED'
									THEN "BillingItemModel"."totalPrice" * (1 - "billing"."discount" / NULLIF("billing"."subtotal", 0))
								ELSE "BillingItemModel"."totalPrice"
							END
						)
					`),
					'DESC',
				],
			],
			raw: true,
		});

		return result;
	};

	private getAllProductsSales = async (
		currency: string,
		startDate: Date,
		endDate: Date,
	) => {
		const products = await sequelize.query<{
			productVariantId: string;
			productName: string;
			baseProductName: string;
			categoryName: string;
			groupName: string;
			totalQuantity: string;
			avgUnitPrice: string;
			pricePvp: string;
			priceDis: string;
			totalRevenue: string;
		}>(
			`
				WITH sales AS (
					SELECT
						bi."productVariantId" AS "productVariantId",
						SUM(bi.quantity) AS "totalQuantity",
						SUM(bi."totalPrice") AS "totalRevenue"
					FROM billing_item bi
					INNER JOIN billing b ON b.id = bi."billingId"
					WHERE bi.currency = :currency
						AND bi."deletedDate" IS NULL
						AND b."effectiveDate" BETWEEN :startDate AND :endDate
						AND b.status = :status
						AND b."deletedDate" IS NULL
					GROUP BY bi."productVariantId"
				),
				catalog_prices AS (
					SELECT
						sipv."productVariantId" AS "productVariantId",
						AVG(CASE WHEN pt.code = 'PVP' THEN sip.price END) AS "pricePvp",
						AVG(CASE WHEN pt.code = 'DIS' THEN sip.price END) AS "priceDis"
					FROM stock_item_product_variant sipv
					INNER JOIN stock_item si ON si.id = sipv."stockItemId"
						AND si.currency = :currency
						AND si."deletedDate" IS NULL
					INNER JOIN stock_item_price sip ON sip."stockItemId" = si.id
					INNER JOIN price_type pt ON pt.id = sip."priceTypeId"
					GROUP BY sipv."productVariantId"
				)
				SELECT
					pv.id AS "productVariantId",
					pv.name AS "productName",
					p.name AS "baseProductName",
					pc.name AS "categoryName",
					COALESCE(pcg.name, '--') AS "groupName",
					COALESCE(s."totalQuantity", 0) AS "totalQuantity",
					CASE
						WHEN COALESCE(s."totalQuantity", 0) = 0 THEN 0
						ELSE s."totalRevenue" / s."totalQuantity"
					END AS "avgUnitPrice",
					COALESCE(cp."pricePvp", 0) AS "pricePvp",
					COALESCE(cp."priceDis", 0) AS "priceDis",
					COALESCE(s."totalRevenue", 0) AS "totalRevenue"
				FROM product_variant pv
				INNER JOIN product p ON p.id = pv."productId" AND p."deletedDate" IS NULL
				INNER JOIN product_category pc ON pc.id = p."productCategoryId" AND pc."deletedDate" IS NULL
				LEFT JOIN product_category_group pcg ON pcg.id = pc."productCategoryGroupId" AND pcg."deletedDate" IS NULL
				LEFT JOIN sales s ON s."productVariantId" = pv.id
				LEFT JOIN catalog_prices cp ON cp."productVariantId" = pv.id
				WHERE pv."deletedDate" IS NULL
					AND pv.id NOT IN (:flete, :descuento)
				ORDER BY "totalQuantity" DESC, pv.name ASC
			`,
			{
				replacements: {
					currency,
					startDate,
					endDate,
					status: BillingStatus.PAID,
					flete: FLETE,
					descuento: DESCUENTO,
				},
				type: QueryTypes.SELECT,
			},
		);

		return products.map(product => ({
			...product,
			totalQuantity: parseFloat(product.totalQuantity),
			avgUnitPrice: parseFloat(product.avgUnitPrice),
			pricePvp: parseFloat(product.pricePvp),
			priceDis: parseFloat(product.priceDis),
			totalRevenue: parseFloat(product.totalRevenue),
		}));
	};

	private getComparisonWithPreviousPeriod = async (
		currency: string,
		startDate: Date,
		endDate: Date,
	) => {
		const periodDuration = endDate.getTime() - startDate.getTime();
		const previousStartDate = new Date(startDate.getTime() - periodDuration);
		const previousEndDate = new Date(startDate.getTime() - 1);

		const [currentPeriod, previousPeriod] = await Promise.all([
			this.getSalesSummary(currency, startDate, endDate),
			this.getSalesSummary(currency, previousStartDate, previousEndDate),
		]);

		const currentData = currentPeriod as unknown as Record<string, unknown>;
		const previousData = previousPeriod as unknown as Record<string, unknown>;

		const currentRevenue = parseFloat(currentData?.totalRevenue as string) || 0;
		const previousRevenue =
			parseFloat(previousData?.totalRevenue as string) || 0;
		const currentQuantity =
			parseFloat(currentData?.totalQuantity as string) || 0;
		const previousQuantity =
			parseFloat(previousData?.totalQuantity as string) || 0;

		const revenueGrowth =
			previousRevenue > 0
				? ((currentRevenue - previousRevenue) / previousRevenue) * 100
				: 0;
		const quantityGrowth =
			previousQuantity > 0
				? ((currentQuantity - previousQuantity) / previousQuantity) * 100
				: 0;

		return {
			current: {
				revenue: currentRevenue,
				quantity: currentQuantity,
				orders: parseFloat(currentData?.totalOrders as string) || 0,
			},
			previous: {
				revenue: previousRevenue,
				quantity: previousQuantity,
				orders: parseFloat(previousData?.totalOrders as string) || 0,
			},
			growth: {
				revenue: revenueGrowth,
				quantity: quantityGrowth,
			},
		};
	};
}
