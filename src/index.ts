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

            // Respond immediately to prevent Payhawk from retrying the webhook.
            // Cloud Run keeps the function alive after the response is sent,
            // so the document generation continues in the background.
            res.status(200).send(JSON.stringify({value: 'accepted'}));

            try {
                result = await perDiemDocumentBuilder.generatePerDiemDocument(expenseId, true);
                console.log(result);
            } catch (error: any) {
                console.error(`Background processing failed: ${error.message}`);
            }
            return;
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