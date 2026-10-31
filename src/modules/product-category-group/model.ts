import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../config/database';
import { ProductCategoryModel } from '../product-category/model';

export class ProductCategoryGroupModel extends Model {}

ProductCategoryGroupModel.init(
	{
		id: {
			type: DataTypes.UUID,
			primaryKey: true,
			allowNull: false,
			defaultValue: DataTypes.UUIDV4,
		},
		name: {
			type: DataTypes.STRING,
			allowNull: false,
			unique: true,
		},
		createdBy: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		updatedBy: {
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
	},
	{
		sequelize,
		tableName: 'product_category_group',
		schema: 'public',
		timestamps: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
		deletedAt: 'deletedDate',
	},
);

ProductCategoryGroupModel.hasMany(ProductCategoryModel, {
	foreignKey: 'productCategoryGroupId',
	as: 'productCategories',
});

ProductCategoryModel.belongsTo(ProductCategoryGroupModel, {
	foreignKey: 'productCategoryGroupId',
	as: 'productCategoryGroup',
});
