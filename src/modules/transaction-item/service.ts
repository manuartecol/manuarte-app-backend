import { Transaction } from 'sequelize';
import { StockItemModel } from '../stock-item/model';
import { TransactionItemModel } from './model';
import { CreateTransactionItemDto, UpdateTransactionItemDto } from './types';
import { StockItemService } from '../stock-item/service';
import { ProductVariantModel } from '../product-variant/model';
import { ProductModel } from '../product/model';
import { sequelize } from '../../config/database';

export class TransactionItemService {
	private transactionItemModel;
	private stockItemService;

	constructor(transactionItemModel: typeof TransactionItemModel) {
		this.transactionItemModel = transactionItemModel;
		this.stockItemService = new StockItemService(StockItemModel);
	}

	getByTransactionId = async (transactionId: string, stockId: string) => {
		try {
			// El item de stock de la bodega entra por JOIN. Antes era una llamada a
			// `getOneByStock` por cada ítem: un movimiento de 171 ítems gastaba 172
			// consultas, y cada una traía además `pricePvp`, `priceDis` y `stocks`,
			// que en esta ruta no los usa nadie.
			const transactionItems = await this.transactionItemModel.findAll({
				where: { transactionId },
				attributes: [
					'id',
					'quantity',
					'stockBefore',
					'productVariantId',
					[sequelize.col('productVariants.name'), 'productVariantName'],
					[sequelize.col('productVariants.product.name'), 'productName'],
					[sequelize.col('productVariants.stockItems.id'), 'stockItemId'],
					[
						sequelize.col('productVariants.stockItems.quantity'),
						'stockItemQuantity',
					],
				],
				include: [
					{
						model: ProductVariantModel,
						as: 'productVariants',
						attributes: [],
						include: [
							{
								model: ProductModel,
								as: 'product',
								attributes: [],
							},
							{
								// `required: false` porque el 3% de los ítems históricos ya no
								// tiene item de stock en esa bodega, y perderlos cambiaría el
								// detalle de movimientos viejos
								model: StockItemModel,
								as: 'stockItems',
								where: { stockId },
								attributes: [],
								through: { attributes: [] },
								required: false,
							},
						],
					},
				],
				order: [[sequelize.col('productVariants.product.name'), 'ASC']],
			});

			// Dos normalizaciones sobre el resultado del JOIN:
			//
			// 1. Sin item de stock, el JOIN deja `null` donde el bucle dejaba
			//    `undefined`. La diferencia se nota: `TransactionsForm` calcula el
			//    máximo editable con `Number(quantity) + Number(stockItemQuantity)
			//    || 1`, y `Number(null)` es 0 mientras `Number(undefined)` es NaN,
			//    así que el tope cambiaría en esos ítems.
			//
			// 2. Una línea por `transaction_item`. Nada en la base impide que dos
			//    `stock_item` de la misma bodega apunten a la misma presentación: la
			//    clave de `stock_item_product_variant` es (stockItemId,
			//    productVariantId), así que el par (presentación, bodega) no es
			//    único. Hoy no ocurre en ninguna fila, pero si ocurriera el JOIN
			//    duplicaría líneas del movimiento y el total del panel saldría
			//    inflado. El `findOne` que había antes era inmune por construcción,
			//    y esto le devuelve esa garantía.
			const seen = new Set<string>();
			const formattedItems = [];

			for (const item of transactionItems) {
				if (seen.has(item.dataValues.id)) continue;
				seen.add(item.dataValues.id);

				formattedItems.push({
					...item.dataValues,
					stockItemId: item.dataValues.stockItemId ?? undefined,
					stockItemQuantity: item.dataValues.stockItemQuantity ?? undefined,
				});
			}

			return { status: 200, transactionItems: formattedItems };
		} catch (error) {
			console.error('Error obteniendo items de transacción');
			throw error;
		}
	};

