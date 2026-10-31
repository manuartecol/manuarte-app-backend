import { Router } from 'express';
import { ProductCategoryController } from './controller';
import { ProductCategoryService } from './service';
import { ProductCategoryModel } from './model';
import { authorize } from '../../middlewares/authorize';
import { ProductPermissions } from '../permission/enums';

const router = Router();

const productCategoryService = new ProductCategoryService(ProductCategoryModel);

const productCategoryController = new ProductCategoryController(
	productCategoryService,
);

router.post(
	'/',
	authorize(ProductPermissions.PRODUCT_CREATE),
	productCategoryController.create,
);
router.get(
	'/',
	authorize(ProductPermissions.PRODUCT_READ),
	productCategoryController.getAll,
);
router.get(
	'/groups',
	authorize(ProductPermissions.PRODUCT_READ),
	productCategoryController.getGroups,
);
router.put(
	'/:id',
	authorize(ProductPermissions.PRODUCT_UPDATE),
	productCategoryController.update,
);
router.delete(
	'/:id',
	authorize(ProductPermissions.PRODUCT_DELETE),
	productCategoryController.delete,
);

export default router;
