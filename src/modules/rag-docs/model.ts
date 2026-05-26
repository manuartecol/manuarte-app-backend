import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../config/database';

export class RagDocModel extends Model {
	public id!: number;
	public type!: 'datasheet' | 'faq';
	public title!: string;
	public content!: string;
	// La columna `embedding` (vector(1536)) no se define aquí porque Sequelize
	// no tiene soporte nativo para el tipo vector de pgvector.
	// Se gestiona exclusivamente mediante consultas SQL directas en RagDocService.
}

RagDocModel.init(
	{
		id: {
			type: DataTypes.INTEGER,
			autoIncrement: true,
			primaryKey: true,
		},
		type: {
			type: DataTypes.STRING(32),
			allowNull: false,
		},
		title: {
			type: DataTypes.STRING(255),
			allowNull: false,
		},
		content: {
			type: DataTypes.TEXT,
			allowNull: false,
		},
	},
	{
		sequelize,
		tableName: 'rag_docs',
		createdAt: 'createdDate',
		updatedAt: 'updatedDate',
	},
);
