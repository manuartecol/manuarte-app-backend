import { col, fn, QueryTypes, Transaction, where } from 'sequelize';
import { sequelize } from '../../config/database';
import { CustomError } from '../../middlewares/errorHandler';
import { AddressModel } from '../address/model';
import { PersonModel } from '../person/model';
import { CustomerModel } from './model';
import { CountryCount, CreateCustomerDto, UpdateCustomerDto } from './types';
import { Op } from 'sequelize';
import { normalizeSearch } from '../product-variant/helpers/search';
import { BillingModel } from '../billing/model';
import { BillingStatus, Payment } from '../billing/types';
import { QuoteModel } from '../quote/model';
import { QuoteStatus } from '../quote/types';
import { ShopModel } from '../shop/model';
import { BillingItemModel } from '../billing-item/model';
import { CityModel } from '../city/model';
import { RegionModel } from '../region/model';
import { CountryModel } from '../country/model';
import { CityService } from '../city/service';
import { BillingPaymentModel } from '../billing-payment/model';

interface CustomerFilters {
	dni?: string;
	fullName?: string;
	email?: string;
	phoneNumber?: string;
	cityName?: string;
}

export class CustomerService {
	private customerModel;
	private personModel;
	private addressModel;
	private cityService;

	constructor(customerModel: typeof CustomerModel) {
		this.customerModel = customerModel;
		this.personModel = PersonModel;
		this.addressModel = AddressModel;
		this.cityService = new CityService(CityModel);
	}

	getAll = async (
		page: number = 1,
		pageSize: number = 30,
		filters: CustomerFilters = {},
		isoCode?: string,
	) => {
		try {
			if (isoCode && typeof isoCode !== 'string') {
				throw new Error('Invalid isoCode');
			}

			const offset = (page - 1) * pageSize;
			const filterByCountry = Boolean(isoCode);

			const customerWhere: Record<string, unknown> = {};
			if (filters.email) {
				customerWhere.email = { [Op.iLike]: `%${filters.email}%` };
			}
			if (filters.phoneNumber) {
				customerWhere.phoneNumber = { [Op.iLike]: `%${filters.phoneNumber}%` };
			}

			const personWhere: Record<string, unknown> = {};
			if (filters.dni) {
				personWhere.dni = { [Op.iLike]: `%${filters.dni}%` };
			}
			if (filters.fullName) {
				const normalizedSearch = filters.fullName
					.normalize('NFD')
					.replace(/[\u0300-\u036f]/g, '')
					.toLowerCase();

				personWhere.fullName = where(
					fn('unaccent', fn('lower', col('fullName'))),
					Op.iLike,
					`%${normalizedSearch}%`,
				);
			}

			const cityWhere: Record<string, unknown> = {};
			if (filters.cityName) {
				const normalizedSearch = filters.cityName
					.normalize('NFD')
					.replace(/[\u0300-\u036f]/g, '')
					.toLowerCase();

				cityWhere.name = where(
					fn('unaccent', fn('lower', col('name'))),
					Op.iLike,
					`%${normalizedSearch}%`,
				);
			}

			const { rows: customers, count: total } =
				await this.customerModel.findAndCountAll({
					where: customerWhere,
					attributes: [
						'id',
						'personId',
						'email',
						'phoneNumber',
						'createdDate',
						'city',
						[sequelize.col('person.fullName'), 'fullName'],
						[sequelize.col('person.dni'), 'dni'],
						[sequelize.col('address.location'), 'location'],
						[sequelize.col('address.cityId'), 'cityId'],
						[sequelize.col('address.city.name'), 'cityName'],
						[sequelize.col('address.city.region.name'), 'regionName'],
						[
							sequelize.col('address.city.region.country.isoCode'),
							'countryIsoCode',
						],
						[sequelize.col('address.city.region.country.currency'), 'currency'],
					],
					include: [
						{
							model: this.personModel,
							as: 'person',
							attributes: [],
							where: Object.keys(personWhere).length ? personWhere : undefined,
						},
						{
							model: this.addressModel,
							as: 'address',
							attributes: [],
							required: true,
							include: [
								{
									model: CityModel,
									as: 'city',
									attributes: [],
									required: true,
									where: Object.keys(cityWhere).length ? cityWhere : undefined,
									include: [
										{
											model: RegionModel,
											as: 'region',
											attributes: [],
											required: filterByCountry,
											include: [
												{
													model: CountryModel,
													as: 'country',
													attributes: [],
													required: filterByCountry,
													where: filterByCountry ? { isoCode } : undefined,
												},
											],
										},
									],
								},
							],
						},
					],
					order: [['createdDate', 'DESC']],
					limit: pageSize,
					offset,
				});

			return {
				customers,
				total,
				page,
				pageSize,
				totalPages: Math.ceil(total / pageSize),
			};
		} catch (error) {
			console.error('ServiceError obteniendo clientes: ', error);
			throw error;
		}
	};

