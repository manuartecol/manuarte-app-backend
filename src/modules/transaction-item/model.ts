import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../config/database';
import { ProductVariantModel } from '../product-variant/model';

export class TransactionItemModel extends Model {
	public quantity!: number;
	public stockBefore!: number;
	public createdDate!: string;
}

TransactionItemModel.init(
	{
		id: {
			type: DataTypes.UUID,
			allowNull: false,
			defaultValue: DataTypes.UUIDV4,
			primaryKey: true,
		},
		description: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		transactionId: {
			type: DataTypes.UUID,
			allowNull: false,
			references: {
				model: 'transaction',
				key: 'id',
			},
		},
		productVariantId: {
			type: DataTypes.UUID,
			allowNull: false,
			references: {
				model: 'product_variant',
				key: 'id',
			},
		},
		quantity: {
			type: DataTypes.INTEGER,
			allowNull: true,
		},
		price: {
			type: DataTypes.DECIMAL,
			allowNull: true,
		},
		currency: {
			type: DataTypes.STRING,
			allowNull: true,
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
		success: {
			type: DataTypes.BOOLEAN,
			allowNull: true,
			defaultValue: true,
		},
		stockBefore: {
			type: DataTypes.INTEGER,
			allowNull: true,
			defaultValue: 0,
		},
	},
	{
		sequelize,
		tableName: 'transaction_item',
		schema: 'public',
		timestamps: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
		deletedAt: 'deletedDate',
		indexes: [
			{
				name: 'PK_b40595241a69876722f692d041f',
				unique: true,
				fields: [{ name: 'id' }],
			},
		],
	},
);

TransactionItemModel.belongsTo(ProductVariantModel, {
	foreignKey: 'productVariantId',
	as: 'productVariants',
});

