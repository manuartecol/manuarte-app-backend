import { col, fn, Op, where } from 'sequelize';
import { sequelize } from '../../config/database';
import { AddressModel } from '../address/model';
import { CityModel } from '../city/model';
import { CountryModel } from '../country/model';
import { CustomerModel } from '../customer/model';
import { CustomerService } from '../customer/service';
import { CreateCustomerDto, UpdateCustomerDto } from '../customer/types';
import { PersonModel } from '../person/model';
import { PriceTypeModel } from '../price-type/model';
import { QuoteItemModel } from '../quote-item/model';
import { QuoteItemService } from '../quote-item/service';
import { RegionModel } from '../region/model';
import { StockItemModel } from '../stock-item/model';
import { StockItemService } from '../stock-item/service';
import { QuoteModel } from './model';
import { CreateQuoteDto, QuoteFilters, UpdateQuoteDto } from './types';
import { endOfDay, parseISO, startOfDay } from 'date-fns';
import { ShopModel } from '../shop/model';
import { StockModel } from '../stock/model';

export class QuoteService {
	private quoteModel;
	private quoteItemService;
	private customerService;
	private stockItemService;

	constructor(quoteModel: typeof QuoteModel) {
		this.quoteModel = quoteModel;
		this.quoteItemService = new QuoteItemService(QuoteItemModel);
		this.customerService = new CustomerService(CustomerModel);
		this.stockItemService = new StockItemService(StockItemModel);
	}

	getAll = async (
		shopId: string,
		page: number = 1,
		pageSize: number = 30,
		filters: QuoteFilters = {},
	) => {
		try {
			const offset = (page - 1) * pageSize;

			const quoteWhere: Record<string, unknown> = {};
			if (filters.serialNumber) {
				quoteWhere.serialNumber = { [Op.iLike]: `%${filters.serialNumber}%` };
			}
			if (filters.status) {
				quoteWhere.status = filters.status;
			}
			if (filters.dateStart && filters.dateEnd) {
				const start = startOfDay(parseISO(filters.dateStart));
				const end = endOfDay(parseISO(filters.dateEnd));

				quoteWhere.createdDate = {
					[Op.between]: [start, end],
				};
			}

			const personWhere: Record<string, unknown> = {};
			if (filters.customerName) {
				const normalizedSearch = filters.customerName
					.normalize('NFD')
					.replace(/[\u0300-\u036f]/g, '')
					.toLowerCase();

				personWhere.fullName = where(
					fn('unaccent', fn('lower', col('fullName'))),
					Op.iLike,
					`%${normalizedSearch}%`,
				);
			}

			const { rows: quotes, count: total } =
				await this.quoteModel.findAndCountAll({
					where: { shopId, ...quoteWhere },
					attributes: [
						'id',
						'serialNumber',
						'status',
						'customerId',
						[sequelize.col('customer.person.fullName'), 'customerName'],
						[sequelize.col('priceType.code'), 'priceType'],
						'createdDate',
						'updatedDate',
						'shopId',
					],
					include: [
						{
							model: CustomerModel,
							as: 'customer',
							attributes: [],
							required: Boolean(Object.keys(personWhere).length),
							include: [
								{
									model: PersonModel,
									as: 'person',
									attributes: [],
									required: Boolean(Object.keys(personWhere).length),
									where: Object.keys(personWhere).length
										? personWhere
										: undefined,
									paranoid: false,
								},
							],
							paranoid: false,
						},
						{
							model: PriceTypeModel,
							as: 'priceType',
							attributes: [],
						},
					],
					order: [['createdDate', 'DESC']],
					limit: pageSize,
					offset,
				});

			return {
				status: 200,
				data: {
					quotes,
					total,
					page,
					pageSize,
					totalPages: Math.ceil(total / pageSize),
				},
			};
		} catch (error) {
			console.error('Error obteniendo cotizaciones');
			throw error;
		}
	};

