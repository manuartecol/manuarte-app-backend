import { ProductVariantService } from './service';
import { Handler } from 'express';
import { CustomRequest } from '../types';

export class ProductVariantController {
	private productVariantService;

	constructor(productVariantService: ProductVariantService) {
		this.productVariantService = productVariantService;
	}

	getAll: Handler = async (req, res, next) => {
		try {
			const page = parseInt(req.query.page as string) || 1;
			const pageSize = parseInt(req.query.pageSize as string) || 30;

			const filters = {
				vId: req.query.vId as string,
				productName: req.query.productName as string,
				variantName: req.query.name as string,
				productDescription: req.query.productDescription as string,
				productCategoryName: req.query.productCategoryName as string,
				// 'all' lista activas e inactivas. Sin el parámetro, solo activas,
				// como antes: así no cambia ningún enlace ni cliente existente
				showActiveOnly:
					req.query.showActiveOnly === 'all'
						? null
						: req.query.showActiveOnly !== 'false',
			};

			const result = await this.productVariantService.getAll(
				page,
				pageSize,
				filters,
			);

			/**
			 * Siempre 200 con el cuerpo completo, también con la lista vacía. Con el
			 * 204 que había antes, axios resolvía con el cuerpo vacío y el panel
			 * guardaba `undefined` donde esperaba el arreglo de presentaciones: la
			 * tabla se veía igual, pero la siguiente creación de un producto
			 * reventaba al expandirlo. Una página sin resultados es un resultado
			 */
			res.status(200).json(result);
		} catch (error) {
			next(error);
		}
	};

	getCatalog: Handler = async (_req, res, next) => {
		try {
			const catalog = await this.productVariantService.getCatalog();

			res.status(200).json(catalog);
		} catch (error) {
			next(error);
		}
	};

	searchByNameOrCode: Handler = async (req, res, next) => {
		try {
			const { stockId } = req.params;
			const search = (req.query.search as string) || '';
			const missingProducts = req.query.missingProducts === 'true';
			const includeInactive = req.query.includeInactive === 'true';

			const result = await this.productVariantService.searchByNameOrCode(
				stockId,
				search,
				missingProducts as boolean,
				includeInactive,
			);
			if (result.status !== 200) {
				res.sendStatus(400);
			}

			res.status(result.status).json(result.productVariants);
		} catch (error) {
			next(error);
		}
	};

	bulkSearch: Handler = async (req, res, next) => {
		try {
			const { stockId } = req.params;

			const result = await this.productVariantService.bulkSearch(
				req.body,
				stockId,
			);

			if (result.status !== 200) {
				res.sendStatus(400);
			}

			res.status(result.status).json(result.productVariants);
		} catch (error) {
			next(error);
		}
	};

	update: Handler = async (req, res, next) => {
		try {
			const { id } = req.params;
			const { name, active, stockIds, axes } = req.body;
			const requestedBy = (req as CustomRequest).requestedBy;

			await this.productVariantService.update({
				id,
				name,
				active,
				stockIds,
				axes,
				requestedBy,
			});

			res.status(200).json({
				message: 'Presentación del producto actualizada con éxito',
			});
		} catch (error) {
			next(error);
		}
	};
}
