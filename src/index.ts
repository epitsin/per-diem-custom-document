import { Request, Response } from 'express';
import dotenv from 'dotenv';

import { PerDiemDocumentBuilder } from './PerdiemDocumentBuilder';

dotenv.config();
const perDiemDocumentBuilder = new PerDiemDocumentBuilder();

export const main = async (req: Request, res: Response) => {
    let result: string = '';

    try {
        console.log('Request accepted. URL: ' + req.originalUrl);
        if (req.query?.mode === 'init') {
            console.log('Initializing webhook: ' + req.protocol + "://" + req.hostname + req.path);
            await perDiemDocumentBuilder.initWebhook('');
            result = 'not implemented';
        } else if (req.query?.mode === 'webhook') {
            console.log('Processing webhook call: ' + JSON.stringify(req.body));
            const expenseId = req.body.payload.expenseId;
            result = await perDiemDocumentBuilder.generatePerDiemDocument(expenseId, true);
        } else if (req.query?.mode === 'generate') {
            console.log('Processing generate call: ' + JSON.stringify(req.body));
            const expenseId = req.body.payload.expenseId;
            result = await perDiemDocumentBuilder.generatePerDiemDocument(expenseId, false);
        } else {
            result = 'Unknown request type. Aborting.';
            console.error(result);
        }
    } catch (error:any) {
        result = `An error opccuered: ${error.message}`;
        console.error(result);
    }
    console.log(result);
    res.send(JSON.stringify({value: result}));
};