import { Handler } from 'express';
import { CustomerService } from './service';

export class CustomerController {
	private customerService;

	constructor(customerService: CustomerService) {
		this.customerService = customerService;
	}

	getAll: Handler = async (req, res, next) => {
		try {
			const page = parseInt(req.query.page as string) || 1;
			const pageSize = parseInt(req.query.pageSize as string) || 30;
			const isoCode = req.query.isoCode as string;

			const filters = {
				dni: req.query.dni as string,
				fullName: req.query.fullName as string,
				email: req.query.email as string,
				phoneNumber: req.query.phoneNumber as string,
				cityName: req.query.cityName as string,
			};

			const result = await this.customerService.getAll(
				page,
				pageSize,
				filters,
				isoCode,
			);

			/**
			 * Siempre 200 con el cuerpo completo, también con la lista vacía. Con el
			 * 204 que había antes, axios resolvía con el cuerpo vacío y el panel
			 * guardaba `undefined` donde esperaba el arreglo: la tabla se veía igual,
			 * pero la siguiente escritura sobre esa lista reventaba al expandirla
			 */
			res.status(200).json(result);
		} catch (error) {
			next(error);
		}
	};

	getById: Handler = async (req, res, next) => {
		try {
			const { id } = req.params;
			const customer = await this.customerService.getById(id);
			if (!customer) {
				res.sendStatus(404);
				return;
			}
			res.status(200).json(customer);
		} catch (error) {
			next(error);
		}
	};

	create: Handler = async (req, res, next) => {
		try {
			const result = await this.customerService.create(req.body);
			if (result.status !== 201) {
				res.sendStatus(500);
				return;
			}

			res.status(result.status).json({
				newCustomer: result.customer,
				message: 'Cliente registrado con éxito',
			});
		} catch (error) {
			next(error);
		}
	};

	update: Handler = async (req, res, next) => {
		try {
			const { personId } = req.params;
			const result = await this.customerService.update({
				...req.body,
				personId,
			});
			if (result.status !== 200) {
				res.sendStatus(500);
				return;
			}

			res.status(result.status).json({
				updatedCustomer: result.updatedCustomer,
				message: 'Cliente actualizado con éxito',
			});
		} catch (error) {
			next(error);
		}
	};

	delete: Handler = async (req, res, next) => {
		try {
			const { personId } = req.params;
			const result = await this.customerService.delete(personId);

			res.status(result.status).json({ message: result.message });
		} catch (error) {
			next(error);
		}
	};

	searchCustomer: Handler = async (req, res, next) => {
		try {
			const search = (req.query.search as string) || '';
			const isoCode = (req.query.isoCode as string) || '';

			const result = await this.customerService.searchCustomer(search, isoCode);

			res.status(result.status).json(result.customer);
		} catch (error) {
			next(error);
		}
	};

	getStats: Handler = async (req, res, next) => {
		try {
			const { id } = req.params;
			const result = await this.customerService.getStats(id);

			if (result.status !== 200) {
				res.sendStatus(500);
				return;
			}

			res.status(result.status).json(result.customer);
		} catch (error) {
			next(error);
		}
	};

	getTop: Handler = async (req, res, next) => {
		try {
			const page = parseInt(req.query.page as string) || 1;
			const pageSize = parseInt(req.query.pageSize as string) || 30;
			const isoCode = (req.query.isoCode as string) || '';

			const filters = {
				dni: req.query.dni as string,
				fullName: req.query.fullName as string,
				cityName: req.query.cityName as string,
			};

			const result = await this.customerService.getTop(
				page,
				pageSize,
				filters,
				isoCode,
			);

			// Mismo criterio que en `getAll`: la lista vacía viaja con su cuerpo
			res.status(200).json(result);
		} catch (error) {
			next(error);
		}
	};
}
