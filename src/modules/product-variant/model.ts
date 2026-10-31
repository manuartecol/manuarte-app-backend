import { DataTypes, Model, Transaction } from 'sequelize';
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

	async generateVId(transaction: Transaction) {
		try {
			const associatedProduct = await ProductModel.findByPk(this.productId, {
				transaction,
			});

			if (!associatedProduct) {
				throw new Error(`Producto con ID ${this.productId} no encontrado`);
			}

			const pId = associatedProduct.pId;

			const maxItem = await ProductVariantModel.findOne({
				where: { vId: { [Op.like]: `${pId}%` } },
				order: [['vId', 'DESC']],
				transaction,
			});

			let nextVId = `${pId}0001`;

			if (maxItem) {
				const currentId = maxItem.vId.slice(pId.length);
				const nextNumericId = parseInt(currentId, 10) + 1;

				if (isNaN(nextNumericId)) {
					throw new Error(
						`Formato de vId inválido en la última variante: ${maxItem.vId}`,
					);
				}

				nextVId = `${pId}${nextNumericId.toString().padStart(4, '0')}`;
			}

			this.vId = nextVId;
		} catch (error) {
			console.error('Error generando vId:', error);
			throw new Error(
				'No se pudo generar un nuevo vId para la variante del producto',
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
		quantity: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 0,
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
			beforeUpdate: async productVariant => {
				productVariant.name = productVariant.name.trim();
				await productVariant.validateProductVariantName();
			},
			beforeDestroy: async productVariant => {
				const count = await StockItemProductVariantModel.count({
					where: { productVariantId: productVariant.id },
				});

				if (count > 0) {
					throw new Error(
						'No se puede borrar la presentación del producto, porque se encuentra en stock',
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
