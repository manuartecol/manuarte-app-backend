import { Op } from 'sequelize';
import { sequelize } from '../../../config/database';

/**
 * Los vendedores y los clientes no escriben tildes: buscar "velon" tiene que
 * encontrar "Velón". Se quitan de los dos lados, del texto buscado aquí y de la
 * columna con `unaccent`, porque quien sí las escribe también debe encontrarlo
 */
export const normalizeSearch = (text: string): string =>
	text
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();

// `column` es SQL escrito en el código, nunca texto del usuario
export const containsText = (column: string, search: string) =>
	sequelize.where(sequelize.literal(`unaccent(lower(${column}))`), {
		[Op.iLike]: `%${normalizeSearch(search)}%`,
	});
