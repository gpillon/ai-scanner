import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Clock, Timer } from '../common/clock';
import type { Role } from '../auth/bearer.guard';
import { SavedRepositories } from '../repositories/saved-repositories.service';
import { Scan } from '../scans/entities/scan.entity';
import { GitSources } from '../scans/git-sources.service';
import { ScansService } from '../scans/scans.service';
import { ScanSchedule } from './entities/scan-schedule.entity';
import { Cadence, nextRun, ScheduleTiming, timingProblem } from './schedule-timing';

/** At most 48 characters: its Scan ids add `-yyyymmdd-hhmmss` and must fit in 64. */
export const SCHEDULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** How often the server looks for Scan Schedules that are due. */
export const SCHEDULE_TICK_MS = 30_000;

export interface ScheduleInput {
  id: string;
  description?: string;
  repository: string;
  ref?: string | null;
  profile: string;
  model?: string | null;
  language?: string | null;
  instructions?: string | null;
  skillPacks?: string[] | null;
  attemptTimeoutMinutes?: number | null;
  cadence: Cadence;
  intervalHours?: number | null;
  time?: string | null;
  weekdays?: number[] | null;
  timeZone?: string;
  enabled?: boolean;
}

export type ScheduleChange = Partial<Omit<ScheduleInput, 'id'>>;

const TIMING_FIELDS = ['cadence', 'intervalHours', 'time', 'weekdays', 'timeZone'] as const;
/** What a PATCH may change; the rest is the scheduler's to write. */
const EDITABLE_FIELDS = [
  'description',
  'repository',
  'ref',
  'profile',
  'model',
  'language',
  'instructions',
  'skillPacks',
  'attemptTimeoutMinutes',
  ...TIMING_FIELDS,
  'enabled',
  'nextRunAt',
] as const;
const UNFINISHED = new Set(['queued', 'warming', 'running']);

/** `yyyymmdd-hhmmss`, UTC. */
const stamp = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * Scan Schedules (ADR-0014): Scans of a Saved Repository the server starts by itself. Every
 * SCHEDULE_TICK_MS it starts the Scans that are due, through the same path as a caller's POST.
 */
