# Per-Diem Custom Document Generator (GCP)

Integrates with Payhawk to automatically generate a custom PDF document ("Заповед за командировка") whenever a per-diem expense is approved. The PDF is attached back to the expense so all users with access can see it in the Payhawk portal.

There is also an [Azure version](https://github.com/NikolayBa/per-diem-custom-document-azure) of this project that uses Azure Functions and Microsoft Office 365 instead of GCP and Google Docs.

## How It Works

1. An expense is approved in Payhawk
2. Payhawk sends a webhook to a Cloud Function deployed in Google Cloud Platform
3. The Cloud Function fetches expense data via the Payhawk API
4. It copies a Google Docs template and replaces placeholders with expense data
5. It exports the filled document as PDF
6. It uploads the PDF back to the expense via the Payhawk API
7. All Payhawk users with access to the expense can now see the PDF

## Project Structure

```
src/
├── index.ts                    # Cloud Function entry point (handles 3 modes: init, webhook, generate)
└── PerdiemDocumentBuilder.ts   # Core logic: Payhawk API calls, Google Docs/Drive operations
dist/                           # Compiled output (deployed to GCP)
```

## Requirements

- A Payhawk account with API key
- A GCP project (free tier is enough)
- Google Cloud CLI (`gcloud`) installed and authenticated
- Node.js 20+
- A Google Docs template with placeholders (see Template Setup below)

## Full Setup Guide

### Step 1: Create the GCP Project

```bash
gcloud projects create {project-id} --name="{Project Name}"
gcloud config set project {project-id}
```

### Step 2: Enable Required APIs

All 6 APIs must be enabled:

```bash
gcloud services enable cloudfunctions.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable artifactregistry.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable docs.googleapis.com
gcloud services enable drive.googleapis.com
```

### Step 3: Create a Service Account

The Cloud Function runs as this service account. It needs access to Google Drive and Docs.

```bash
gcloud iam service-accounts create {sa-name} \
  --display-name="{SA Display Name}" \
  --project={project-id}
```

Example:
```bash
gcloud iam service-accounts create perdiem-doc-sa \
  --display-name="Per Diem Document Generator" \
  --project=payhawk-perdiem-demo
```

This creates a service account with email: `{sa-name}@{project-id}.iam.gserviceaccount.com`

### Step 4: Template Setup

#### Create the Google Docs Template

Create a Google Docs document with placeholders wrapped in angle brackets. The following placeholders are supported:

| Placeholder | Description | Source |
|-------------|-------------|--------|
| `<expense_id>` | Expense ID (7-digit, zero-padded) | `expense.id` |
| `<expense_created_date>` | Expense creation date (e.g. "17 март 2026") | `expense.createdAt` |
| `<employee_name>` | Employee name (Cyrillic from reimbursement details, falls back to first/last name) | `users/{id}/reimbursement-details` |
| `<employee_team>` | Employee's team | Custom field: `teams` |
| `<employee_parent_team>` | Parent team | Custom field: `teams` |
| `<destination>` | Trip destination(s) from per-diem stops | `expense.perDiem.stops` |
| `<trip_reason>` | Reason for business trip | Custom field (see below) |
| `<from_date>` | First day of trip (dd.mm.yyyy) | First per-diem stop date |
| `<to_date>` | Last day of trip (dd.mm.yyyy) | Last per-diem stop date |
| `<transport_type>` | Type of transport | Custom field (see below) |
| `<trip_total_amount>` | Total amount (e.g. "472.50") | `expense.reconciliation.totalAmount` |
| `<approver_name>` | Name of approver | `expenses/{id}/workflow` |
| `<work_title>` | Employee job title | Custom field (see below) |

#### Template Storage

The template **must** be stored on a Google Shared Drive (not personal "My Drive"). This is because service accounts have 0 bytes of personal Drive storage — copying files without an explicit Shared Drive folder causes `storageQuotaExceeded` errors.

1. Create a folder on a Shared Drive for the template and generated copies
2. Place the template document in that folder
3. Share the folder (or Shared Drive) with the service account email, giving it **Editor** access
4. Note down:
   - **Template File ID**: from the Google Docs URL (`docs.google.com/document/d/{THIS_PART}/edit`)
   - **Target Folder ID**: from the Google Drive folder URL (`drive.google.com/drive/folders/{THIS_PART}`)

### Step 5: Custom Field IDs

The code maps Payhawk custom fields by their IDs. These IDs are **account-specific** — they differ between Payhawk accounts.

To find the correct IDs for your account, fetch an expense via the API and inspect `reconciliation.customFields`:

```bash
curl -s "https://api.payhawk.com/api/v3/accounts/{account-id}/expenses/{expense-id}" \
  -H "X-Payhawk-ApiKey: {api-key}" | python3 -m json.tool
```

Look for custom fields with labels matching "Длъжност", "Причина за командировка", "Вид транспортно средство" and note their `id` values.

Update the switch cases in `getExpenseData()` in `src/PerdiemDocumentBuilder.ts`:

```typescript
case 'dlzhnost_zmv7an':              // ← replace with your account's ID for Длъжност
case 'prichina_za_komandir_mrlw9p':  // ← replace with your account's ID for Причина за командировка
case 'vid_transportno_sred_28lbht':  // ← replace with your account's ID for Вид транспортно средство
```

Custom fields can be either **dropdown** (with `selectedValues`) or **text** (with `value`). The code handles both formats automatically.

### Step 6: Get a Payhawk API Key

1. Go to Payhawk Portal → Settings → Developers → API Keys
2. Create a new API key
3. Note down the **Account ID** (visible in the portal URL or settings)

### Step 7: Build and Deploy

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Copy package files to dist (required for Cloud Functions deployment)
cp package.json package-lock.json dist/

# Set GCP project
gcloud config set project {project-id}

# Deploy
gcloud functions deploy {function-name} \
  --region europe-west1 \
  --gen2 \
  --source=dist \
  --set-build-env-vars=GOOGLE_NODE_RUN_SCRIPTS="" \
  --entry-point=main \
  --runtime=nodejs20 \
  --trigger-http \
  --timeout=540 \
  --memory=512MB \
  --cpu=1 \
  --min-instances=1 \
  --service-account={sa-email} \
  --set-env-vars="\
PAYHAWK_API_KEY={api-key},\
GDOCS_TEMPLATE_FILE_ID={template-file-id},\
PAYHAWK_ACCOUNT_ID={account-id},\
WEBHOOK_EVENT_NAME=expense.approved,\
GDOCS_TARGET_FOLDER_ID={target-folder-id}"
```

**Deployment notes:**
- `--min-instances=1` keeps one instance warm to avoid cold start delays on webhook calls
- `--timeout=540` gives enough time for the full flow (Payhawk API + Google Docs copy + PDF export + upload)
- `package.json` and `package-lock.json` must be copied into `dist/` before deploying — Cloud Build needs them to install dependencies
- The function uses Application Default Credentials (ADC) via the service account — no key file needed

### Step 8: Allow Unauthenticated Access

The webhook must be callable by Payhawk without authentication:

```bash
gcloud run services add-iam-policy-binding {function-name} \
  --region=europe-west1 \
  --member="allUsers" \
  --role="roles/run.invoker" \
  --project={project-id}
```

### Step 9: Register the Webhook

Register the webhook with Payhawk so it calls the function when an expense is approved:

```bash
curl -X POST "https://api.payhawk.com/api/v3/accounts/{account-id}/webhooks" \
  -H "X-Payhawk-ApiKey: {api-key}" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "expense.approved",
    "callbackUrl": "{function-url}?mode=webhook"
  }'