	getOne = async (serialNumber: string) => {
		try {
			const quote = await this.quoteModel.findOne({
				where: { serialNumber },
				attributes: [
					'id',
					'shopId',
					'serialNumber',
					'status',
					'currency',
					'discountType',
					'discount',
					'shipping',
					'customerId',
					[sequelize.col('customer.person.id'), 'personId'],
					[sequelize.col('customer.person.fullName'), 'fullName'],
					[sequelize.col('customer.person.dni'), 'dni'],
					[sequelize.col('customer.email'), 'email'],
					[sequelize.col('customer.phoneNumber'), 'phoneNumber'],
					[sequelize.col('customer.address.location'), 'location'],
					[sequelize.col('customer.city'), 'city'],
					[sequelize.col('customer.address.cityId'), 'cityId'],
					[sequelize.col('customer.address.city.name'), 'cityName'],
					[sequelize.col('customer.address.city.region.name'), 'regionName'],
					[
						sequelize.col('customer.address.city.region.country.isoCode'),
						'countryIsoCode',
					],
					[
						sequelize.col('customer.address.city.region.country.callingCode'),
						'callingCode',
					],
					[sequelize.col('priceType.code'), 'priceTypeCode'],
					[sequelize.col('shop.stock.id'), 'stockId'],
					'createdDate',
					'updatedDate',
				],
				include: [
					{
						model: CustomerModel,
						as: 'customer',
						attributes: [],
						include: [
							{
								model: PersonModel,
								as: 'person',
								attributes: [],
								paranoid: false,
							},
							{
								model: AddressModel,
								as: 'address',
								attributes: [],
								include: [
									{
										model: CityModel,
										as: 'city',
										attributes: [],
										include: [
											{
												model: RegionModel,
												as: 'region',
												attributes: [],
												include: [
													{
														model: CountryModel,
														as: 'country',
														attributes: [],
													},
												],
											},
										],
									},
								],
							},
						],
						paranoid: false,
					},
					{
						model: QuoteItemModel,
						as: 'quoteItems',
						required: true,
						attributes: [
							'id',
							'productVariantId',
							'name',
							'quantity',
							'price',
							'totalPrice',
							// Obtener stockItemId del stock de la tienda
							[
								sequelize.literal(`(
                SELECT si.id
                FROM stock_item_product_variant sipv
                INNER JOIN stock_item si ON sipv."stockItemId" = si.id
                INNER JOIN stock s ON si."stockId" = s.id
                WHERE sipv."productVariantId" = "quoteItems"."productVariantId"
                AND s."shopId" = "QuoteModel"."shopId"
                LIMIT 1
            )`),
								'stockItemId',
							],
							// Obtener precio PVP
							[
								sequelize.literal(`(
                SELECT sip.price
                FROM stock_item_product_variant sipv
                INNER JOIN stock_item si ON sipv."stockItemId" = si.id
                INNER JOIN stock s ON si."stockId" = s.id
                INNER JOIN stock_item_price sip ON sip."stockItemId" = si.id
                INNER JOIN price_type pt ON sip."priceTypeId" = pt.id
                WHERE sipv."productVariantId" = "quoteItems"."productVariantId"
                AND s."shopId" = "QuoteModel"."shopId"
                AND pt.code = 'PVP'
                LIMIT 1
            )`),
								'pricePvp',
							],
							// Obtener precio DIS
							[
								sequelize.literal(`(
                SELECT sip.price
                FROM stock_item_product_variant sipv
                INNER JOIN stock_item si ON sipv."stockItemId" = si.id
                INNER JOIN stock s ON si."stockId" = s.id
                INNER JOIN stock_item_price sip ON sip."stockItemId" = si.id
                INNER JOIN price_type pt ON sip."priceTypeId" = pt.id
                WHERE sipv."productVariantId" = "quoteItems"."productVariantId"
                AND s."shopId" = "QuoteModel"."shopId"
                AND pt.code = 'DIS'
                LIMIT 1
            )`),
								'priceDis',
							],
						],
					},
					{
						model: PriceTypeModel,
						as: 'priceType',
						attributes: [],
						required: true,
					},
					{
						model: ShopModel,
						as: 'shop',
						required: true,
						attributes: [],
						include: [
							{
								model: StockModel,
								as: 'stock',
								required: true,
								attributes: [],
							},
						],
					},
				],
			});
			if (!quote)
				return { status: 404, message: 'No fue posible obtener la cotización' };

			const formattedQuote = {
				...quote.toJSON(),
				items: quote.get('quoteItems'),
			};
			delete formattedQuote.quoteItems;

			return {
				status: 200,
				quote: formattedQuote,
			};
		} catch (error) {
			console.error('Error obteniendo cotización');
			throw error;
		}
	};

