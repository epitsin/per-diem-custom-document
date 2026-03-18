import axios, { AxiosResponse } from 'axios';
const { google } = require('googleapis');
var toArray = require('stream-to-array');

const ACCOUNT_ID = process.env.PAYHAWK_ACCOUNT_ID;
const PAYHAWK_API_BASE_URL = `https://api.payhawk.com/api/v3/accounts/${ACCOUNT_ID}`;

const PHLDR_EXPENSE_ID = 'expense_id';                      //ID of the expense with 5 trailing zeros
const PHLDR_FROM_DATE = 'from_date';                        //First day of the business trip in format dd.mm.yyyy
const PHLDR_TO_DATE = 'to_date';                            //Last day of the business trip in format dd.mm.yyyy
const PHLDR_DESTINATION = 'destination';                    //The destination of the trip
const PHLDR_EXPENSE_DATE = 'expense_created_date';          //Date of the expense in format 22 Януари 2024
const PHLDR_EMPLOYEE_NAME = 'employee_name';                //Name of the employee that created the expense (in cyrillic as taken from the employee reimbursement details)
const PHLDR_EMPLOYEE_TEAM = 'employee_team';                //The team of the employee
const PHLDR_EMPLOYEE_PARENT_TEAM = 'employee_parent_team';  //The parent team of the team of the employee
const PHLDR_APPROVER_NAME = 'approver_name';                //Name of the employee that approves the expense (in cyrillic as taken from the employee reimbursement details)
const PHLDR_TRIP_REASON = 'trip_reason';                    //Value from custom field - Причина за командировка
const PHLDR_TRANSPORT_TYPE = 'transport_type';              //Value from custom field - Вид транспортно средство
const PHLDR_WORK_TITLE = 'work_title';                      //Value from custom field - Длъжност
const PHLDR_TRIP_TOTAL_AMOUNT = 'trip_total_amount';        //The total amount and currency for the trip

export class PerDiemDocumentBuilder {

  async initWebhook(callbackUrl: string) {

    try {
      const webhookEventType = process.env.WEBHOOK_EVENT_NAME;
      const webhooksResponse = await this.makePayhawkHttpRequest('GET', '/webhooks', null, null);
      const webhooks = webhooksResponse.data.items;
      const existingWebhook = webhooks.find((webhook: any) => webhook.callbackUrl === callbackUrl && webhook.eventType === webhookEventType);
      if (existingWebhook) {
        console.log('Webhook already exists!');
      } else {

      }
      return webhooksResponse.data.items;
    } catch (error) {
      console.log(error);
    }
  }

  async generatePerDiemDocument(expenseId: string, regenerateIfExists: boolean): Promise<string> {
    try {
      //Get expense
      const expense = await this.getExpense(expenseId);

      //If the expense is not of type perDiem - abort
      if (expense.type !== 'perDiem') {
        return 'Expense is not a per-diem.';
      }

      if (!regenerateIfExists && expense.document.files.length > 1) {
        return 'Custom per-diem form already generated for this expense.';
      }

      //Get expense data
      const expenseData = await this.getExpenseData(expense);

      //Create a copy of the template in Google Docs
      const newFileId = await this.copyTamplateFile(expenseData);
      
      //Replace placeholders in the copied template with the correct data
      await this.replaceTextInDoc(newFileId, expenseData);

      //Get the file as PDF
      const pdf:any = await this.exportFileAsPdf(newFileId);
      const arr = await toArray(pdf.data);
      //const buffers = arr.map(part:any => util.isBuffer(part) ? part : Buffer.from(part));
      const b:Buffer = Buffer.concat(arr);
      
      //Attach the document to the expense in Payhawk
      const documentResponse = await this.uploadDocumentToPayhawk(expenseId, b);
      
      return 'Success';
    } catch (error) {
      console.error(error);
      return 'Error'
    }
  }

