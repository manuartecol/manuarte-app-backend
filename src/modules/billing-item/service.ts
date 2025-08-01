import { Op, Transaction } from 'sequelize';
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

	getMonthlySales = async () => {
		try {
			const currentYear = new Date().getFullYear();
			const startOfYear = new Date(currentYear, 0, 1);
			const endOfYear = new Date(currentYear + 1, 0, 0);

			const rawSales = await BillingModel.findAll({
				attributes: [
					[
						sequelize.fn(
							'DATE_PART',
							'month',
							sequelize.col('billingItems.createdDate'),
						),
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
					createdDate: {
						[Op.between]: [startOfYear, endOfYear],
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
					sequelize.fn(
						'DATE_PART',
						'month',
						sequelize.col('billingItems.createdDate'),
					),
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

			return salesWithMonthNames;
		} catch (error) {
			console.error('ServiceError obteniendo ventas por mes: ', error);
			throw error;
		}
	};

	getTopSalesProducts = async (offset: number = 0) => {
		try {
			const now = new Date();
			const currentMonth = now.getMonth();
			const currentYear = now.getFullYear();

			const targetDate = new Date(currentYear, currentMonth + offset, 1);
			const targetYear = targetDate.getFullYear();
			const targetMonth = targetDate.getMonth();

			const topCOP = await this.getGroupByCurrencyAndProductCategoryGroup(
				'COP',
				targetYear,
				targetMonth,
			);

			const topUSD = await this.getGroupByCurrencyAndProductCategoryGroup(
				'USD',
				targetYear,
				targetMonth,
			);

			const formatResults = (
				data: BillingItemModel[],
			): {
				productCategoryGroupId: string;
				productCategoryGroupName: string;
				totalQuantity: number;
			}[] =>
				data.map(item => ({
					productCategoryGroupId: item.dataValues.productCategoryGroupId,
					productCategoryGroupName: item.dataValues.productCategoryGroupName,
					totalQuantity: parseFloat(item.dataValues.totalQuantity),
				}));

			return {
				month: monthNames[targetMonth],
				year: targetYear,
				topCOP: topCOP && formatResults(topCOP),
				topUSD: topUSD && formatResults(topUSD),
			};
		} catch (error) {
			console.error(error);
			throw error;
		}
	};

	private getGroupByCurrencyAndProductCategoryGroup = async (
		currency: string,
		targetYear: number,
		targetMonth: number,
	) => {
		try {
			const startOfMonth = new Date(targetYear, targetMonth, 1);
			const endOfMonth = new Date(targetYear, targetMonth + 1, 0);

			const result = await this.billingItemModel.findAll({
				where: {
					currency,
					name: {
						[Op.notILike]: '%flete%',
					},
				},
				attributes: [
					'currency',
					[
						sequelize.col(
							'productVariant.product.productCategory.productCategoryGroup.id',
						),
						'productCategoryGroupId',
					],
					[
						sequelize.col(
							'productVariant.product.productCategory.productCategoryGroup.name',
						),
						'productCategoryGroupName',
					],
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
								[Op.between]: [startOfMonth, endOfMonth],
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
					'currency',
					'productVariant.product.productCategory.productCategoryGroup.id',
					'productVariant.product.productCategory.productCategoryGroup.name',
				],
				order: [
					[
						sequelize.fn('SUM', sequelize.col('BillingItemModel.quantity')),
						'DESC',
					],
				],
				limit: 5,
			});

			return result;
		} catch (error) {
			console.error(error);
			throw error;
		}
	};
}