	create = async ({
		quoteData,
		customerData,
	}: {
		quoteData: CreateQuoteDto;
		customerData: CreateCustomerDto;
	}) => {
		const transaction = await sequelize.transaction();
		try {
			if (quoteData?.items?.length === 0) {
				throw new Error(
					'Es necesario al menos 1 item para crear una cotización',
				);
			}

			let customerId = customerData?.customerId ?? null;
			if (
				customerData?.fullName &&
				customerData?.dni &&
				!customerData?.customerId
			) {
				const result = await this.customerService.create(
					customerData,
					transaction,
				);
				customerId = result.customer.id;
			} else if (customerData?.personId) {
				await this.customerService.update(customerData, transaction);
			}

			const {
				status,
				discountType,
				discount,
				shipping,
				shopId,
				currency,
				requestedBy,
				priceType,
			} = quoteData;

			// Obtener tipo de precio (default PVP)
			const priceTypeCode = priceType || 'PVP';
			const priceTypeRecord = await PriceTypeModel.findOne({
				where: { code: priceTypeCode, isActive: true },
				transaction,
			});

			if (!priceTypeRecord) {
				throw new Error(
					`Tipo de precio ${priceTypeCode} no encontrado o inactivo`,
				);
			}

			const newQuote = this.quoteModel.build({
				customerId,
				shopId,
				status,
				currency,
				discountType: discount > 0 ? discountType : null,
				discount,
				shipping,
				priceTypeId: priceTypeRecord.id,
				createdBy: requestedBy,
			});
			await newQuote.generateSerialNumber();
			await newQuote.save({ transaction });

			// Crear items de cotización
			for (const item of quoteData.items) {
				await this.quoteItemService.create(
					{
						...item,
						id: undefined,
						productVariantId: item?.productVariantId,
						quoteId: newQuote.id,
						price: item.price,
						totalPrice: item.price && item.price * item.quantity,
					},
					transaction,
				);
			}

			await transaction.commit();

			return {
				status: 201,
				newQuote: {
					id: newQuote.id,
					serialNumber: newQuote.serialNumber,
					status,
					customerId,
					customerName: customerData?.fullName ?? null,
					shopId,
					createdDate: newQuote.createdDate,
				},
			};
		} catch (error) {
			await transaction.rollback();
			console.error('Error creando cotización');
			throw error;
		}
	};

	update = async ({
		quoteData,
		customerData,
	}: {
		quoteData: UpdateQuoteDto;
		customerData: UpdateCustomerDto;
	}) => {
		const transaction = await sequelize.transaction();
		try {
			let customerId = null;

			// Si se envía info de cliente
			if (customerData?.fullName && customerData?.dni) {
				// Si no existe, créarlo
				if (!customerData?.customerId) {
					const result = await this.customerService.create(
						customerData,
						transaction,
					);
					customerId = result.customer.id;
				} else {
					// Si existe, actualízarlo
					await this.customerService.update(customerData, transaction);
					customerId = customerData.customerId;
				}
			} else if (customerData?.customerId) {
				// Solo asignar el customerId si se envía
				customerId = customerData.customerId;
			}
			// Si no se envía info del cliente, queda como consumidor final (customerId = null)

			const quoteToUpdate = await this.quoteModel.findByPk(quoteData.id, {
				transaction,
			});
			if (!quoteToUpdate) {
				throw new Error('Cotización no encontrada');
			}

			// Si se proporciona un tipo de precio, validarlo
			let priceTypeId = quoteToUpdate.priceTypeId;

			if (quoteData.priceType) {
				const priceTypeRecord = await PriceTypeModel.findOne({
					where: { code: quoteData.priceType, isActive: true },
					transaction,
				});

				if (!priceTypeRecord) {
					throw new Error(
						`Tipo de precio ${quoteData.priceType} no encontrado o inactivo`,
					);
				}

				priceTypeId = priceTypeRecord.id;
			}

			await quoteToUpdate.update(
				{
					customerId,
					status: quoteData?.status,
					currency: quoteData?.currency,
					discountType:
						quoteData?.discount > 0 ? quoteData?.discountType : null,
					discount: quoteData?.discount || 0,
					shipping: quoteData?.shipping,
					priceTypeId,
					requestedBy: quoteData?.requestedBy,
				},
				{ transaction },
			);

			// Actualizar items de cotización
			if (quoteData?.items?.length > 0) {
				await this.quoteItemService.updateItems(
					quoteData?.items,
					quoteData.id,
					transaction,
				);
			} else {
				throw new Error('La cotización debe tener al menos 1 item');
			}

			await transaction.commit();

			return {
				status: 200,
				updatedQuote: {
					id: quoteData?.id,
					serialNumber: quoteToUpdate?.serialNumber,
					status: quoteData?.status,
					customerId,
					customerName: customerData?.fullName,
					shopId: quoteData?.shopId,
					createdDate: quoteToUpdate?.createdDate,
				},
			};
		} catch (error) {
			await transaction.rollback();
			console.error('Error actualizando cotización');
			throw error;
		}
	};

	delete = async (id: string) => {
		try {
			const result = await this.quoteModel.destroy({ where: { id } });

			if (result === 1) {
				return { status: 200, message: 'Cotización eliminada con éxito' };
			}

			return { status: 404, message: 'Cotización no encontrada' };
		} catch (error) {
			console.error('Error eliminando cotización');
			throw error;
		}
	};
}