  private async copyTamplateFile(expenseData:any): Promise<string> {
      const auth = await this.getGoogleAuth(['https://www.googleapis.com/auth/drive']);
      const drive = google.drive({ version: 'v3', auth });

      const templateFileId = process.env.GDOCS_TEMPLATE_FILE_ID;
      const targetFolderId = process.env.GDOCS_TARGET_FOLDER_ID;

      const templateMeta = await drive.files.get({
        fileId: templateFileId,
        supportsAllDrives: true,
        fields: 'id,name,parents,driveId',
        auth
      });
      const folderId = templateMeta.data.parents?.[0] || targetFolderId;

      const copyOptions: any = {
        fileId: templateFileId,
        supportsAllDrives: true,
        auth
      };
      if (folderId) {
        copyOptions.requestBody = { parents: [folderId] };
      }

      const response = await drive.files.copy(copyOptions);
 
      if (response.status === 200) {

        const nameForNewFile = `${expenseData[PHLDR_EXPENSE_ID]}-${expenseData[PHLDR_EMPLOYEE_NAME]}`;
        const newFileId: string = response.data.id;
        if (nameForNewFile) {
          try {
            await drive.files.update({
              fileId: newFileId,
              supportsAllDrives: true,
              resource: {
                name: nameForNewFile
              }
            });
          } catch (err) {
            console.log('Failed to rename the file', err);
          }
        }
        return newFileId;
      } else {
        throw new Error('Unable to duplicate template file: ' + response.status);
      }
  }

  private async replaceTextInDoc(copiedTemplateFileId: string, replaceObject: any): Promise<void> {
      const auth = await this.getGoogleAuth([
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive.file'
      ]);
      const docs = google.docs({ version: 'v1', auth });

      let requests = [];

      for (const key in replaceObject) {
        requests.push(
          {
            replaceAllText: {
              containsText: {
                text: `<${key}>`,
                matchCase: true,
              },
              replaceText: replaceObject[key],
            },
          }
        );
      }

      const res = await docs.documents.batchUpdate({
        documentId: copiedTemplateFileId,
        resource: {
          requests
        }
      });

      return res;
  }

  private async exportFileAsPdf(googleDriveFileId:string): Promise<void> {
    const auth = await this.getGoogleAuth(['https://www.googleapis.com/auth/drive']);
    const service = google.drive({ version: 'v3', auth });
  
    try {
      const result = await service.files.export(
        {
          fileId: googleDriveFileId,
          mimeType: 'application/pdf',
        },
        { responseType: 'stream' }
      );
  
      return result;
    } catch (err) {
      console.log('Failed to export PDF', err);
    }
  }

  private async getGoogleAuth(scopes:string[]): Promise<any> {
    const auth = await google.auth.getClient({
      scopes
    });
    return auth;
  }

  private async getExpense(expenseId: string): Promise<any> {
    try {
      const expenseResponse = await this.makePayhawkHttpRequest('GET', `expenses/${expenseId}`, null, null);
      return expenseResponse.data;
    } catch (error) {
      console.log(error);
    }
  }

  private async getExpenseData(expense: any): Promise<any> {
    const expenseId = expense.id;
    const result: any = {};
    try {
      const expenseWorkflowResponse = await this.makePayhawkHttpRequest('GET', `expenses/${expenseId}/workflow`, null, null);
      const expenseWorkflow = expenseWorkflowResponse.data;


      //Expense ID
      var myformat = new Intl.NumberFormat('en-US', {
        minimumIntegerDigits: 7,
        minimumFractionDigits: 0,
        useGrouping: false
      });
      result[PHLDR_EXPENSE_ID] = myformat.format(expense.id);

      //First and last date of the business trip
      const stops = expense.perDiem?.stops;
      const firstStop = stops[0];
      const lastStop = stops[stops.length - 1];
      result[PHLDR_FROM_DATE] = this.formatShortDate(new Date(Date.parse(firstStop.date)));
      result[PHLDR_TO_DATE] = this.formatShortDate(new Date(Date.parse(lastStop.date)));

      //Expense created date
      const createdAt: Date = new Date(Date.parse(expense.createdAt));
      result[PHLDR_EXPENSE_DATE] = this.formatLongDate(createdAt);

      //Employee name
      result[PHLDR_EMPLOYEE_NAME] = await this.getEmployeeName(expense.createdBy);

      //Trip total amount
      var totalAmountFormat = new Intl.NumberFormat('en-US', {
        minimumIntegerDigits: 1,
        minimumFractionDigits: 2,
        useGrouping: false
      });
      result[PHLDR_TRIP_TOTAL_AMOUNT] = totalAmountFormat.format(expense.reconciliation.totalAmount);

      
      //Approver name
      if (expenseWorkflow.approvedBy) {
        result[PHLDR_APPROVER_NAME] = await this.getEmployeeName(expenseWorkflow.approvedBy);
      } else {
        result[PHLDR_APPROVER_NAME] = 'not approved yet';
      }

      //Destination
      let destinationString = '';
      if (stops.length === 2) {
        destinationString = `${stops[1].address}`;
      } else {
        for (let i = 1; i < stops.length; i++) {
          destinationString += `${i}. ${stops[i].address}\n`;
        }
      }
      result[PHLDR_DESTINATION] = destinationString;

      result[PHLDR_EMPLOYEE_TEAM] = '';
      result[PHLDR_EMPLOYEE_PARENT_TEAM] = '';
      result[PHLDR_WORK_TITLE] = '';
      result[PHLDR_TRIP_REASON] = '';
      result[PHLDR_TRANSPORT_TYPE] = '';

      const customFields: [any] = expense.reconciliation.customFields;
      customFields.forEach(customField => {
        const fieldValue = this.getCustomFieldValue(customField);
        switch (customField.id) {
          case 'teams': //Employee team and parent team
            result[PHLDR_EMPLOYEE_TEAM] = customField.selectedValues?.[0]?.label || '';
            result[PHLDR_EMPLOYEE_PARENT_TEAM] = customField.selectedValues?.length === 2 ? customField.selectedValues[1].label : '';
            break;
          case 'dlzhnost_zmv7an': //Employee work title (Длъжност)
            result[PHLDR_WORK_TITLE] = fieldValue;
            break;
          case 'prichina_za_komandir_mrlw9p': //Trip reason (Причина за командировка)
            result[PHLDR_TRIP_REASON] = fieldValue;
            break;
          case 'vid_transportno_sred_28lbht': //Transport type (Вид транспортно средство)
            result[PHLDR_TRANSPORT_TYPE] = fieldValue;
            break;
          default:
            break;
        }
      });
    } catch (error) {
      console.log(error);
    }
    return result;
  }

