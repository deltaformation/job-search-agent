#!/usr/bin/env node
import { openDatabase } from "../src/db/client.ts";
import { requestTailoring } from "../src/tailoring/enqueue.ts";
import { runSetup } from "./setup-data.mjs";

const config = await runSetup(process.env);
const handle = openDatabase({ path: config.databasePath });

try {
  const extractions = handle.sqlite
    .prepare("SELECT id, job_id FROM job_extractions ORDER BY created_at ASC")
    .all();

  console.log(`Found ${extractions.length} extractions to enqueue for tailoring`);
  for (const ext of extractions) {
    const res = requestTailoring(handle, {
      jobId: ext.job_id,
      extractionId: ext.id,
    });
    console.log(`Job ${ext.job_id}: workItem ${res.workItemId} (deduped: ${res.deduped})`);
  }
} finally {
  handle.close();
}
