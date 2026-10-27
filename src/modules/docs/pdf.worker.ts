import { parentPort, workerData } from 'worker_threads';
import React from 'react';
import ReactPDF, { renderToBuffer } from '@react-pdf/renderer';
import PDFDoc, { DocData } from './components/PDFDoc';

/**
 * Genera un PDF en un hilo aparte. Lo lanza `DocsService.render`, que es quien
 * pone el tiempo máximo y el límite de memoria.
 *
 * Va en un hilo porque `renderToBuffer` calcula la paginación de forma
 * síncrona: si la plantilla entra en un bucle (pasó con el `marginBottom` de la
 * tabla), en el hilo principal bloqueaba el servidor entero. Aquí solo bloquea
 * este hilo, y el principal lo puede terminar.
 */
const { isQuote, data } = workerData as { isQuote: boolean; data: DocData };

renderToBuffer(
	React.createElement(PDFDoc, {
		isQuote,
		data,
	}) as React.ReactElement<ReactPDF.DocumentProps>,
).then(buffer => {
	parentPort?.postMessage(buffer);
});