  private formatShortDate(date: Date): string {
    const options: any = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    };
    const dateString = date.toLocaleDateString('bg-BG', options)
    return dateString.substring(0, dateString.length - 3);
  }

  private formatLongDate(date: Date): string {
    const options: any = {
      year: 'numeric',
      month: 'long',
      day: '2-digit',
    };
    const dateString = date.toLocaleDateString('bg-BG', options)
    return dateString.substring(0, dateString.length - 3);
  }

  private async getEmployeeName(employee: any): Promise<string> {
    try {
      const cyrillicName = await this.getEmployeeCyrillicName(employee.id);
      if (cyrillicName) {
        return cyrillicName;
      }
    } catch (err) {
      // reimbursement-details not available
    }
    return `${employee.firstName} ${employee.lastName}`;
  }

  private async getEmployeeCyrillicName(employeeId: string): Promise<string> {
    const userDetailsResponse = await this.makePayhawkHttpRequest('GET', `users/${employeeId}/reimbursement-details`, null, null);
    if (userDetailsResponse.status === 204 || !userDetailsResponse.data) {
      return '';
    }
    return userDetailsResponse.data.accountHolder || '';
  }

  private getCustomFieldValue(customField: any): string {
    const value = customField?.value;
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }

    const label = customField?.selectedValues?.[0]?.label;
    if (typeof label === 'string' && label.trim() !== '') {
      return label;
    }

    return '';
  }

  private async uploadDocumentToPayhawk(expenseId: string, fileBuffer: Buffer): Promise<string> {
    const blob = new Blob(
      [fileBuffer], 
      {
        type: "application/pdf"
      }
    );
    const userDetailsResponse = await this.makePayhawkMultipartFormDataRequest(`expenses/${expenseId}/files`, blob);
    const userDetails = userDetailsResponse.data;
    return userDetails.accountHolder;
  }

  private async makePayhawkHttpRequest(method: string, path: string, params: any, body: any): Promise<AxiosResponse<any, any>> {
    const url = `${PAYHAWK_API_BASE_URL}/${path}`
    const response = await axios.request({
      method: method,
      url: url,
      headers: this.getPayhawkAuthHeader(),
      data: body,
      params: params
    });

    return response;
  }

  private async makePayhawkMultipartFormDataRequest(path: string, file: Blob): Promise<AxiosResponse<any, any>> {
    const form = new FormData();
    form.append('my_buffer.pdf', file);

    const headers = this.getPayhawkAuthHeader();
    headers['Content-Type'] = 'multipart/form-data';

    const url = `${PAYHAWK_API_BASE_URL}/${path}`;
    const response = axios.post(
      url, 
      form,
      {headers}
    )

    return response;
  }

  private getPayhawkAuthHeader(): any {
    return {
      'X-Payhawk-ApiKey': process.env.PAYHAWK_API_KEY
    };
  };
}