import { sequelize } from '../../config/database';
import { BillingStatus } from '../billing/types';
import { ProductCategoryModel } from '../product-category/model';
import { ProductModel } from '../product/model';
import { StockItemModel } from '../stock-item/model';
import { StockItemService } from '../stock-item/service';
import { ProductVariantModel } from './model';
import { MeasurementUnitModel } from '../measurement-unit/model';
import { ContainerModel } from '../container/model';
import { AttributeTypeModel } from '../attribute-type/model';
import { ProductVariantAttributeModel } from '../product-variant-attribute/model';
import {
	composeVariantName,
	computeQuantityBase,
	computeVariantKey,
} from './helpers/composition';
import { describeDeletionBlock } from './helpers/deletion-block';
import { containsText } from './helpers/search';
import { getPendingTransfersByProductVariant } from '../transaction/helpers/pending-transfers';
import {
	CreateProductVariantDto,
	ProductVariantDeletionPlan,
	ProductVariantFilters,
	UpdateProductVariantDto,
	VariantAttributeInput,
	VariantAttributeType,
	VariantAxes,
	VariantAxesDto,
	VariantCatalog,
	VariantContainer,
	VariantUnit,
} from './types';
import { Op, QueryTypes, Transaction } from 'sequelize';

/**
 * El grupo de categorías cuyos productos se miden por capacidad del envase. Va
 * por nombre de grupo y no por id porque los id son distintos en cada entorno
 */