	create = async (
		customerData: CreateCustomerDto,
		transaction?: Transaction,
	) => {
		const localTransaction = transaction || (await sequelize.transaction());
		try {
			const { fullName, dni, ...restCustomer } = customerData;

			if (!fullName || !dni) {
				throw new Error('El nombre y el número de documento son requeridos');
			}

			const person = await this.personModel.create(
				{ fullName, dni },
				{ transaction: localTransaction },
			);

			const { email, phoneNumber } = restCustomer;

			if (!phoneNumber) {
				throw new Error('El número de teléfono es requerido');
			}

			const customer = await this.customerModel.create(
				{
					email: email?.length > 0 ? email : undefined,
					phoneNumber,
					personId: person.id,
				},
				{ transaction: localTransaction },
			);

			if (!restCustomer?.location && !restCustomer?.cityId) {
				throw new Error('La dirección y la ciudad son requeridas');
			}

			if (restCustomer?.location) {
				await this.addressModel.create(
					{
						location: restCustomer?.location,
						customerId: customer.id,
						cityId: restCustomer?.cityId,
					},
					{ transaction: localTransaction },
				);
			}

			const cityInfo = await this.cityService.getById(restCustomer?.cityId);

			if (!transaction) await localTransaction.commit();

			return {
				status: 201,
				customer: {
					id: customer.id,
					personId: person.id,
					cityName: cityInfo?.dataValues?.name,
					regionName: cityInfo?.dataValues?.regionName,
					countryIsoCode: cityInfo?.dataValues?.countryIsoCode,
					...customerData,
				},
			};
		} catch (error) {
			if (!transaction) await localTransaction.rollback();
			console.error('***************** Error creando customer: ');
			if (
				error instanceof Error &&
				(error as CustomError).parent?.code === '23505'
			) {
				error.message = 'Ya existe un cliente con este número de documento';
			}
			throw error;
		}
	};

	update = async (
		customerData: UpdateCustomerDto,
		transaction?: Transaction,
	) => {
		const localTransaction = transaction || (await sequelize.transaction());
		try {
			const { personId, ...rest } = customerData;

			const personToUpdate = await this.personModel.findByPk(personId, {
				transaction: localTransaction,
			});
			const customerToUpdate = await this.customerModel.findOne({
				where: { personId },
				transaction: localTransaction,
			});
			if (!personToUpdate || !customerToUpdate) {
				throw new Error('Usuario no encontrado');
			}

			const { fullName, dni, email, phoneNumber, location, cityId } = rest;

			if (!fullName || !dni) {
				throw new Error('El nombre y el número de documento son requeridos');
			}

			if (!phoneNumber) {
				throw new Error('El número de teléfono es requerido');
			}

			if (!location && !cityId) {
				throw new Error('La dirección y la ciudad son requeridas');
			}

			await personToUpdate.update(
				{ fullName, dni },
				{ transaction: localTransaction },
			);
			await customerToUpdate.update(
				{
					email: email?.length > 0 ? email : undefined,
					phoneNumber,
				},
				{ transaction: localTransaction },
			);

			const [updatedCount] = await this.addressModel.update(
				{ location, cityId },
				{
					where: { customerId: customerToUpdate.id },
					transaction: localTransaction,
				},
			);

			if (updatedCount === 0) {
				await this.addressModel.create(
					{
						location,
						customerId: customerToUpdate.id,
						cityId,
					},
					{ transaction: localTransaction },
				);
			}

			const cityInfo = await this.cityService.getById(cityId);

			if (!transaction) await localTransaction.commit();

			return {
				status: 200,
				updatedCustomer: {
					...customerData,
					cityName: cityInfo?.dataValues?.name,
					regionName: cityInfo?.dataValues?.regionName,
					countryIsoCode: cityInfo?.dataValues?.countryIsoCode,
					id: customerToUpdate.id,
				},
			};
		} catch (error) {
			if (!transaction) await localTransaction.rollback();
			console.error('***************** Error editando customer: ');
			if (
				error instanceof Error &&
				(error as CustomError).parent?.code === '23505'
			) {
				error.message = 'Ya existe un cliente con este número de documento';
			}
			throw error;
		}
	};

