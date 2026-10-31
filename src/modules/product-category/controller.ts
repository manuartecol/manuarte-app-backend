import { ProductCategoryService } from './service';
import { Handler } from 'express';
import { CustomRequest } from '../types';

export class ProductCategoryController {
	private productCategoryService;

	constructor(productCategoryService: ProductCategoryService) {
		this.productCategoryService = productCategoryService;
	}

	create: Handler = async (req, res, next) => {
		try {
			const { name, productCategoryGroupId } = req.body;
			const requestedBy = (req as CustomRequest).requestedBy;
			const newProductCategory = await this.productCategoryService.create({
				name,
				productCategoryGroupId,
				requestedBy,
			});

			res.status(201).json({
				newProductCategory,
				message: 'Categoría de producto creada con éxito',
			});
		} catch (error) {
			next(error);
		}
	};

	getAll: Handler = async (_req, res, next) => {
		try {
			const categories = await this.productCategoryService.getAll();

			if (categories && categories.length > 0) {
				res.status(200).json(categories);
			} else {
				res.sendStatus(204);
			}
		} catch (error) {
			next(error);
		}
	};

	getGroups: Handler = async (_req, res, next) => {
		try {
			const groups = await this.productCategoryService.getGroups();

			res.status(200).json(groups);
		} catch (error) {
			next(error);
		}
	};

	update: Handler = async (req, res, next) => {
		try {
			const { id } = req.params;
			const { name, productCategoryGroupId } = req.body;
			const requestedBy = (req as CustomRequest).requestedBy;

			const updatedProductCategory = await this.productCategoryService.update({
				id,
				name,
				productCategoryGroupId,
				requestedBy,
			});

			res.status(200).json({
				updatedProductCategory,
				message: 'Categoría de producto actualizada con éxito',
			});
		} catch (error) {
			next(error);
		}
	};

	delete: Handler = async (req, res, next) => {
		try {
			const { id } = req.params;

			const result = await this.productCategoryService.delete(id);

			if (!result?.success) {
				res.status(400).json({ message: result?.message });
			} else {
				res.status(200).json({
					message: 'La categoría de producto fue eliminada con éxito',
				});
			}
		} catch (error) {
			next(error);
		}
	};
}
