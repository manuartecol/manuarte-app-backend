import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../config/database';
import { ProductVariantModel } from '../product-variant/model';
import { AttributeTypeModel } from '../attribute-type/model';

export class ProductVariantAttributeModel extends Model {
	public id!: string;
	public productVariantId!: string;
	public attributeTypeId!: string;
	public value!: string;
}

ProductVariantAttributeModel.init(
	{
		id: {
			type: DataTypes.UUID,
			primaryKey: true,
			allowNull: false,
			defaultValue: DataTypes.UUIDV4,
		},
		productVariantId: {
			type: DataTypes.UUID,
			allowNull: false,
			references: {
				model: 'product_variant',
				key: 'id',
			},
		},
		attributeTypeId: {
			type: DataTypes.UUID,
			allowNull: false,
			references: {
				model: 'attribute_type',
				key: 'id',
			},
		},
		value: {
			type: DataTypes.STRING(120),
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
	},
	{
		sequelize,
		tableName: 'product_variant_attribute',
		schema: 'public',
		timestamps: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
		indexes: [
			{
				name: 'uq_product_variant_attribute_variant_type',
				unique: true,
				fields: [{ name: 'productVariantId' }, { name: 'attributeTypeId' }],
			},
		],
	},
);

ProductVariantModel.hasMany(ProductVariantAttributeModel, {
	foreignKey: 'productVariantId',
	as: 'attributes',
});

ProductVariantAttributeModel.belongsTo(ProductVariantModel, {
	foreignKey: 'productVariantId',
	as: 'productVariant',
});

AttributeTypeModel.hasMany(ProductVariantAttributeModel, {
	foreignKey: 'attributeTypeId',
	as: 'productVariantAttributes',
});

ProductVariantAttributeModel.belongsTo(AttributeTypeModel, {
	foreignKey: 'attributeTypeId',
	as: 'attributeType',
});
