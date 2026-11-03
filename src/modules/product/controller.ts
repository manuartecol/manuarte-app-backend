import { ProductService } from './service';
import { Handler } from 'express';
import { CustomRequest } from '../types';

export class ProductController {
	private productService;

	constructor(productService: ProductService) {
		this.productService = productService;
	}

	getAll: Handler = async (_req, res, next) => {
		try {
			const products = await this.productService.getAll();

			// Mismo criterio: la lista vacía viaja como arreglo vacío, no como 204
			res.status(200).json(products);
		} catch (error) {
			next(error);
		}
	};

	create: Handler = async (req, res, next) => {
		try {
			const { productVariants, stocks, ...rest } = req.body;
			const requestedBy = (req as CustomRequest).requestedBy;

			const newProduct = await this.productService.create({
				productData: rest,
				productVariants,
				stocks,
				requestedBy,
			});

			res
				.status(201)
				.json({ newProduct, message: 'Producto agregado con éxito' });
		} catch (error) {
			next(error);
		}
	};

	update: Handler = async (req, res, next) => {
		try {
			const { id } = req.params;
			const { productVariant, stockIds, name, description, productCategoryId } =
				req.body;
			const requestedBy = (req as CustomRequest).requestedBy;

			// Solo los campos editables. Con el resto del body tal cual, se podía
			// sobrescribir `pId` u otra columna mandándola en la petición
			await this.productService.update({
				id,
				productData: { name, description, productCategoryId },
				productVariantData: productVariant,
				stockIds,
				requestedBy,
			});

			res.status(200).json({ message: 'Producto actualizado con éxito' });
		} catch (error) {
			next(error);
		}
	};

	addVariant: Handler = async (req, res, next) => {
		try {
			const { id } = req.params;
			const requestedBy = (req as CustomRequest).requestedBy;
			const { stocks, ...restBody } = req.body;

			const newProductVariant = await this.productService.addVariant({
				productId: id,
				productVariant: restBody,
				stocks,
				requestedBy,
			});

			res.status(201).json({
				newProductVariant,
				message: 'Presentación del producto creada con éxito',
			});
		} catch (error) {
			next(error);
		}
	};

	getAllWithVariants: Handler = async (req, res, next) => {
		try {
			const page = Number(req.query.page) || 1;
			const pageSize = Number(req.query.pageSize) || 30;

			const result = await this.productService.getAllWithVariants(
				page,
				pageSize,
				{
					pId: req.query.pId as string,
					name: req.query.productName as string,
					description: req.query.productDescription as string,
					productCategoryName: req.query.productCategoryName as string,
				},
			);

			res.status(200).json(result);
		} catch (error) {
			next(error);
		}
	};

	deletionPreview: Handler = async (req, res, next) => {
		try {
			const productId = (req.query.productId as string) || '';
			const productVariantId = (req.query.productVariantId as string) || '';

			const preview = await this.productService.getDeletionPreview(
				productId,
				productVariantId,
			);

			res.status(200).json(preview);
		} catch (error) {
			next(error);
		}
	};

	delete: Handler = async (req, res, next) => {
		try {
			const productId = (req.query.productId as string) || '';
			const productVariantId = (req.query.productVariantId as string) || '';

			const { productDeleted, mode } = await this.productService.delete(
				productId,
				productVariantId,
			);

			const subject = productDeleted
				? 'Producto y su presentación eliminados con éxito'
				: 'Presentación del producto eliminada con éxito';

			res.status(200).json({
				productDeleted,
				mode,
				message:
					mode === 'logical'
						? `${subject}. Se conserva su historial de facturas, cotizaciones y movimientos`
						: subject,
			});
		} catch (error) {
			next(error);
		}
	};
}
