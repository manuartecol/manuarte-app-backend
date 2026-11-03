import { Router } from 'express';
import { ProductController } from './controller';
import { ProductService } from './service';
import { ProductModel } from './model';
import { authorize } from '../../middlewares/authorize';
import { ProductPermissions } from '../permission/enums';

const router = Router();

const productService = new ProductService(ProductModel);

const productController = new ProductController(productService);

router.get(
	'/',
	authorize(ProductPermissions.PRODUCT_READ),
	productController.getAll,
);
router.get(
	'/with-variants',
	authorize(ProductPermissions.PRODUCT_READ),
	productController.getAllWithVariants,
);
router.get(
	'/deletion-preview',
	authorize(ProductPermissions.PRODUCT_DELETE),
	productController.deletionPreview,
);
router.post(
	'/',
	authorize(ProductPermissions.PRODUCT_CREATE),
	productController.create,
);
router.post(
	'/add-variant/:id',
	authorize(ProductPermissions.PRODUCT_CREATE),
	productController.addVariant,
);
router.put(
	'/:id',
	authorize(ProductPermissions.PRODUCT_UPDATE),
	productController.update,
);
router.delete(
	'/',
	authorize(ProductPermissions.PRODUCT_DELETE),
	productController.delete,
);

export default router;
