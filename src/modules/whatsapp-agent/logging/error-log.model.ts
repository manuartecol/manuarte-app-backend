import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database';

export class WhatsAppErrorLogModel extends Model {
	public id!: string;
	public context!: string;
	public errorMessage!: string;
	public errorStack!: string | null;
	public phoneNumber!: string | null;
	/** Línea por la que se produjo el error. Null cuando no se pudo determinar. */
	public botPhoneNumberId!: string | null;
	public rawText!: string | null;
}

WhatsAppErrorLogModel.init(
	{
		id: {
			type: DataTypes.UUID,
			allowNull: false,
			defaultValue: DataTypes.UUIDV4,
			primaryKey: true,
		},
		context: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		errorMessage: {
			type: DataTypes.TEXT,
			allowNull: false,
		},
		errorStack: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		phoneNumber: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		botPhoneNumberId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		rawText: {
			type: DataTypes.TEXT,
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
	},
	{
		sequelize,
		tableName: 'whatsapp_error_log',
		schema: 'public',
		timestamps: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
	},
);
