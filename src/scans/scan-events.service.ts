import { Inject, Injectable, MessageEvent, NotFoundException } from '@nestjs/common';
import { open } from 'node:fs/promises';
import { Observable } from 'rxjs';
import { paths } from '../common/paths';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { summarise } from './activity';
import { ScanStatusDto } from './dto/scan-status.dto';
import { ScansService } from './scans.service';

/** How often a stream looks for new transcript lines and state changes. Wall time, not the Clock. */
export const EVENTS_POLL_MS = 250;

const TERMINAL = new Set(['succeeded', 'failed']);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads a growing file from where the last read stopped, one whole line at a time. */
class LineTail {
  private offset = 0;
  private rest = '';

  constructor(readonly path: string) {}

  /** The lines completed since the last call; with `flush`, also a last line without newline. */
  async read(flush = false): Promise<string[]> {
    let chunk = '';
    try {
      const file = await open(this.path, 'r');
      try {
        const { size } = await file.stat();
        if (size > this.offset) {
          const buffer = Buffer.alloc(size - this.offset);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
          this.offset += bytesRead;
          chunk = buffer.subarray(0, bytesRead).toString('utf8');
        }
      } finally {
        await file.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const lines = (this.rest + chunk).split('\n');
    this.rest = lines.pop() ?? '';
    if (flush && this.rest) {
      lines.push(this.rest);
      this.rest = '';
    }
    return lines;
  }
}

/**
 * A Scan's progress as server-sent events: `state` whenever its status changes, `attempt` when
 * an Attempt starts, and `activity` for what the agent does (see `summarise`). The stream
 * replays what already happened, follows the Scan while it runs, and ends once it has finished.
 */
@Injectable()
export class ScanEventsService {
  constructor(
    private readonly scans: ScansService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Throws NotFoundException up front, so an unknown Scan is a 404 rather than an empty stream. */
  async stream(id: string): Promise<Observable<MessageEvent>> {
    await this.scans.get(id);
    return new Observable<MessageEvent>((subscriber) => {
      let stopped = false;
      const emit = (type: string, data: object) => !stopped && subscriber.next({ type, data });
      this.follow(id, emit, () => stopped)
        .then(() => subscriber.complete())
        .catch((e) => subscriber.error(e));
      return () => {
        stopped = true;
      };
    });
  }

  private async follow(id: string, emit: (type: string, data: object) => void, stopped: () => boolean): Promise<void> {
    let attempt = 0;
    let tail: LineTail | undefined;
    let lastState = '';
    while (!stopped()) {
      let scan;
      try {
        scan = await this.scans.get(id);
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw e;
        emit('deleted', { id });
        return;
      }
      // Transcripts are complete before the state turns terminal: read the state first,
      // then every line written so far, and nothing is missed at the end.
      const finished = TERMINAL.has(scan.state);
      for (;;) {
        const next = attempt + 1;
        const nextStarted = next <= scan.attempts;
        if (tail) {
          const lines = await tail.read(nextStarted || finished);
          for (const line of lines) {
            const activity = summarise(line, attempt, () => new Date());
            if (activity) emit('activity', activity);
          }
        }
        if (!nextStarted) break;
        attempt = next;
        tail = new LineTail(paths.transcript(this.config.dataDir, id, attempt));
        emit('attempt', { attempt });
      }
      const status = ScanStatusDto.from(scan, await this.scans.artifactNames(scan));
      const state = JSON.stringify(status);
      if (state !== lastState) {
        emit('state', status);
        lastState = state;
      }
      if (finished) return;
      await sleep(EVENTS_POLL_MS);
    }
  }
}
