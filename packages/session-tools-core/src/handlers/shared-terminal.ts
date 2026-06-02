import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface SharedTerminalArgs {
  command: 'ensure' | 'write' | 'read' | 'interrupt' | 'kill';
  text?: string;
  fromSeq?: number;
  waitMs?: number;
  cwd?: string;
  cols?: number;
  rows?: number;
}

const MAX_WAIT_MS = 10_000;

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWaitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(value)));
}

function normalizeSeq(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

export async function handleSharedTerminal(
  ctx: SessionToolContext,
  args: SharedTerminalArgs,
): Promise<ToolResult> {
  const terminal = ctx.sharedTerminal;
  if (!terminal) {
    return errorResponse('shared_terminal is not available in this backend.');
  }

  const waitMs = normalizeWaitMs(args.waitMs);
  const fromSeq = normalizeSeq(args.fromSeq);
  const options = {
    cwd: args.cwd ?? ctx.workingDirectory,
    cols: args.cols,
    rows: args.rows,
  };

  if (args.command === 'ensure') {
    const snapshot = await terminal.ensure(options);
    return successResponse(JSON.stringify(snapshot, null, 2));
  }

  if (args.command === 'kill') {
    await terminal.kill();
    return successResponse('Shared terminal killed.');
  }

  if (args.command === 'write') {
    if (typeof args.text !== 'string' || args.text.length === 0) {
      return errorResponse('shared_terminal write requires non-empty text.');
    }

    await terminal.write(args.text, options);
    await wait(waitMs);
    const output = await terminal.read(fromSeq);
    return successResponse(JSON.stringify({
      ...output,
      output: output.chunks.map((chunk) => chunk.data).join(''),
    }, null, 2));
  }

  if (args.command === 'interrupt') {
    await terminal.write('\x03', options);
    await wait(waitMs);
    const output = await terminal.read(fromSeq);
    return successResponse(JSON.stringify({
      ...output,
      output: output.chunks.map((chunk) => chunk.data).join(''),
    }, null, 2));
  }

  if (args.command === 'read') {
    await wait(waitMs);
    const output = await terminal.read(fromSeq);
    return successResponse(JSON.stringify({
      ...output,
      output: output.chunks.map((chunk) => chunk.data).join(''),
    }, null, 2));
  }

  return errorResponse(`Unknown shared_terminal command: ${String(args.command)}`);
}
