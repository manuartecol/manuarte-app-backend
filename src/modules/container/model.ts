import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../config/database';
import { ProductVariantModel } from '../product-variant/model';

export class ContainerModel extends Model {
	public id!: string;
	public code!: string;
	public label!: string;
	public sortOrder!: number;
	public active!: boolean;
}

ContainerModel.init(
	{
		id: {
			type: DataTypes.UUID,
			primaryKey: true,
			allowNull: false,
			defaultValue: DataTypes.UUIDV4,
		},
		code: {
			type: DataTypes.STRING(24),
			allowNull: false,
			unique: true,
		},
		label: {
			type: DataTypes.STRING(48),
			allowNull: false,
		},
		sortOrder: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 0,
		},
		active: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: true,
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
	},
	{
		sequelize,
		tableName: 'container',
		schema: 'public',
		timestamps: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
	},
);

ContainerModel.hasMany(ProductVariantModel, {
	foreignKey: 'containerId',
	as: 'productVariants',
});

ProductVariantModel.belongsTo(ContainerModel, {
	foreignKey: 'containerId',
	as: 'container',
});
