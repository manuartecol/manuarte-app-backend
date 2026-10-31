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

			if (products.length > 0) {
				res.status(200).json(products);
			} else {
				res.sendStatus(204);
			}
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

	delete: Handler = async (req, res, next) => {
		try {
			const productId = (req.query.productId as string) || '';
			const productVariantId = (req.query.productVariantId as string) || '';

			const result = await this.productService.delete(
				productId,
				productVariantId,
			);

			const productDeleted = result.productDeleted === 1;

			res.status(200).json({
				productDeleted,
				message: productDeleted
					? 'Producto y su presentación eliminados con éxito'
					: 'Presentación del producto eliminada con éxito',
			});
		} catch (error) {
			next(error);
		}
	};
}