```

The function URL is printed after deployment, e.g.:
`https://europe-west1-{project-id}.cloudfunctions.net/{function-name}`

You can verify the webhook was created:
```bash
curl -s "https://api.payhawk.com/api/v3/accounts/{account-id}/webhooks" \
  -H "X-Payhawk-ApiKey: {api-key}" | python3 -m json.tool
```

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `PAYHAWK_API_KEY` | Payhawk API key (base64-encoded) | `NjI1YjJl...` |
| `PAYHAWK_ACCOUNT_ID` | Payhawk account ID | `payhawk_bulgaria_demo_ec0ec516_demo` |
| `GDOCS_TEMPLATE_FILE_ID` | Google Docs template file ID | `1Yg-avRZ-fZmFs...` |
| `GDOCS_TARGET_FOLDER_ID` | Google Drive folder ID for generated copies | `1knPnnS8IUZa...` |
| `WEBHOOK_EVENT_NAME` | Payhawk event to listen for | `expense.approved` |

## Cloud Function Modes

The function accepts 3 modes via the `mode` query parameter:

| Mode | Method | Description |
|------|--------|-------------|
| `webhook` | POST | Called by Payhawk webhook. Generates document and allows regeneration. Body: `{"payload": {"expenseId": "123"}}` |
| `generate` | POST | Manual trigger. Skips if document already exists. Body: `{"payload": {"expenseId": "123"}}` |
| `init` | POST | Placeholder for webhook auto-registration (not fully implemented — register manually via API) |

## Local Development

```bash
# Install dependencies
npm install

# Run locally with hot reload
npm run dev

# Test: generate a document for a specific expense
curl -X POST "http://localhost:8080/?mode=webhook" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"expenseId": "{expense-id}"}}'
```

You need a `.env` file for local development:
```
PAYHAWK_API_KEY={api-key}
PAYHAWK_ACCOUNT_ID={account-id}
GDOCS_TEMPLATE_FILE_ID={template-file-id}
GDOCS_TARGET_FOLDER_ID={target-folder-id}
WEBHOOK_EVENT_NAME=expense.approved
```

For local Google auth, use Application Default Credentials:
```bash
gcloud auth application-default login
```

## Troubleshooting

### `storageQuotaExceeded` when copying template
The template must be on a Shared Drive, and `GDOCS_TARGET_FOLDER_ID` must point to a folder on that Shared Drive. Service accounts have 0 bytes of personal Drive storage.

### Webhook times out (`ESOCKETTIMEDOUT`)
Increase the function timeout and resources. Use `--min-instances=1` to avoid cold starts. The document is still generated even if Payhawk's webhook delivery times out — the function continues running.

### Custom fields not populated in PDF
Custom field IDs are account-specific. Fetch an expense from the API and compare the `customFields[].id` values with the switch cases in `getExpenseData()`.

### Employee name shows as "FirstName LastName" instead of Cyrillic
The employee needs reimbursement details configured in Payhawk with a Cyrillic `accountHolder` name. The code falls back to the English first/last name if reimbursement details are not set.

### `File not found` when renaming copied file
The `drive.files.update` call needs `supportsAllDrives: true` for files on Shared Drives.

### Checking function logs
```bash
gcloud functions logs read {function-name} \
  --region europe-west1 \
  --project={project-id} \
  --limit=50
```
