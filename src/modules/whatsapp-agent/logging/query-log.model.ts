import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database';

export class WhatsAppQueryLogModel extends Model {
	public id!: string;
	public phoneNumber!: string;
	public botPhoneNumberId!: string;
	public rawText!: string;
	public searchTerms!: string[];
	public productFound!: boolean;
	public suggestionsShown!: boolean;
	public replyText!: string;
	public countryPrefix!: string | null;
}

WhatsAppQueryLogModel.init(
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
		rawText: {
			type: DataTypes.TEXT,
			allowNull: false,
		},
		searchTerms: {
			type: DataTypes.ARRAY(DataTypes.TEXT),
			allowNull: false,
			defaultValue: [],
		},
		productFound: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		},
		suggestionsShown: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		},
		replyText: {
			type: DataTypes.TEXT,
			allowNull: false,
		},
		countryPrefix: {
			type: DataTypes.STRING(10),
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
		tableName: 'whatsapp_query_log',
		schema: 'public',
		timestamps: true,
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
	},
);
