/* eslint-disable no-undef */
'use strict';

/**
 * WhatsAppLogService.logError ya aceptaba y enviaba botPhoneNumberId, pero ni
 * la tabla ni el modelo lo declaraban, así que Sequelize lo descartaba en
 * silencio. Con el agente atendiendo varias líneas hace falta saber de qué
 * línea viene cada error.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.addColumn('whatsapp_error_log', 'botPhoneNumberId', {
			type: Sequelize.STRING,
			allowNull: true,
		});

		await queryInterface.addIndex('whatsapp_error_log', ['botPhoneNumberId'], {
			name: 'idx_whatsapp_error_log_bot_phone_number_id',
		});
	},

	async down(queryInterface) {
		await queryInterface.removeIndex(
			'whatsapp_error_log',
			'idx_whatsapp_error_log_bot_phone_number_id',
		);
		await queryInterface.removeColumn(
			'whatsapp_error_log',
			'botPhoneNumberId',
		);
	},
};
