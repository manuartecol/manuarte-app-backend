import { DataTypes, Model, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database';
import { Op } from 'sequelize';

export class ProductCategoryModel extends Model {
	public id!: string;
	public cId!: string;
	public name!: string;

	async generateCId() {
		try {
			// Igual que el `pId`: el `cId` de una categoría borrada sigue ocupado
			const lastCategory = await ProductCategoryModel.findOne({
				where: { cId: { [Op.not]: null } },
				order: [['cId', 'DESC']],
				paranoid: false,
			});

			let nextCId = '0001';

			if (lastCategory && lastCategory.cId) {
				const lastCIdNumeric = parseInt(lastCategory.cId, 10);

				if (isNaN(lastCIdNumeric)) {
					throw new Error(
						`Formato de cId inválido en la última categoría: ${lastCategory.cId}`,
					);
				}

				const nextNumericId = lastCIdNumeric + 1;
				nextCId = nextNumericId.toString().padStart(4, '0');
			}

			this.cId = nextCId;
		} catch (error) {
			console.error('Error generando el cId:', error);
			throw new Error(
				'No se pudo generar un nuevo cId para la categoría de producto',
			);
		}
	}

	async validateProductCategoryName() {
		const existingProduct = await ProductCategoryModel.findOne({
			where: { name: this.name },
		});

		if (existingProduct && existingProduct.id !== this.id) {
			throw new Error('Ya existe una categoría de producto con este nombre');
		}
	}
}

ProductCategoryModel.init(
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
		cId: {
			type: DataTypes.STRING(4),
			allowNull: false,
			unique: 'UQ_5fd8cbca48258162717427d403a',
		},
		productCategoryGroupId: {
			type: DataTypes.UUID,
			allowNull: true,
			references: {
				model: 'product_category_group',
				key: 'id',
			},
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
		tableName: 'product_category',
		schema: 'public',
		timestamps: true,
		paranoid: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
		deletedAt: 'deletedDate',
		indexes: [
			{
				name: 'PK_f132cc7be455c359ba84d1e7246',
				unique: true,
				fields: [{ name: 'id' }],
			},
			{
				name: 'UQ_5fd8cbca48258162717427d403a',
				unique: true,
				fields: [{ name: 'cId' }],
			},
		],
		hooks: {
			beforeCreate: async productCategory => {
				productCategory.name = productCategory.name.toUpperCase().trim();
				await productCategory.validateProductCategoryName();
			},
			beforeUpdate: async productCategory => {
				productCategory.name = productCategory.name.toUpperCase().trim();
				await productCategory.validateProductCategoryName();
			},
			// Mismo criterio que en producto: los productos borrados siguen
			// referenciando su categoría
			beforeDestroy: async (productCategory, options) => {
				if (!options.force) return;

				const [products] = await sequelize.query<{ total: string }>(
					'SELECT COUNT(*) AS total FROM product WHERE "productCategoryId" = :productCategoryId',
					{
						replacements: { productCategoryId: productCategory.id },
						type: QueryTypes.SELECT,
						transaction: options.transaction,
					},
				);

				if (Number(products.total) > 0) {
					throw new Error(
						'No se puede borrar definitivamente la categoría, porque todavía tiene productos',
					);
				}
			},
		},
	},
);
