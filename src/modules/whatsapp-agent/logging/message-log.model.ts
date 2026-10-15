import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database';

/**
 * Quién originó el mensaje. `direction` dice si entra o sale; `source`
 * distingue lo que el agente envió de lo que una persona escribió desde
 * WhatsApp Business App, que con Coexistence sale por el mismo número.
 */
export type MessageSource = 'customer' | 'ai' | 'human';

export class WhatsAppMessageLogModel extends Model {
	public id!: string;
	public phoneNumber!: string;
	public botPhoneNumberId!: string;
	public direction!: 'inbound' | 'outbound';
	public text!: string;
	public intent!: string | null;
	public countryPrefix!: string | null;
	public source!: MessageSource | null;
	public messageId!: string | null;
}

WhatsAppMessageLogModel.init(
	{
		id: {
			type: DataTypes.UUID,
			allowNull: false,
			defaultValue: DataTypes.UUIDV4,
			primaryKey: true,
		},
		phoneNumber: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		botPhoneNumberId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		direction: {
			type: DataTypes.ENUM('inbound', 'outbound'),
			allowNull: false,
		},
		text: {
			type: DataTypes.TEXT,
			allowNull: false,
		},
		intent: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		countryPrefix: {
			type: DataTypes.STRING(10),
			allowNull: true,
		},
		source: {
			type: DataTypes.STRING(16),
			allowNull: true,
		},
		messageId: {
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
	},
	{
		sequelize,
		tableName: 'whatsapp_message_log',
		schema: 'public',
		timestamps: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
	},
);