	delete = async (personId: string) => {
		const transaction = await sequelize.transaction();
		try {
			await this.personModel.destroy({ where: { id: personId }, transaction });

			const customerDeleted = await this.customerModel.destroy({
				where: { personId },
				transaction,
			});

			if (customerDeleted === 1) {
				await transaction.commit();
				return { status: 200, message: 'Cliente eliminado con éxito' };
			}

			throw new Error('Usuario no encontrado');
		} catch (error) {
			await transaction.rollback();
			console.error(error);
			throw error;
		}
	};

	getById = async (id: string) => {
		try {
			const customer = await this.customerModel.findByPk(id, {
				attributes: {
					include: [
						[sequelize.col('person.fullName'), 'fullName'],
						[sequelize.col('person.dni'), 'dni'],
					],
				},
				include: [
					{
						model: this.personModel,
						as: 'person',
						attributes: [],
					},
				],
			});

			return customer;
		} catch (error) {
			console.error(error);
			throw error;
		}
	};

	getStats = async (id: string) => {
		try {
			const customerInfo = await this.customerModel.findOne({
				where: { id },
				attributes: [
					'id',
					'personId',
					'email',
					'phoneNumber',
					'createdDate',
					'city',
					[sequelize.col('person.fullName'), 'fullName'],
					[sequelize.col('person.dni'), 'dni'],
					[sequelize.col('address.location'), 'location'],
					[sequelize.col('address.cityId'), 'cityId'],
					[sequelize.col('address.city.name'), 'cityName'],
					[sequelize.col('address.city.region.name'), 'regionName'],
					[
						sequelize.col('address.city.region.country.isoCode'),
						'countryIsoCode',
					],
					[sequelize.col('address.city.region.country.currency'), 'currency'],
				],
				include: [
					{
						model: this.personModel,
						as: 'person',
						attributes: [],
					},
					{
						model: this.addressModel,
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
			});

			const billings = await BillingModel.findAndCountAll({
				where: { customerId: id, status: BillingStatus.PAID },
				attributes: [
					'serialNumber',
					'discount',
					'shipping',
					[
						sequelize.literal(`(
							SELECT COALESCE(SUM("totalPrice"::numeric), 0)
							FROM "billing_item" AS bi
							WHERE 
								bi."billingId" = "BillingModel"."id" 
								AND bi."name" NOT ILIKE '%flete%'
						)`),
						'subtotal',
					],
					'createdDate',
				],
				include: [
					{
						model: BillingPaymentModel,
						as: 'payments',
						attributes: ['paymentMethod'],
					},
				],
				order: [['createdDate', 'DESC']],
				distinct: true,
			});

			const billingsWithPaymentMethods = billings.rows
				.map(billing => {
					const billingJson = billing.toJSON();

					return {
						...billingJson,
						paymentMethods:
							billingJson.payments?.map((p: Payment) => p.paymentMethod) || [],
					};
				})
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				.map(({ payments, ...rest }) => rest);

			const [result] = await sequelize.query<{
				totalSpent: string | null;
			}>(
				`
				SELECT SUM("totalPrice") AS "totalSpent"
				FROM "billing_item" bi
				INNER JOIN "billing" b ON b.id = bi."billingId"
				WHERE 
					b."customerId" = :customerId 
					AND b."status" = 'PAID' 
					AND bi."name" NOT ILIKE '%flete%'
				`,
				{
					replacements: { customerId: id },
					type: QueryTypes.SELECT,
				},
			);
			const totalSpent = result.totalSpent || 0;

			const topProducts = await sequelize.query<{
				productVariantId: string;
				name: string;
				totalQty: number;
			}>(
				`
				SELECT 
					bi."productVariantId",
					MAX(bi."name") AS "name",
					SUM(bi."quantity") AS "totalQty"
				FROM "billing_item" bi
				INNER JOIN "billing" b ON b.id = bi."billingId"
				WHERE 
					b."customerId" = :customerId 
					AND b."status" = 'PAID' 
					AND bi."name" NOT ILIKE '%flete%'
				GROUP BY bi."productVariantId"
				ORDER BY "totalQty" DESC
				LIMIT 5
				`,
				{
					replacements: { customerId: id },
					type: QueryTypes.SELECT,
				},
			);

			const quotes = await QuoteModel.findAndCountAll({
				where: { customerId: id, status: QuoteStatus.PENDING },
				attributes: [
					'serialNumber',
					'shipping',
					[
						sequelize.literal(`(
							SELECT COALESCE(SUM("totalPrice"::numeric), 0)
							FROM "quote_item" AS qi
							WHERE 
								qi."quoteId" = "QuoteModel"."id" 
								AND qi."name" NOT ILIKE '%flete%'
						)`),
						'subtotal',
					],
					'createdDate',
				],
				order: [['createdDate', 'DESC']],
			});

			return {
				status: 200,
				customer: {
					info: customerInfo,
					billings: { rows: billingsWithPaymentMethods, count: billings.count },
					totalSpent,
					topProducts,
					quotes,
				},
			};
		} catch (error) {
			console.error('Error getting customer history: ', error);
			throw error;
		}
	};

	getTop = async (
		page: number = 1,
		pageSize: number = 30,
		filters: CustomerFilters = {},
		isoCode: string,
	) => {
		try {
			if (isoCode && typeof isoCode !== 'string') {
				throw new Error('Invalid isoCode');
			}

			const currency = isoCode === 'CO' ? 'COP' : 'USD';
			const offset = (page - 1) * pageSize;

			const personWhere: Record<string, unknown> = {};
			if (filters.dni) {
				personWhere.dni = { [Op.iLike]: `%${filters.dni}%` };
			}
			if (filters.fullName) {
				const normalizedSearch = filters.fullName
					.normalize('NFD')
					.replace(/[\u0300-\u036f]/g, '')
					.toLowerCase();

				personWhere.fullName = where(
					fn('unaccent', fn('lower', col('fullName'))),
					Op.iLike,
					`%${normalizedSearch}%`,
				);
			}

			const cityWhere: Record<string, unknown> = {};
			if (filters.cityName) {
				const normalizedSearch = filters.cityName
					.normalize('NFD')
					.replace(/[\u0300-\u036f]/g, '')
					.toLowerCase();

				cityWhere.name = where(
					fn('unaccent', fn('lower', col('address.city.name'))),
					Op.iLike,
					`%${normalizedSearch}%`,
				);
			}

			const { rows: topCustomers, count } =
				await this.customerModel.findAndCountAll({
					where: { deletedDate: null },
					attributes: [
						'id',
						'personId',
						'email',
						'phoneNumber',
						'createdDate',
						'city',
						[sequelize.col('person.fullName'), 'fullName'],
						[sequelize.col('person.dni'), 'dni'],
						[sequelize.col('address.location'), 'location'],
						[sequelize.col('address.cityId'), 'cityId'],
						[sequelize.col('address.city.name'), 'cityName'],
						[sequelize.col('address.city.region.name'), 'regionName'],
						[
							sequelize.col('address.city.region.country.isoCode'),
							'countryIsoCode',
						],
						[
							sequelize.fn(
								'COUNT',
								sequelize.literal('DISTINCT "billings"."id"'),
							),
							'billingCount',
						],
						[
							sequelize.fn(
								'SUM',
								sequelize.col('"billings->billingItems"."totalPrice"'),
							),
							'totalSpent',
						],
					],
					include: [
						{
							model: BillingModel,
							as: 'billings',
							required: true,
							attributes: [],
							where: { status: BillingStatus.PAID },
							include: [
								{
									model: BillingItemModel,
									as: 'billingItems',
									required: true,
									attributes: [],
									where: {
										name: { [Op.notILike]: '%flete%' },
									},
								},
								{
									model: ShopModel,
									as: 'shop',
									required: true,
									attributes: [],
									where: { currency },
								},
							],
						},
						{
							model: this.personModel,
							as: 'person',
							attributes: [],
							where: Object.keys(personWhere).length ? personWhere : undefined,
						},
						{
							model: this.addressModel,
							as: 'address',
							attributes: [],
							required: true,
							include: [
								{
									model: CityModel,
									as: 'city',
									attributes: [],
									required: true,
									where: Object.keys(cityWhere).length ? cityWhere : undefined,
									include: [
										{
											model: RegionModel,
											as: 'region',
											attributes: [],
											required: true,
											include: [
												{
													model: CountryModel,
													as: 'country',
													required: true,
													attributes: [],
													where: { isoCode },
												},
											],
										},
									],
								},
							],
						},
					],
					group: [
						'CustomerModel.id',
						'person.fullName',
						'person.dni',
						'address.location',
						'address.cityId',
						'address.city.name',
						'address.city.region.name',
						'address.city.region.country.isoCode',
					],
					order: [[sequelize.literal('"billingCount"'), 'DESC']],
					subQuery: false,
					limit: pageSize,
					offset,
				});

			return {
				topCustomers,
				total: count.length,
				page,
				pageSize,
				totalPages: Math.ceil(count.length / pageSize),
			};
		} catch (error) {
			console.error('Error getting top customers: ', error);
			throw error;
		}
	};

	searchCustomer = async (search: string, isoCode: string) => {
		try {
			const customer = await this.personModel.findAll({
				where: {
					[Op.or]: [
						{ dni: { [Op.iLike]: `%${search}%` } },
						where(
							fn('unaccent', fn('lower', col('fullName'))),
							Op.iLike,
							`%${normalizeSearch(search)}%`,
						),
					],
				},
				attributes: [
					'id',
					[sequelize.col('customer.id'), 'customerId'],
					'dni',
					'fullName',
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
				],
				include: [
					{
						model: this.customerModel,
						as: 'customer',
						required: true,
						attributes: [],
						include: [
							{
								model: this.addressModel,
								as: 'address',
								attributes: [],
								required: true,
								include: [
									{
										model: CityModel,
										as: 'city',
										attributes: [],
										required: true,
										include: [
											{
												model: RegionModel,
												as: 'region',
												attributes: [],
												required: true,
												include: [
													{
														model: CountryModel,
														as: 'country',
														attributes: [],
														required: true,
														where: { isoCode },
													},
												],
											},
										],
									},
								],
							},
						],
					},
				],
			});

			const formattedCustomer = customer.map(item => {
				const itemFormatted = {
					personId: item?.id,
					...item?.dataValues,
				};
				delete itemFormatted.id;
				return itemFormatted;
			});

			return {
				status: 200,
				customer: formattedCustomer,
			};
		} catch (error) {
			console.error('Error searching customer: ', error);
			throw error;
		}
	};

	findByPhone = async (phoneNumber: string, isoCode: string) => {
		try {
			const customer = await this.customerModel.findOne({
				where: { phoneNumber },
				attributes: [
					'id',
					[sequelize.col('person.id'), 'personId'],
					[sequelize.col('person.fullName'), 'fullName'],
					[sequelize.col('person.dni'), 'dni'],
					'email',
					'phoneNumber',
					[sequelize.col('address.location'), 'location'],
					[sequelize.col('address.cityId'), 'cityId'],
					[sequelize.col('address.city.name'), 'cityName'],
					[sequelize.col('address.city.region.name'), 'regionName'],
				],
				include: [
					{
						model: this.personModel,
						as: 'person',
						attributes: [],
						required: true,
					},
					{
						model: this.addressModel,
						as: 'address',
						attributes: [],
						required: false,
						include: [
							{
								model: CityModel,
								as: 'city',
								attributes: [],
								required: false,
								include: [
									{
										model: RegionModel,
										as: 'region',
										attributes: [],
										required: false,
										include: [
											{
												model: CountryModel,
												as: 'country',
												attributes: [],
												required: true,
												where: { isoCode },
											},
										],
									},
								],
							},
						],
					},
				],
			});

			if (!customer) return null;

			return customer.dataValues;
		} catch (error) {
			console.error('Error finding customer by phone: ', error);
			throw error;
		}
	};

	countByCountry = async () => {
		try {
			const result = (await this.customerModel.findAll({
				where: { deletedDate: null },
				attributes: [
					[sequelize.col('address.city.region.country.name'), 'countryName'],
					[
						sequelize.col('address.city.region.country.isoCode'),
						'countryIsoCode',
					],
					[
						sequelize.fn(
							'COUNT',
							sequelize.literal('DISTINCT "CustomerModel"."id"'),
						),
						'customerCount',
					],
				],
				include: [
					{
						model: BillingModel,
						as: 'billings',
						required: true,
						where: { status: BillingStatus.PAID },
						attributes: [],
					},
					{
						model: AddressModel,
						as: 'address',
						attributes: [],
						required: true,
						include: [
							{
								model: CityModel,
								as: 'city',
								attributes: [],
								required: true,
								include: [
									{
										model: RegionModel,
										as: 'region',
										attributes: [],
										required: true,
										include: [
											{
												model: CountryModel,
												as: 'country',
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
				group: [
					'address.city.region.country.name',
					'address.city.region.country.isoCode',
				],
				raw: true,
			})) as unknown as CountryCount[];

			const customersCountCO =
				result.find(c => c.countryIsoCode === 'CO')?.customerCount ?? 0;
			const customersCountEC =
				result.find(c => c.countryIsoCode === 'EC')?.customerCount ?? 0;

			return {
				customersCountCO: Number(customersCountCO),
				customersCountEC: Number(customersCountEC),
			};
		} catch (error) {
			console.error('Error counting customers: ', error);
			throw error;
		}
	};
}
