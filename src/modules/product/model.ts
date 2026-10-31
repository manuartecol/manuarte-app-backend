import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../config/database';
import { ProductCategoryModel } from '../product-category/model';
import { ProductVariantModel } from '../product-variant/model';
import { Op } from 'sequelize';

export class ProductModel extends Model {
	public id!: string;
	public name!: string;
	public pId!: string;
	public description!: string | null;
	public productCategoryId!: string;
	public createdBy!: string;
	public updatedBy!: string;

	async generatePId() {
		try {
			const productCategory = await ProductCategoryModel.findByPk(
				this.productCategoryId,
			);

			if (!productCategory) {
				throw new Error(
					`Categoría con ID ${this.productCategoryId} no encontrada`,
				);
			}

			const cId = productCategory.cId;

			const lastProduct = await ProductModel.findOne({
				where: { pId: { [Op.like]: `${cId}%` } },
				order: [['pId', 'DESC']],
			});

			let nextPId = `${cId}0001`;

			if (lastProduct) {
				const currentId = lastProduct.pId.slice(cId.length);
				const nextNumericId = parseInt(currentId, 10) + 1;

				if (isNaN(nextNumericId)) {
					throw new Error(
						`Formato de pId inválido en el último producto: ${lastProduct.pId}`,
					);
				}

				nextPId = `${cId}${nextNumericId.toString().padStart(4, '0')}`;
			}

			this.pId = nextPId;
		} catch (error) {
			console.error('Error generando pId:', error);
			throw new Error('No se pudo generar un nuevo pId para el producto');
		}
	}

	// Opcional: una descripción vacía o solo con espacios se guarda como NULL,
	// para que Gema y los filtros no traten '' como si hubiera descripción
	normalizeDescription() {
		if (typeof this.description === 'string') {
			this.description = this.description.trim() || null;
		}
	}

	async validateProductName() {
		// Se excluye a sí mismo en la consulta y no después: con dos productos ya
		// duplicados, `findOne` podía devolver este mismo y dejar pasar el otro
		const existingProduct = await ProductModel.findOne({
			where: {
				[Op.and]: [
					sequelize.where(
						sequelize.fn('LOWER', sequelize.col('name')),
						this.name.toLowerCase(),
					),
					{ id: { [Op.ne]: this.id } },
				],
			},
		});

		if (existingProduct) {
			throw new Error(
				'Ya existe un producto con este nombre, sin importar mayúsculas y minúsculas',
			);
		}
	}
}

ProductModel.init(
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
		description: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		pId: {
			type: DataTypes.STRING(8),
			allowNull: false,
			unique: 'UQ_60968f56bca6403ae5387658832',
		},
		productCategoryId: {
			type: DataTypes.UUID,
			allowNull: false,
			references: {
				model: 'product_category',
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
		tableName: 'product',
		schema: 'public',
		timestamps: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
		deletedAt: 'deletedDate',
		indexes: [
			{
				name: 'PK_bebc9158e480b949565b4dc7a82',
				unique: true,
				fields: [{ name: 'id' }],
			},
			{
				name: 'UQ_60968f56bca6403ae5387658832',
				unique: true,
				fields: [{ name: 'pId' }],
			},
		],
		hooks: {
			beforeCreate: async product => {
				product.name = product.name.trim();
				product.normalizeDescription();
				await product.validateProductName();
			},
			// La categoría se puede cambiar. El `pId` no se regenera: los `vId` de
			// las etiquetas impresas cuelgan de él, así que su prefijo de categoría
			// queda como histórico
			beforeUpdate: async product => {
				product.name = product.name.trim();
				product.normalizeDescription();
				await product.validateProductName();
			},
		},
	},
);

// ***** ProductModel-ProductCategoryModel Relations *****
ProductModel.belongsTo(ProductCategoryModel, {
	foreignKey: 'productCategoryId',
	as: 'productCategory',
});

ProductCategoryModel.hasMany(ProductModel, {
	foreignKey: 'productCategoryId',
	as: 'products',
});

// ***** ProductModel-ProductVariantModel Relations *****
ProductModel.hasMany(ProductVariantModel, {
	foreignKey: 'productId',
	as: 'productVariants',
});

ProductVariantModel.belongsTo(ProductModel, {
	foreignKey: 'productId',
	as: 'product',
});
