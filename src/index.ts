// Ploi deploy action.
//
// Triggers a Ploi deploy webhook, then polls the ping_url it returns and
// streams the Deployer log until the deploy reaches a terminal task.

import * as core from '@actions/core';
import { HttpClient } from '@actions/http-client';

// Guard against a hung connection with a socket idle timeout; the overall
// deploy timeout is enforced separately by the polling loop below.
const http = new HttpClient('ploi-deploy-action', [], { socketTimeout: 30_000 });

// --- helpers ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value: string, inputName: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${inputName} must be a positive integer.`);
  }
  return Number(value);
}

// --- main -------------------------------------------------------------------

async function main() {
  const token = core.getInput('token', { required: true });
  const serverId = core.getInput('server-id', { required: true });
  const siteId = core.getInput('site-id', { required: true });
  const timeoutSeconds = parsePositiveInt(core.getInput('timeout-seconds'), 'timeout-seconds');
  const intervalSeconds = parsePositiveInt(core.getInput('interval-seconds'), 'interval-seconds');

  // Trigger the deploy and grab the ping_url used for status polling.
  const deployUrl =
    `https://ploi.io/webhooks/servers/${serverId}/sites/${siteId}/deploy?token=${token}`;

  let trigger: { ping_url?: string } | null;
  try {
    const { result } = await http.postJson<{ ping_url?: string }>(deployUrl, {});
    trigger = result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not trigger the deploy: ${message}`);
  }

  const pingUrl = trigger?.ping_url;
  if (!pingUrl) {
    core.info(JSON.stringify(trigger));
    throw new Error('No ping_url in deploy response.');
  }

  // The ping_url carries its own token+signature and is not a registered
  // secret, so mask it before it can reach the log.
  core.setSecret(pingUrl);
  core.info('Deploy triggered; streaming log.');

  // The ping_url returns the cumulative Deployer log as {"log": "..."}. Poll
  // it, print only the newly appended text, and stop when the log reaches a
  // terminal Deployer task: deploy:success (ok) or deploy:failed.
  const deadline = Date.now() + timeoutSeconds * 1000;
  let printed = 0;

  while (true) {
    if (Date.now() >= deadline) {
      process.stdout.write('\n');
      throw new Error(`Deploy did not finish within ${timeoutSeconds}s.`);
    }

    let log: string | undefined;
    try {
      const { result } = await http.getJson<{ log?: unknown }>(pingUrl);
      if (typeof result?.log !== 'string') {
        throw new Error('missing string log');
      }
      log = result.log;
    } catch {
      core.warning('Could not read the deploy log; retrying until the timeout.');
    }

    if (log !== undefined) {
      if (log.length < printed) {
        process.stdout.write('\n');
        core.warning('Deploy log was reset; streaming it again from the beginning.');
        printed = 0;
      }
      process.stdout.write(log.slice(printed));
      printed = log.length;

      if (log.includes('deploy:success')) {
        process.stdout.write('\n');
        core.info('Deploy finished successfully.');
        return;
      }
      if (log.includes('deploy:failed')) {
        process.stdout.write('\n');
        throw new Error('Deploy failed.');
      }
    }

    // Sleep before the next poll, but never past the overall deadline.
    const sleepMs = Math.min(intervalSeconds * 1000, deadline - Date.now());
    if (sleepMs <= 0) {
      process.stdout.write('\n');
      throw new Error(`Deploy did not finish within ${timeoutSeconds}s.`);
    }
    await sleep(sleepMs);
  }
}

main().catch((error) => {
  core.setFailed(error.message);
});
