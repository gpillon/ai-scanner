/** Podman helpers for the tests that run real containers: the smoke tests and the e2e gate. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ModelEntry, PodmanConfig } from '../src/config';
import { EGRESS_NETWORK, SCAN_LABEL } from '../src/podman-runner';

const SCRIPTED_MODEL_CONTAINER = 'ai-scanner-scripted-llm';

function pod(podman: PodmanConfig, ...args: string[]) {
  return spawnSync(podman.executable, args, { encoding: 'utf8' });
}

/** Agent containers of the Scan that still exist; every agent container when `scanId` is omitted. */
export function containersOf(podman: PodmanConfig, scanId?: string): string[] {
  const label = scanId === undefined ? SCAN_LABEL : `${SCAN_LABEL}=${scanId}`;
  return pod(podman, 'ps', '-aq', '--filter', `label=${label}`).stdout.split(/\s+/).filter(Boolean);
}

/** Removes every agent container, as a server does when it starts. */
export function removeAgentContainers(podman: PodmanConfig): void {
  for (const id of containersOf(podman)) pod(podman, 'rm', '--force', '--time', '0', '--ignore', id);
}

/**
 * A Model Pool entry served by test/mock-llm.js, which scripts the agent: see there what it
 * writes, and which caller instructions make it misbehave.
 */
export function scriptedModel(id = 'mock'): ModelEntry {
  return { id, provider: 'mockllm', baseUrl: `http://${SCRIPTED_MODEL_CONTAINER}:8000/v1` };
}

/** Starts test/mock-llm.js in a container on the egress network, where the egress proxy reaches it. */
export function startScriptedModel(podman: PodmanConfig): void {
  if (pod(podman, 'network', 'exists', EGRESS_NETWORK).status !== 0) pod(podman, 'network', 'create', EGRESS_NETWORK);
  pod(podman, 'rm', '--force', '--ignore', SCRIPTED_MODEL_CONTAINER);
  const run = pod(podman, 'run', '--detach', '--name', SCRIPTED_MODEL_CONTAINER, '--network', EGRESS_NETWORK,
    '--volume', `${resolve(__dirname, 'mock-llm.js')}:/mock-llm.js:ro`, podman.proxyImage, 'node', '/mock-llm.js');
  if (run.status !== 0) throw new Error(run.stderr);
}

/** Removes the container startScriptedModel started. */
export function stopScriptedModel(podman: PodmanConfig): void {
  pod(podman, 'rm', '--force', '--ignore', SCRIPTED_MODEL_CONTAINER);
}
