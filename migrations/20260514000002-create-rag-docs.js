/* eslint-disable no-undef */
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.createTable('rag_docs', {
			id: {
				type: Sequelize.INTEGER,
				autoIncrement: true,
				primaryKey: true,
			},
			type: {
				type: Sequelize.STRING(32),
				allowNull: false,
			},
			title: {
				type: Sequelize.STRING(255),
				allowNull: false,
			},
			content: {
				type: Sequelize.TEXT,
				allowNull: false,
			},
			createdDate: {
				type: Sequelize.DATE,
				allowNull: false,
				defaultValue: Sequelize.literal('now()'),
			},
			updatedDate: {
				type: Sequelize.DATE,
				allowNull: false,
				defaultValue: Sequelize.literal('now()'),
			},
		});

		// Agregar la columna embedding como vector(1536) usando SQL directo
		// ya que Sequelize no tiene soporte nativo para el tipo vector de pgvector
		await queryInterface.sequelize.query(
			'ALTER TABLE rag_docs ADD COLUMN embedding vector(1536);',
		);

		// Índice para búsqueda de similitud coseno (ivfflat)
		await queryInterface.sequelize.query(
			'CREATE INDEX ON rag_docs USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);',
		);
	},

	async down(queryInterface) {
		await queryInterface.dropTable('rag_docs');
	},
};
