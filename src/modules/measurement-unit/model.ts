import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../config/database';
import { ProductVariantModel } from '../product-variant/model';

export class MeasurementUnitModel extends Model {
	public id!: string;
	public code!: string;
	public label!: string;
	public labelPlural!: string | null;
	public name!: string;
	public dimension!: 'mass' | 'volume' | 'count' | 'length';
	public factorToBase!: string;
	public sortOrder!: number;
	public active!: boolean;
}

MeasurementUnitModel.init(
	{
		id: {
			type: DataTypes.UUID,
			primaryKey: true,
			allowNull: false,
			defaultValue: DataTypes.UUIDV4,
		},
		code: {
			type: DataTypes.STRING(12),
			allowNull: false,
			unique: true,
		},
		label: {
			type: DataTypes.STRING(24),
			allowNull: false,
		},
		/**
		 * Solo las unidades que son palabras lo tienen: "docenas", "galones",
		 * "unidades". Las abreviaturas van en null y la composición cae a `label`,
		 * porque "3 g" es correcto y "3 gs" no
		 */
		labelPlural: {
			type: DataTypes.STRING(32),
			allowNull: true,
		},
		name: {
			type: DataTypes.STRING(48),
			allowNull: false,
		},
		dimension: {
			type: DataTypes.ENUM('mass', 'volume', 'count', 'length'),
			allowNull: false,
		},
		/**
		 * DECIMAL llega como string desde `pg`, a propósito: convertirlo a `number`
		 * perdería precisión en galón (3785.411784). La composición lo pasa por
		 * `Number()` una sola vez, al multiplicar
		 */
		factorToBase: {
			type: DataTypes.DECIMAL(16, 6),
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
		tableName: 'measurement_unit',
		schema: 'public',
		timestamps: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
	},
);

MeasurementUnitModel.hasMany(ProductVariantModel, {
	foreignKey: 'unitId',
	as: 'productVariants',
});

ProductVariantModel.belongsTo(MeasurementUnitModel, {
	foreignKey: 'unitId',
	as: 'unit',
});