@Injectable()
export class ScanSchedules implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ScanSchedules.name);
  private ticking: Promise<void> = Promise.resolve();
  private timer?: Timer;
  private stopped = false;

  constructor(
    @InjectRepository(ScanSchedule) private readonly schedules: Repository<ScanSchedule>,
    private readonly scans: ScansService,
    private readonly repositories: SavedRepositories,
    private readonly git: GitSources,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    void this.loop();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.timer?.cancel();
  }

  list(): Promise<ScanSchedule[]> {
    return this.schedules.find({ order: { id: 'ASC' } });
  }

  async get(id: string): Promise<ScanSchedule> {
    const schedule = await this.schedules.findOneBy({ id });
    if (!schedule) throw new NotFoundException(`Scan Schedule ${id} not found`);
    return schedule;
  }

  /** The schedule of a private Saved Repository is the admin's, like the repository (ADR-0014). */
  private async assertMayUse(repository: string, by: Role): Promise<void> {
    const repo = await this.repositories.get(repository).catch(() => undefined);
    if (repo) this.repositories.assertMayUse(repo, by);
  }

  async create(input: ScheduleInput, by: Role): Promise<ScanSchedule> {
    if (!SCHEDULE_ID_PATTERN.test(input.id ?? '')) {
      throw new BadRequestException('Scan Schedule id must be 1-48 characters: lowercase letters, digits and dashes');
    }
    if (await this.schedules.existsBy({ id: input.id })) throw new ConflictException(`Scan Schedule ${input.id} already exists`);
    await this.assertMayUse(input.repository, by);
    const schedule = this.schedules.create({
      id: input.id,
      description: input.description?.trim() ?? '',
      repository: input.repository,
      ref: input.ref?.trim() || null,
      profile: input.profile,
      model: input.model?.trim() || null,
      language: input.language?.trim() || null,
      instructions: input.instructions?.trim() || null,
      skillPacks: input.skillPacks?.length ? input.skillPacks : null,
      attemptTimeoutMinutes: input.attemptTimeoutMinutes ?? null,
      cadence: input.cadence,
      intervalHours: input.intervalHours ?? null,
      time: input.time ?? null,
      weekdays: input.weekdays ?? null,
      timeZone: input.timeZone?.trim() || 'UTC',
      enabled: input.enabled ?? true,
      nextRunAt: null,
      lastRunAt: null,
      lastScanId: null,
      lastError: null,
      createdAt: this.clock.now().toISOString(),
    });
    await this.check(schedule);
    schedule.nextRunAt = this.next(schedule);
    await this.schedules.insert(schedule);
    return schedule;
  }

  async update(id: string, change: ScheduleChange, by: Role): Promise<ScanSchedule> {
    const schedule = await this.get(id);
    await this.assertMayUse(schedule.repository, by);
    if (change.repository !== undefined) await this.assertMayUse(change.repository, by);
    const before = JSON.stringify([...TIMING_FIELDS.map((f) => schedule[f]), schedule.enabled]);
    if (change.description !== undefined) schedule.description = change.description.trim();
    if (change.repository !== undefined) schedule.repository = change.repository;
    if (change.ref !== undefined) schedule.ref = change.ref?.trim() || null;
    if (change.profile !== undefined) schedule.profile = change.profile;
    if (change.model !== undefined) schedule.model = change.model?.trim() || null;
    if (change.language !== undefined) schedule.language = change.language?.trim() || null;
    if (change.instructions !== undefined) schedule.instructions = change.instructions?.trim() || null;
    if (change.skillPacks !== undefined) schedule.skillPacks = change.skillPacks?.length ? change.skillPacks : null;
    if (change.attemptTimeoutMinutes !== undefined) schedule.attemptTimeoutMinutes = change.attemptTimeoutMinutes;
    for (const field of TIMING_FIELDS) {
      if (change[field] !== undefined) (schedule as unknown as Record<string, unknown>)[field] = change[field];
    }
    if (change.timeZone !== undefined) schedule.timeZone = change.timeZone.trim() || 'UTC';
    if (change.enabled !== undefined) schedule.enabled = change.enabled;
    // A disabled schedule needs only a valid timing: one whose model left the pool can still be switched off.
    await this.check(schedule, !schedule.enabled);
    // A new timing, or enabling it again, counts from now; anything else keeps the next run.
    if (JSON.stringify([...TIMING_FIELDS.map((f) => schedule[f]), schedule.enabled]) !== before) schedule.nextRunAt = this.next(schedule);
    // Only what a PATCH changes: a run in progress writes lastRunAt, lastScanId and lastError meanwhile.
    await this.schedules.update(id, Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, schedule[f]])));
    return this.get(id);
  }

  /** Its past Scans stay. */
  async remove(id: string, by: Role): Promise<void> {
    await this.assertMayUse((await this.get(id)).repository, by);
    await this.schedules.delete(id);
  }

  /** Starts a Scan of the schedule now, outside its timing; its next run does not move. */
  async runNow(id: string, by: Role): Promise<Scan> {
    const schedule = await this.get(id);
    await this.assertMayUse(schedule.repository, by);
    return this.start(schedule);
  }

  /** Starts the Scans that are due. Runs one at a time: a call waits for the one in progress. */
  tick(): Promise<void> {
    const run = this.ticking.then(() => this.startDue());
    this.ticking = run.catch(() => undefined);
    return run;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.tick().catch((e) => this.log.error(`Scan Schedules: ${e}`));
      if (this.stopped) return;
      this.timer = this.clock.timer(SCHEDULE_TICK_MS);
      await this.timer.elapsed;
    }
  }

  private async startDue(): Promise<void> {
    const now = this.clock.now();
    const due = await this.schedules.find({ where: { enabled: true, nextRunAt: LessThanOrEqual(now.toISOString()) }, order: { nextRunAt: 'ASC' } });
    for (const { id } of due) {
      // Read again: an earlier run of this pass took seconds, and a PATCH may have changed it meanwhile.
      const schedule = await this.schedules.findOneBy({ id });
      if (!schedule?.enabled || !schedule.nextRunAt || schedule.nextRunAt > now.toISOString()) continue;
      try {
        // Moved on first: a run that fails waits for the next time, however long the server was down.
        await this.schedules.update(id, { nextRunAt: nextRun(schedule as ScheduleTiming, now).toISOString() });
        const previous = await this.unfinished(schedule.lastScanId);
        if (previous) {
          await this.schedules.update(id, { lastRunAt: now.toISOString(), lastError: `Skipped: its previous Scan ${previous} has not finished` });
          continue;
        }
        await this.start(schedule);
      } catch (e) {
        this.log.warn(`Scan Schedule ${id} started no Scan: ${(e as Error).message}`);
      }
    }
  }

  private async start(schedule: ScanSchedule): Promise<Scan> {
    const now = this.clock.now();
    try {
      const scan = await this.scans.create({
        id: `${schedule.id}-${stamp(now)}`,
        repository: schedule.repository,
        schedule: schedule.id,
        // Whoever may change the schedule may already use its repository.
        by: 'scheduler',
        ref: schedule.ref ?? undefined,
        profile: schedule.profile,
        model: schedule.model ?? undefined,
        language: schedule.language ?? undefined,
        instructions: schedule.instructions ?? undefined,
        skillPacks: schedule.skillPacks ?? undefined,
        attemptTimeoutMinutes: schedule.attemptTimeoutMinutes ?? undefined,
      });
      await this.schedules.update(schedule.id, { lastRunAt: now.toISOString(), lastScanId: scan.id, lastError: null });
      return scan;
    } catch (e) {
      await this.schedules.update(schedule.id, { lastRunAt: now.toISOString(), lastError: (e as Error).message });
      throw e;
    }
  }

  /** The id of the Scan, if it exists and has not finished. */
  private async unfinished(scanId: string | null): Promise<string | undefined> {
    if (!scanId) return undefined;
    try {
      return UNFINISHED.has((await this.scans.get(scanId)).state) ? scanId : undefined;
    } catch (e) {
      if (e instanceof NotFoundException) return undefined;
      throw e;
    }
  }

  private next(schedule: ScanSchedule): string | null {
    return schedule.enabled ? nextRun(schedule as ScheduleTiming, this.clock.now()).toISOString() : null;
  }

  /** What a Scan would check when it starts, checked now so that a mistake shows at once. */
  private async check(s: ScanSchedule, timingOnly = false): Promise<void> {
    const problem = timingProblem(s as ScheduleTiming);
    if (problem) throw new BadRequestException(problem);
    if (timingOnly) return;
    await this.repositories.get(s.repository).catch(() => {
      throw new BadRequestException(`Unknown repository: ${s.repository}. See GET /api/repositories`);
    });
    this.git.checkRefName(s.ref);
    await this.scans.checkChoices({
      profile: s.profile,
      model: s.model ?? undefined,
      instructions: s.instructions ?? undefined,
      skillPacks: s.skillPacks ?? undefined,
    });
  }
}
