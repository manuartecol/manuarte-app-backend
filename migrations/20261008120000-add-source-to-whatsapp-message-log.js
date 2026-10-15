/* eslint-disable no-undef */
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.addColumn('whatsapp_message_log', 'source', {
			type: Sequelize.STRING(16),
			allowNull: true,
		});

		await queryInterface.addColumn('whatsapp_message_log', 'messageId', {
			type: Sequelize.STRING,
			allowNull: true,
		});

		await queryInterface.addIndex('whatsapp_message_log', ['messageId'], {
			name: 'idx_whatsapp_message_log_message_id',
		});
	},

	async down(queryInterface) {
		await queryInterface.removeIndex(
			'whatsapp_message_log',
			'idx_whatsapp_message_log_message_id',
		);
		await queryInterface.removeColumn('whatsapp_message_log', 'messageId');
		await queryInterface.removeColumn('whatsapp_message_log', 'source');
	},
};