const CAPACITY_CATEGORY_GROUP = 'ENVASES';
const VARIANT_FULL_NAME = `concat("product"."name", ' ', "ProductVariantModel"."name")`;

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
				productVariantWhere.name = containsText(
					'"ProductVariantModel"."name"',
					filters.variantName,
				);
			}

			const productWhere: Record<string, unknown> = { deletedDate: null };
			if (filters.productName) {
				productWhere.name = containsText(
					'"product"."name"',
					filters.productName,
				);
			}
			if (filters.productDescription) {
				productWhere.description = containsText(
					'"product"."description"',
					filters.productDescription,
				);
			}

			const productCategoryWhere: Record<string, unknown> = {};
			if (filters.productCategoryName) {
				productCategoryWhere.name = containsText(
					'"product->productCategory"."name"',
					filters.productCategoryName,
				);
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
						/**
						 * Unidad y envase van como include porque son `belongsTo` y no
						 * multiplican filas. Los atributos son `hasMany` y sí: con `limit`
						 * en la misma consulta, una presentación con dos atributos se
						 * llevaría dos huecos de la página. Se piden aparte, abajo
						 */
						{ model: MeasurementUnitModel, as: 'unit', required: false },
						{ model: ContainerModel, as: 'container', required: false },
					],
					/**
					 * `quantityBase` antes del nombre es lo que pone "250 ml" delante de
					 * "1 lt", donde el alfabético pone "1 kilo" antes de "100 grs".
					 * Postgres manda los NULL al final en ASC, así que las que todavía no
					 * están estructuradas quedan detrás de las que sí, dentro de su
					 * producto, y el orden mejora a medida que avance el backfill
					 */
					order: [
						['productName', 'ASC'],
						['quantityBase', 'ASC'],
						['name', 'ASC'],
					],
					limit: pageSize,
					offset,
				});

			const attributesByVariant = await this.getAttributesByVariant(
				productVariants.map(productVariant => productVariant.id),
			);

			return {
				productVariants: productVariants.map(productVariant =>
					this.withNumericAxes(
						productVariant,
						attributesByVariant.get(productVariant.id) ?? [],
					),
				),
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

	/**
	 * Los atributos de varias presentaciones en una sola consulta, agrupados por
	 * presentación. Van aparte de la consulta paginada a propósito: ver el
	 * comentario del include en `getAll`
	 */
	private getAttributesByVariant = async (
		productVariantIds: string[],
		transaction?: Transaction,
	) => {
		const grouped = new Map<
			string,
			{ attributeTypeId: string; code: string; label: string; value: string }[]
		>();

		if (productVariantIds.length === 0) return grouped;

		const rows = await ProductVariantAttributeModel.findAll({
			where: { productVariantId: productVariantIds },
			transaction,
			include: [
				{
					model: AttributeTypeModel,
					as: 'attributeType',
					required: true,
					attributes: [],
				},
			],
			attributes: [
				'productVariantId',
				'attributeTypeId',
				'value',
				[sequelize.col('attributeType.code'), 'code'],
				[sequelize.col('attributeType.label'), 'label'],
			],
			order: [[sequelize.col('attributeType.sortOrder'), 'ASC']],
			raw: true,
		});

		for (const row of rows as unknown as {
			productVariantId: string;
			attributeTypeId: string;
			value: string;
			code: string;
			label: string;
		}[]) {
			const current = grouped.get(row.productVariantId) ?? [];
			current.push({
				attributeTypeId: row.attributeTypeId,
				code: row.code,
				label: row.label,
				value: row.value,
			});
			grouped.set(row.productVariantId, current);
		}

		return grouped;
	};

	/**
	 * `pg` devuelve DECIMAL como string, para no perder precisión. El panel los
	 * quiere como números, así que la conversión se hace aquí, en el único sitio
	 * por donde salen, en vez de en cada componente que los lea
	 */
	/**
	 * Una presentación con sus ejes resueltos, con la misma forma que devuelven
	 * las tablas. La usan las respuestas de crear y editar.
	 *
	 * Antes devolvían `dataValues` a secas, y el panel construía con eso la fila
	 * de la tabla: las columnas llegaban, pero los atributos viven en la tabla
	 * hija y no. El resultado era que al editar una presentación recién creada el
	 * modal abría sin su envase ni sus atributos, aunque estuvieran guardados.
	 *
	 * Vuelve a consultar en vez de componer con los ejes que ya tiene en memoria,
	 * para que la forma salga del mismo sitio que la de `getAll` y no puedan
	 * separarse
	 */
	getOnePublic = async (
		productVariantId: string,
		transaction?: Transaction,
	) => {
		const productVariant = await this.productVariantModel.findByPk(
			productVariantId,
			{
				include: [
					{ model: MeasurementUnitModel, as: 'unit', required: false },
					{ model: ContainerModel, as: 'container', required: false },
				],
				transaction,
			},
		);

		if (!productVariant) return null;

		const attributesByVariant = await this.getAttributesByVariant(
			[productVariantId],
			transaction,
		);

		return this.withNumericAxes(
			productVariant,
			attributesByVariant.get(productVariantId) ?? [],
		);
	};

	private withNumericAxes = (
		productVariant: ProductVariantModel,
		attributes: {
			attributeTypeId: string;
			code: string;
			label: string;
			value: string;
		}[],
	) => {
		const plain = productVariant.toJSON() as Record<string, unknown>;

		return {
			...plain,
			quantityValue:
				plain.quantityValue === null || plain.quantityValue === undefined
					? null
					: Number(plain.quantityValue),
			quantityBase:
				plain.quantityBase === null || plain.quantityBase === undefined
					? null
					: Number(plain.quantityBase),
			attributes,
		};
	};

	/**
	 * Convierte los identificadores que manda el formulario en las filas de
	 * catálogo que necesita la composición, y rechaza lo que no cuadra antes de
	 * escribir nada. Se resuelve contra la base y no se confía en el cuerpo de la
	 * petición: un `unitId` inventado daría un nombre a medias y una firma que no
	 * corresponde a ninguna unidad real
	 */
	private resolveAxes = async (
		axes: VariantAxesDto,
		productId: string,
		transaction?: Transaction,
	): Promise<VariantAxes> => {
		const unit = axes.unitId
			? await MeasurementUnitModel.findByPk(axes.unitId, {
					transaction,
					raw: true,
				})
			: null;
		if (axes.unitId && !unit) {
			throw new Error('La unidad de medida seleccionada no existe');
		}

		const container = axes.containerId
			? await ContainerModel.findByPk(axes.containerId, {
					transaction,
					raw: true,
				})
			: null;
		if (axes.containerId && !container) {
			throw new Error('El envase seleccionado no existe');
		}

		// Un atributo sin valor no es un atributo: se descarta en vez de guardar
		// una fila vacía que luego aparecería en el nombre como un separador suelto
		const incoming = (axes.attributes ?? []).filter(attribute =>
			attribute?.value?.trim(),
		);

		const repeated = incoming.filter(
			(attribute, index) =>
				incoming.findIndex(
					other => other.attributeTypeId === attribute.attributeTypeId,
				) !== index,
		);
		if (repeated.length > 0) {
			throw new Error(
				'Cada atributo puede tener un solo valor en la misma presentación',
			);
		}

		let attributes: VariantAttributeInput[] = [];
		if (incoming.length > 0) {
			const types = await AttributeTypeModel.findAll({
				where: { id: incoming.map(attribute => attribute.attributeTypeId) },
				transaction,
				raw: true,
			});

			attributes = incoming.map(attribute => {
				const type = types.find(
					candidate => candidate.id === attribute.attributeTypeId,
				);
				if (!type) {
					throw new Error('Uno de los atributos seleccionados no existe');
				}

				return {
					type: type as unknown as VariantAttributeType,
					value: attribute.value.trim(),
				};
			});
		}

		const quantityValue =
			axes.quantityValue === null || axes.quantityValue === undefined
				? null
				: Number(axes.quantityValue);

		if (quantityValue !== null) {
			if (!Number.isFinite(quantityValue) || quantityValue <= 0) {
				throw new Error('La cantidad de la presentación debe ser mayor que 0');
			}
			if (!unit) {
				throw new Error('Indica la unidad de medida de la cantidad');
			}
		}

		return {
			quantityValue,
			unit: unit as unknown as VariantUnit | null,
			isCapacity: await this.isCapacityProduct(productId, transaction),
			container: container as unknown as VariantContainer | null,
			attributes,
		};
	};

	/**
	 * Si el número de la presentación es capacidad del envase y no cantidad de
	 * producto: una Jarra de Aluminio de 250 ml contiene 250 ml, no está hecha de
	 * 250 ml de aluminio. Entra en la firma, así que decide unicidad, y por eso
	 * sale de la base y no del formulario: dos presentaciones del mismo producto
	 * con el flag distinto serían dos filas que el UNIQUE no reconoce como la
	 * misma, y nadie lo vería en la tabla.
	 *
	 * Se deduce del grupo y no de la categoría: las tres categorías de envases
	 * (vidrio, plásticos, yeso) cuelgan del grupo ENVASES, y una cuarta que se
	 * cree mañana heredaría el comportamiento sin tocar código
	 */
	private isCapacityProduct = async (
		productId: string,
		transaction?: Transaction,
	): Promise<boolean> => {
		const [row] = await sequelize.query<{ groupName: string | null }>(
			`
				SELECT pcg.name AS "groupName"
				FROM product p
				INNER JOIN product_category pc ON pc.id = p."productCategoryId"
				LEFT JOIN product_category_group pcg ON pcg.id = pc."productCategoryGroupId"
				WHERE p.id = :productId
			`,
			{
				replacements: { productId },
				type: QueryTypes.SELECT,
				transaction,
			},
		);

		return row?.groupName === CAPACITY_CATEGORY_GROUP;
	};

	/**
	 * Las seis columnas que se escriben en `product_variant`, más el nombre. El
	 * nombre es derivado cuando hay ejes: que lo calcule el mismo sitio que la
	 * firma es lo que impide que un nombre diga una cosa y la unicidad otra
	 */
	private buildVariantFields = (axes: VariantAxes) => ({
		name: composeVariantName(axes),
		quantityValue: axes.quantityValue ?? null,
		unitId: axes.unit?.id ?? null,
		containerId: axes.container?.id ?? null,
		isCapacity: Boolean(axes.isCapacity),
		quantityBase: computeQuantityBase(axes),
		variantKey: computeVariantKey(axes),
	});

	/**
	 * Se borran y se vuelven a insertar en la misma transacción: son de 0 a 3
	 * filas, y un diff incremental solo añadiría formas de dejarlas a medias
	 */
	private saveAttributes = async (
		productVariantId: string,
		axes: VariantAxes,
		transaction: Transaction,
	) => {
		await ProductVariantAttributeModel.destroy({
			where: { productVariantId },
			transaction,
		});

		const rows = (axes.attributes ?? []).map(attribute => ({
			productVariantId,
			attributeTypeId: attribute.type.id,
			value: attribute.value,
		}));

		if (rows.length > 0) {
			await ProductVariantAttributeModel.bulkCreate(rows, { transaction });
		}
	};

	/**
	 * El índice `uq_product_variant_product_variant_key` salta con un error de
	 * Postgres ilegible para el usuario. El mensaje explica los dos casos que de
	 * verdad lo provocan, porque ninguno se ve a simple vista en la tabla: una
	 * presentación equivalente escrita con otra unidad, o una inactiva
	 */
	private rethrowAsDuplicateAxes = (error: unknown, name: string) => {
		const constraint = (error as { parent?: { constraint?: string } })?.parent
			?.constraint;

		if (constraint === 'uq_product_variant_product_variant_key') {
			throw new Error(
				`Ya existe una presentación de este producto equivalente a "${name}". Puede estar escrita con otra unidad (0.5 kg y 500 g son la misma) o estar inactiva`,
			);
		}
	};

	create = async (
		{ name, productId, axes, requestedBy }: CreateProductVariantDto,
		transaction: Transaction,
	) => {
		const resolvedAxes = axes
			? await this.resolveAxes(axes, productId, transaction)
			: null;
		const fields = resolvedAxes
			? this.buildVariantFields(resolvedAxes)
			: undefined;
		const variantName = fields?.name ?? name?.trim();

		if (!variantName) {
			throw new Error(
				'La presentación necesita un nombre o sus datos de medida',
			);
		}

		try {
			const newProductVariant = this.productVariantModel.build({
				...fields,
				name: variantName,
				productId,
				createdBy: requestedBy,
				updatedBy: requestedBy,
			});

			await newProductVariant.generateVId(transaction);
			await newProductVariant.save({ transaction });

			if (resolvedAxes) {
				await this.saveAttributes(
					newProductVariant.id,
					resolvedAxes,
					transaction,
				);
			}

			/**
			 * Con los ejes resueltos, no `dataValues` a secas: el panel arma con esto
			 * la fila de la tabla, y los atributos viven en la tabla hija
			 */
			return (
				(await this.getOnePublic(newProductVariant.id, transaction)) ??
				newProductVariant.dataValues
			);
		} catch (error) {
			this.rethrowAsDuplicateAxes(error, variantName);
			console.error('ServiceError creando presentación de producto: ', error);
			throw error;
		}
	};

	update = async (
		{ id, name, active, stockIds, axes, requestedBy }: UpdateProductVariantDto,
		transaction?: Transaction,
	) => {
		// Si no llega de `ProductService.update`, abre la suya: `setActiveStocks`
		// actualiza varias bodegas y un fallo a mitad dejaba unas sí y otras no
		const ownsTransaction = !transaction;
		const t = transaction ?? (await sequelize.transaction());
		let variantName = name?.trim();
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

			const resolvedAxes = axes
				? await this.resolveAxes(
						axes,
						productVariantToUpdate.getDataValue('productId'),
						t,
					)
				: null;
			const fields = resolvedAxes
				? this.buildVariantFields(resolvedAxes)
				: undefined;
			variantName = fields?.name ?? variantName;

			/**
			 * El nombre solo se toca si hay algo con lo que tocarlo. Sin esto, una
			 * edición que solo cambia las bodegas o el estado llegaría con `name`
			 * vacío y lo borraría, y la columna es NOT NULL
			 */
			await productVariantToUpdate.update(
				{
					...fields,
					...(variantName ? { name: variantName } : {}),
					active,
					updatedBy: requestedBy,
				},
				{ transaction: t },
			);

			if (resolvedAxes) {
				await this.saveAttributes(id, resolvedAxes, t);
			}

			if (stockIds) {
				await this.stockItemService.setActiveStocks(
					id,
					stockIds as string[],
					t,
				);
			}

			/**
			 * Se lee antes del commit y con la misma transacción, para devolver lo
			 * que acaba de quedar escrito. Con los ejes resueltos, porque el panel
			 * refresca con esto la fila de la tabla
			 */
			const updated = await this.getOnePublic(id, t);

			if (ownsTransaction) await t.commit();

			return updated ?? productVariantToUpdate.dataValues;
		} catch (error) {
			if (ownsTransaction) await t.rollback();
			this.rethrowAsDuplicateAxes(error, variantName ?? '');
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

			/**
			 * Las unidades de una transferencia sin aceptar no están en ninguna
			 * bodega: salieron del origen y todavía no entraron al destino, así que
			 * `stocksWithUnits` las da por cero y el borrado parecía inofensivo.
			 * Borrarla y aceptar después deja las unidades sobre una presentación
			 * que ya no existe para el panel, invisibles y sin forma de sacarlas
			 */
			const pendingTransfers = await getPendingTransfersByProductVariant(
				productVariantId,
				transaction,
			);

			const historyRows =
				Number(history.billingRows) +
				Number(history.quoteRows) +
				Number(history.transactionRows);

			const blockedMessage = describeDeletionBlock({
				pendingTransfers,
				stocksWithUnits,
			});

			const mode = blockedMessage
				? 'blocked'
				: historyRows > 0
					? 'logical'
					: 'physical';

			return {
				mode,
				blockedMessage,
				historyRows,
				billingItems: Number(history.billingItems),
				quoteItems: Number(history.quoteItems),
				transactionItems: Number(history.transactionItems),
				stocksWithUnits,
				pendingTransfers,
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

			if (plan.blockedMessage) {
				throw new Error(plan.blockedMessage);
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

	/**
	 * Las tres listas fijas que el formulario necesita para sus selects. Van en
	 * una sola respuesta y no en tres rutas porque el formulario las pide juntas
	 * siempre, y porque no hay administración de unidades ni de envases: el
	 * cliente no la quiere, así que las listas se mantienen por seeder y solo se
	 * leen desde aquí.
	 *
	 * Solo las activas: una unidad que deje de ofrecerse se apaga, y las
	 * presentaciones que ya la referencian siguen resolviendo su nombre, porque
	 * eso lo hace el include de la fila y no esta lista
	 */
	getCatalog = async (): Promise<VariantCatalog> => {
		try {
			const [units, containers, attributeTypes] = await Promise.all([
				MeasurementUnitModel.findAll({
					where: { active: true },
					attributes: [
						'id',
						'code',
						'label',
						'labelPlural',
						'name',
						'dimension',
						'factorToBase',
					],
					order: [['sortOrder', 'ASC']],
					raw: true,
				}),
				ContainerModel.findAll({
					where: { active: true },
					attributes: ['id', 'code', 'label'],
					order: [['sortOrder', 'ASC']],
					raw: true,
				}),
				AttributeTypeModel.findAll({
					where: { active: true },
					attributes: ['id', 'code', 'label', 'valueTemplate', 'sortOrder'],
					order: [['sortOrder', 'ASC']],
					raw: true,
				}),
			]);

			return {
				units: units as unknown as VariantUnit[],
				containers: containers as unknown as VariantContainer[],
				attributeTypes: attributeTypes as unknown as VariantAttributeType[],
			};
		} catch (error) {
			console.error('Error obteniendo el catálogo de presentaciones', error);
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
							containsText(VARIANT_FULL_NAME, search),
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
									WHEN unaccent(lower(concat("product"."name", ' ', "ProductVariantModel"."name"))) LIKE (unaccent(lower(:search)) || '%') THEN 1
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
						containsText(VARIANT_FULL_NAME, search),
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
