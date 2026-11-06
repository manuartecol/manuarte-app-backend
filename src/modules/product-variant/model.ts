import { DataTypes, Model, QueryTypes, Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { ProductModel } from '../product/model';
import { Op } from 'sequelize';
import { BillingItemModel } from '../billing-item/model';
import { StockItemProductVariantModel } from '../associations/stock-item-product-variant-model';

export class ProductVariantModel extends Model {
	public id!: string;
	public name!: string;
	public productId!: string;
	public vId!: string;
	public createdBy!: string;
	public updatedBy!: string;
	public quantityValue!: string | null;
	public unitId!: string | null;
	public containerId!: string | null;
	public isCapacity!: boolean;
	public quantityBase!: string | null;
	public variantKey!: string | null;

	async generateVId(transaction: Transaction) {
		try {
			const associatedProduct = await ProductModel.findByPk(this.productId, {
				transaction,
			});

			if (!associatedProduct) {
				throw new Error(`Producto con ID ${this.productId} no encontrado`);
			}

			const pId = associatedProduct.pId;

			// Igual que el `pId`: el `vId` de una presentación borrada sigue ocupado
			const maxItem = await ProductVariantModel.findOne({
				where: { vId: { [Op.like]: `${pId}%` } },
				order: [['vId', 'DESC']],
				transaction,
				paranoid: false,
			});

			let nextVId = `${pId}0001`;

			if (maxItem) {
				const currentId = maxItem.vId.slice(pId.length);
				const nextNumericId = parseInt(currentId, 10) + 1;

				if (isNaN(nextNumericId)) {
					throw new Error(
						`Formato de vId inválido en la última presentación: ${maxItem.vId}`,
					);
				}

				nextVId = `${pId}${nextNumericId.toString().padStart(4, '0')}`;
			}

			this.vId = nextVId;
		} catch (error) {
			console.error('Error generando vId:', error);
			throw new Error(
				'No se pudo generar un nuevo vId para la presentación del producto',
			);
		}
	}

	async validateProductVariantName(transaction?: Transaction) {
		if (!this.name || !this.productId) {
			throw new Error('El nombre y el productId son requeridos para validar');
		}

		const existingProductVariant = await ProductVariantModel.findOne({
			where: {
				[Op.and]: [
					sequelize.where(
						sequelize.fn('LOWER', sequelize.col('name')),
						this.name.toLowerCase(),
					),
					{ productId: this.productId },
					// Mismo motivo que en `validateProductName`
					{ id: { [Op.ne]: this.id } },
				],
			},
			transaction,
		});

		if (existingProductVariant) {
			throw new Error(
				'Ya existe una presentación del producto con este nombre, sin importar mayúsculas y minúsculas',
			);
		}
	}
}

ProductVariantModel.init(
	{
		id: {
			type: DataTypes.UUID,
			allowNull: false,
			defaultValue: DataTypes.UUIDV4,
			primaryKey: true,
		},
		name: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		/**
		 * Los ejes estructurados, todos opcionales e independientes. Las columnas
		 * DECIMAL llegan como string desde `pg` y se dejan así a propósito: un
		 * getter que las convirtiera no se aplicaría en las consultas `raw`, y la
		 * tabla de productos usa SQL crudo. La conversión se hace en el servicio,
		 * en un solo sitio
		 */
		quantityValue: {
			type: DataTypes.DECIMAL(12, 3),
			allowNull: true,
		},
		unitId: {
			type: DataTypes.UUID,
			allowNull: true,
			references: {
				model: 'measurement_unit',
				key: 'id',
			},
		},
		containerId: {
			type: DataTypes.UUID,
			allowNull: true,
			references: {
				model: 'container',
				key: 'id',
			},
		},
		isCapacity: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		},
		// Derivadas de las anteriores: las calcula `helpers/composition`
		quantityBase: {
			type: DataTypes.DECIMAL(18, 6),
			allowNull: true,
		},
		variantKey: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		productId: {
			type: DataTypes.UUID,
			allowNull: false,
			references: {
				model: 'product',
				key: 'id',
			},
		},
		vId: {
			type: DataTypes.STRING(12),
			allowNull: false,
			unique: 'UQ_d7fc664d6233f126e71d2bcf367',
		},
		active: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: true,
		},
		createdBy: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		updatedBy: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		createdDate: {
			type: DataTypes.DATE,
			allowNull: false,
			defaultValue: sequelize.fn('now'),
		},
		updatedDate: {
			type: DataTypes.DATE,
			allowNull: false,
			defaultValue: sequelize.fn('now'),
		},
		deletedDate: {
			type: DataTypes.DATE,
			allowNull: true,
		},
	},
	{
		sequelize,
		tableName: 'product_variant',
		schema: 'public',
		timestamps: true,
		paranoid: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
		deletedAt: 'deletedDate',
		indexes: [
			{
				name: 'PK_738bfa62f918ad1436cb5c8ee5b',
				unique: true,
				fields: [{ name: 'id' }],
			},
			{
				name: 'UQ_d7fc664d6233f126e71d2bcf367',
				unique: true,
				fields: [{ name: 'vId' }],
			},
		],
		hooks: {
			beforeCreate: async (productVariant, options) => {
				productVariant.name = productVariant.name.trim();
				if (!options.transaction) {
					throw new Error('Transaction is required in beforeCreate');
				}
				await productVariant.validateProductVariantName(options.transaction);
			},
			// Mismo criterio que en producto: el nombre se comprueba solo si cambia
			beforeUpdate: async productVariant => {
				productVariant.name = productVariant.name.trim();

				if (productVariant.changed('name')) {
					await productVariant.validateProductVariantName();
				}
			},
			/**
			 * Última defensa del borrado definitivo. Qué presentación se borra de
			 * verdad y cuál solo se marca lo decide `ProductVariantService`, pero si
			 * llegara aquí un `force` con historial detrás, las líneas de factura,
			 * cotización o movimiento quedarían apuntando a una fila que ya no está.
			 *
			 * Cuenta las filas sin mirar su `deletedDate`: una factura anulada sigue
			 * siendo una fila que referencia a esta presentación. La consulta es
			 * directa para no importar los tres modelos, que importan este a su vez
			 */
			beforeDestroy: async (productVariant, options) => {
				if (!options.force) return;

				const [history] = await sequelize.query<{
					billingItems: string;
					quoteItems: string;
					transactionItems: string;
				}>(
					`
						SELECT
							(SELECT COUNT(*) FROM billing_item WHERE "productVariantId" = :productVariantId) AS "billingItems",
							(SELECT COUNT(*) FROM quote_item WHERE "productVariantId" = :productVariantId) AS "quoteItems",
							(SELECT COUNT(*) FROM transaction_item WHERE "productVariantId" = :productVariantId) AS "transactionItems"
					`,
					{
						replacements: { productVariantId: productVariant.id },
						type: QueryTypes.SELECT,
						transaction: options.transaction,
					},
				);

				const total =
					Number(history.billingItems) +
					Number(history.quoteItems) +
					Number(history.transactionItems);

				if (total > 0) {
					throw new Error(
						'No se puede borrar definitivamente la presentación, porque tiene historial de facturas, cotizaciones o movimientos',
					);
				}

				const stockItems = await StockItemProductVariantModel.count({
					where: { productVariantId: productVariant.id },
					transaction: options.transaction,
				});

				if (stockItems > 0) {
					throw new Error(
						'No se puede borrar definitivamente la presentación, porque todavía está en alguna bodega',
					);
				}
			},
		},
	},
);

BillingItemModel.belongsTo(ProductVariantModel, {
	foreignKey: 'productVariantId',
	as: 'productVariant',
});

ProductVariantModel.hasMany(BillingItemModel, {
	foreignKey: 'productVariantId',
	as: 'billingItems',
});
