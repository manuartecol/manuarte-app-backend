import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../config/database';

export class AttributeTypeModel extends Model {
	public id!: string;
	public code!: string;
	public label!: string;
	public valueTemplate!: string;
	public sortOrder!: number;
	public active!: boolean;
}

AttributeTypeModel.init(
	{
		id: {
			type: DataTypes.UUID,
			primaryKey: true,
			allowNull: false,
			defaultValue: DataTypes.UUIDV4,
		},
		code: {
			type: DataTypes.STRING(32),
			allowNull: false,
			unique: true,
		},
		label: {
			type: DataTypes.STRING(48),
			allowNull: false,
		},
		valueTemplate: {
			type: DataTypes.STRING(48),
			allowNull: false,
			defaultValue: '{value}',
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
		tableName: 'attribute_type',
		schema: 'public',
		timestamps: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
	},
);