	create = async (
		{
			transactionItemData,
			isEnter,
		}: {
			transactionItemData: CreateTransactionItemDto;
			isEnter: boolean;
		},
		sqlTransaction: Transaction,
	) => {
		try {
			const { stockItemId, ...restItem } = transactionItemData;

			const stockItemToUpdate = await this.stockItemService.getOneById(
				stockItemId,
				sqlTransaction,
			);
			if (!stockItemToUpdate) {
				throw new Error('No fue posible encontrar el item de stock');
			}

			if (
				!isEnter &&
				Number(restItem.quantity) > Number(stockItemToUpdate?.quantity)
			) {
				const { productName, productVariantName } =
					stockItemToUpdate.dataValues ?? {};
				throw new Error(
					`La cantidad a egresar de ${productName} ${productVariantName}, es mayor a la cantidad en stock`,
				);
			}

			const newTransactionItem = await this.transactionItemModel.create(
				{
					...restItem,
					stockBefore: stockItemToUpdate?.quantity,
				},
				{ transaction: sqlTransaction },
			);

			const currentQty = Number(stockItemToUpdate.quantity);
			const delta = Number(restItem.quantity);

			if (isNaN(currentQty) || isNaN(delta)) {
				throw new Error(
					`Ocurrió un error con las cantidades del item ${stockItemToUpdate.dataValues.productName} - ${stockItemToUpdate.dataValues.productVariantName}`,
				);
			}

			const newQuantity = isEnter ? currentQty + delta : currentQty - delta;

			await stockItemToUpdate.update(
				{ quantity: newQuantity },
				{ transaction: sqlTransaction },
			);

			const stockItemCheck = await StockItemModel.findByPk(stockItemId, {
				transaction: sqlTransaction,
			});

			if (Number(stockItemCheck?.quantity) !== newQuantity) {
				throw new Error(
					`Cantidad a actualizar era ${newQuantity}, pero se encontró ${stockItemCheck?.quantity}`,
				);
			}

			return newTransactionItem;
		} catch (error) {
			console.error('Error creando items de transacción');
			throw error;
		}
	};

	update = async (
		transactionItemData: UpdateTransactionItemDto,
		sqlTransaction: Transaction,
	) => {
		try {
			const { stockItemId, id, ...restItem } = transactionItemData;

			const stockItemToUpdate = await this.stockItemService.getOneById(
				stockItemId,
				sqlTransaction,
			);
			if (!stockItemToUpdate) {
				throw new Error('No fue posible encontrar item de stock');
			}

			const transactionItemToUpdate = await this.transactionItemModel.findByPk(
				id,
				{ transaction: sqlTransaction },
			);
			if (!transactionItemToUpdate) {
				throw new Error('No fue posible encontrar item de transacción');
			}

			if (
				Number(restItem.quantity) >
				Number(transactionItemToUpdate?.dataValues?.quantity) +
					Number(stockItemToUpdate?.dataValues?.quantity)
			) {
				const { productName, productVariantName } =
					stockItemToUpdate.dataValues ?? {};
				throw new Error(
					`La cantidad a transferir de ${productName} ${productVariantName}, es mayor a la cantidad en stock`,
				);
			}

			const currentTransactionItemQty = Number(
				transactionItemToUpdate?.dataValues?.quantity,
			);
			const currentStockItemQty = Number(
				stockItemToUpdate?.dataValues?.quantity,
			);
			const delta = Number(restItem?.quantity);

			if (
				isNaN(currentTransactionItemQty) ||
				isNaN(currentStockItemQty) ||
				isNaN(delta)
			) {
				throw new Error(
					`Ocurrió un error con las cantidades del item ${stockItemToUpdate.dataValues.productName} - ${stockItemToUpdate.dataValues.productVariantName}`,
				);
			}

			const newStockItemQuantity =
				currentTransactionItemQty + currentStockItemQty - delta;

			await transactionItemToUpdate.update(
				{ quantity: delta },
				{ transaction: sqlTransaction },
			);

			await stockItemToUpdate.update(
				{ quantity: newStockItemQuantity },
				{ transaction: sqlTransaction },
			);

			return transactionItemToUpdate;
		} catch (error) {
			console.error('Error actualizando items de transascción');
			throw error;
		}
	};
}
