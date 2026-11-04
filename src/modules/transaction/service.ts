import { Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { StockModel } from '../stock/model';
import { StockItemModel } from '../stock-item/model';
import { StockItemService } from '../stock-item/service';
import { TransactionItemModel } from '../transaction-item/model';
import { TransactionItemService } from '../transaction-item/service';
import { TransactionModel } from './model';
import {
	CreateTransactionDto,
	TransactionFilters,
	TransactionState,
	TransactionType,
	UpdateTransactionDto,
} from './types';
import { Op } from 'sequelize';
import { endOfDay, parseISO, startOfDay } from 'date-fns';

export class TransactionService {
	private transactionModel;
	private transactionItemService;
	private stockItemService;

	constructor(transactionModel: typeof TransactionModel) {
		this.transactionModel = transactionModel;
		this.transactionItemService = new TransactionItemService(
			TransactionItemModel,
		);
		this.stockItemService = new StockItemService(StockItemModel);
	}

	getAll = async (
		page: number = 1,
		pageSize: number = 30,
		filters: TransactionFilters,
		stockId?: string,
	) => {
		try {
			const offset = (page - 1) * pageSize;

			// Filtro de fechas
			const dateFilter =
				filters.dateStart && filters.dateEnd
					? {
							createdDate: {
								[Op.between]: [
									startOfDay(parseISO(filters.dateStart)),
									endOfDay(parseISO(filters.dateEnd)),
								],
							},
						}
					: {};

			// Filtros directos
			const stateFilter = filters.state ? { state: filters.state } : {};
			const typeFilter = filters.type ? { type: filters.type } : {};

			let condition: Record<string, unknown> = {};

			if (stockId) {
				// Caso 1: No viene toId ni fromId
				if (!filters.toId && !filters.fromId) {
					condition = {
						[Op.or]: [{ fromId: stockId }, { toId: stockId }],
						...dateFilter,
						...stateFilter,
						...typeFilter,
					};
				}
				// Caso 2: Vienen ambos y ninguno es igual al stockId
				else if (
					filters.toId &&
					filters.fromId &&
					filters.toId !== stockId &&
					filters.fromId !== stockId
				) {
					condition = { id: null }; // Devuelve vacío
				}
				// Caso 3: Vienen ambos y ambos son igual al stockId
				else if (
					filters.toId &&
					filters.fromId &&
					filters.toId === stockId &&
					filters.fromId === stockId
				) {
					condition = { id: null }; // Devuelve vacío
				}
				// Caso 4: Vienen ambos y uno es igual al stockId
				else if (
					filters.toId &&
					filters.fromId &&
					(filters.toId === stockId || filters.fromId === stockId)
				) {
					condition = {
						fromId: filters.fromId,
						toId: filters.toId,
						...dateFilter,
						...stateFilter,
						...typeFilter,
					};
				}
				// Caso 5: Solo viene uno (toId o fromId)
				else if (filters.toId || filters.fromId) {
					condition = {
						[Op.or]: [{ fromId: stockId }, { toId: stockId }],
						...(filters.toId && { toId: filters.toId }),
						...(filters.fromId && { fromId: filters.fromId }),
						...dateFilter,
						...stateFilter,
						...typeFilter,
					};
				}
			} else {
				// Sin stockId (admin)
				if (filters.toId && filters.fromId) {
					condition = {
						[Op.and]: [{ fromId: filters.fromId }, { toId: filters.toId }],
						...dateFilter,
						...stateFilter,
						...typeFilter,
					};
				} else if (filters.toId) {
					condition = {
						toId: filters.toId,
						...dateFilter,
						...stateFilter,
						...typeFilter,
					};
				} else if (filters.fromId) {
					condition = {
						fromId: filters.fromId,
						...dateFilter,
						...stateFilter,
						...typeFilter,
					};
				} else {
					// Sin toId ni fromId: solo filtros generales
					condition = {
						...dateFilter,
						...stateFilter,
						...typeFilter,
					};
				}
			}

			const { rows: transactions, count: total } =
				await this.transactionModel.findAndCountAll({
					where: condition,
					attributes: [
						'id',
						'name',
						'state',
						'type',
						'fromId',
						[sequelize.col('stockFrom.name'), 'fromName'],
						'toId',
						[sequelize.col('stockTo.name'), 'toName'],
						'supplierId',
						'description',
						'createdDate',
					],
					include: [
						{
							model: StockModel,
							as: 'stockFrom',
							attributes: [],
						},
						{
							model: StockModel,
							as: 'stockTo',
							attributes: [],
						},
					],
					order: [['createdDate', 'DESC']],
					limit: pageSize,
					offset,
				});

			return {
				status: 200,
				data: {
					transactions,
					total,
					page,
					pageSize,
					totalPages: Math.ceil(total / pageSize),
				},
			};
		} catch (error) {
			console.error('Error obteniendo transacciones');
			throw error;
		}
	};

	create = async (transactionData: CreateTransactionDto) => {
		const sqlTransaction = await sequelize.transaction();
		try {
			const existing = await this.transactionModel.findOne({
				where: { clientRequestId: transactionData?.clientRequestId },
			});
			if (existing) {
				throw new Error('Ya se procesó esta solicitud');
			}

			// Validar que no haya productVariantId duplicados
			const productVariantIds = transactionData.items.map(
				item => item.productVariantId,
			);
			const uniqueIds = new Set(productVariantIds);

			if (productVariantIds.length !== uniqueIds.size) {
				throw new Error(
					'No se pueden agregar productos repetidos en la misma transacción. Si necesitas enviar más cantidad, incrementa la cantidad del item existente.',
				);
			}

			const { items, ...transactionDataRest } = transactionData;

			if (items.length === 0) {
				throw new Error(
					'Es necesario al menos 1 item para crear una transacción',
				);
			}

			/**
			 * Si esto acepta una transferencia, se comprueba antes de escribir nada
			 * que siga pendiente. `clientRequestId` solo frena el reenvío idéntico
			 * de la misma petición: dos pestañas, o un listado cargado antes de que
			 * otro la aceptara, mandan dos peticiones distintas, y la segunda volvía
			 * a sumar las unidades al destino y a dejar la transferencia en SUCCESS
			 */
			if (transactionData?.transferId) {
				await this.assertTransferIsPending(
					transactionData.transferId,
					sqlTransaction,
				);
			}

			/**
			 * Los items de una transferencia llevan el `stockItemId` del origen, así
			 * que nada miraba la bodega de destino. Se comprueba aquí, antes de
			 * egresar del origen: crear una transferencia hacia una bodega donde la
			 * presentación está desactivada la deja imposible de aceptar, con las
			 * unidades fuera del origen y sin ningún sitio al que entrar
			 */
			if (
				transactionData?.type === TransactionType.TRANSFER &&
				transactionData?.toId
			) {
				await this.stockItemService.assertVariantsAvailableInStock(
					transactionData.toId,
					productVariantIds,
					sqlTransaction,
				);
			}

			const newTransaction = await this.transactionModel.create(
				{
					...transactionDataRest,
					name: this.generateName(transactionData?.type),
					state:
						transactionData?.type !== TransactionType.TRANSFER
							? TransactionState.SUCCESS
							: TransactionState.PROGRESS,
					shippingDate: sequelize.fn('now'),
				},
				{ transaction: sqlTransaction },
			);

			for (const item of items) {
				await this.transactionItemService.create(
					{
						transactionItemData: {
							...item,
							transactionId: newTransaction.dataValues.id,
						},
						isEnter: transactionData?.type === TransactionType.ENTER,
					},
					sqlTransaction,
				);
			}

			if (transactionData?.transferId) {
				await this.updateTransfer(
					{ state: TransactionState.SUCCESS },
					transactionData?.transferId,
					sqlTransaction,
				);
			}

			await sqlTransaction.commit();

			return { status: 200, newTransaction };
		} catch (error) {
			await sqlTransaction.rollback();
			console.error('Error creando transacción');
			throw error;
		}
	};

	/**
	 * Una transferencia solo se puede aceptar una vez. La comprobación va aquí y
	 * no solo en `updateTransfer` para que falle antes de tocar el stock: dentro
	 * de `create` el rollback deshace las unidades igual, pero el usuario vería
	 * un error de escritura en vez de saber que ya estaba aceptada
	 */
	private assertTransferIsPending = async (
		transferId: string,
		sqlTransaction: Transaction,
	) => {
		const transfer = await this.transactionModel.findByPk(transferId, {
			transaction: sqlTransaction,
		});

		if (!transfer) {
			throw new Error('Transferencia no encontrada');
		}

		if (transfer.dataValues.type !== TransactionType.TRANSFER) {
			throw new Error('El movimiento indicado no es una transferencia');
		}

		if (transfer.dataValues.state !== TransactionState.PROGRESS) {
			throw new Error(
				'Esta transferencia ya fue aceptada. Actualiza la lista para ver las que siguen pendientes',
			);
		}
	};

	updateTransfer = async (
		transactionData: UpdateTransactionDto,
		id: string,
		sqlTransaction?: Transaction,
	) => {
		const mainSqlTransaction =
			sqlTransaction || (await sequelize.transaction());
		try {
			const transactionToUpdate = await this.transactionModel.findByPk(id, {
				transaction: mainSqlTransaction,
			});
			if (!transactionToUpdate) {
				throw new Error('Transferencia no encontrada');
			}

			/**
			 * La misma guarda que en `create`, por si llaman a `PUT /transfer/:id`
			 * directamente: marcar SUCCESS una transferencia que ya lo está no
			 * tendría efecto aquí, pero deja la puerta abierta a que el llamador
			 * crea que acaba de aceptarla
			 */
			if (
				transactionData?.state === TransactionState.SUCCESS &&
				transactionToUpdate.dataValues.state !== TransactionState.PROGRESS
			) {
				throw new Error('Esta transferencia ya fue aceptada');
			}

			await transactionToUpdate.update(
				{ ...transactionData },
				{
					transaction: mainSqlTransaction,
				},
			);

			if (
				transactionData?.items &&
				transactionToUpdate?.dataValues?.state === TransactionState.PROGRESS
			) {
				for (const item of transactionData.items) {
					await this.transactionItemService.update(item, mainSqlTransaction);
				}
			}

			if (!sqlTransaction) {
				await mainSqlTransaction.commit();
			}

			return { status: 200, updatedTransaction: transactionToUpdate };
		} catch (error) {
			if (!sqlTransaction) {
				await mainSqlTransaction.rollback();
			}
			console.error('Error actualizando transacción');
			throw error;
		}
	};

	private generateName = (transactionType: TransactionType) => {
		const currentDate = new Date();
		const timestamp = currentDate.getTime();
		const formattedDate = new Date(timestamp).toLocaleDateString('es-EC', {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
		});

		return `${transactionType}_${formattedDate}_${timestamp}`;
	};
}
