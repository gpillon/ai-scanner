import {
  Alert,
  AlertActionCloseButton,
  Button,
  Checkbox,
  Content,
  EmptyState,
  EmptyStateBody,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageSection,
  Skeleton,
  Switch,
  TextArea,
  TextInput,
  Title,
  ToggleGroup,
  ToggleGroupItem,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Tooltip,
} from '@patternfly/react-core';
import ClockIcon from '@patternfly/react-icons/dist/esm/icons/clock-icon';
import ExclamationTriangleIcon from '@patternfly/react-icons/dist/esm/icons/exclamation-triangle-icon';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Cadence, type Model, type NewSchedule, type Profile, type SavedRepository, type Schedule, type SkillPack } from '../api';
import { formatTime } from '../components/ScanStateLabel';
import { TagSelect } from '../components/TagSelect';
import { href, navigate, scanRoute } from '../router';

const SCHEDULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The next run moves only on the server's tick, so the list refreshes on its own. */
const POLL_MS = 15_000;

const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** "Every 6 hours", "Daily at 02:00 (Europe/Rome)", "Mon, Fri at 09:00 (UTC)". */
function describeTiming(s: Schedule): string {
  if (s.cadence === 'interval') return s.intervalHours === 1 ? 'Every hour' : `Every ${s.intervalHours} hours`;
  const days = s.cadence === 'daily' ? 'Daily' : (s.weekdays ?? []).map((d) => DAYS[d]).join(', ');
  return `${days} at ${s.time} (${s.timeZone})`;
}

/** Scan Schedules: Scans of a Saved Repository the server starts by itself (ADR-0014). */
export function SchedulesPage({ isAdmin }: { isAdmin: boolean }) {
  const [schedules, setSchedules] = useState<Schedule[]>();
  const [repos, setRepos] = useState<SavedRepository[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Schedule | 'new'>();

  const load = useCallback(() => {
    Promise.all([api.schedules(), api.repositories()])
      .then(([s, r]) => {
        setSchedules(s);
        setRepos(r);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function act(work: () => Promise<unknown>) {
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  async function runNow(id: string) {
    setError(undefined);
    try {
      const scan = await api.runSchedule(id);
      navigate(scanRoute(scan.id, 'logs'));
    } catch (e) {
      setError((e as Error).message);
      load();
    }
  }

  return (
    <>
      <PageSection>
        <Content>
          <Title headingLevel="h1">Schedules</Title>
          <p>
            Scans of a saved repository that the server starts by itself: every few hours, daily or on chosen days of the
            week. A run is skipped while the schedule's previous Scan has not finished. The schedules of a private repository
            are the admin's, like the repository.
          </p>
        </Content>
      </PageSection>
      <PageSection isFilled>
        {error && (
          <Alert variant="danger" isInline title="Something went wrong" className="pf-v6-u-mb-md" actionClose={<AlertActionCloseButton onClose={() => setError(undefined)} />}>
            {error}
          </Alert>
        )}
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setEditing('new')} isDisabled={!repos.some((r) => isAdmin || !r.tokenSet)}>
                Create schedule
              </Button>
            </ToolbarItem>
            {schedules && !repos.length && (
              <ToolbarItem>
                <Button variant="link" component="a" href={href({ page: 'repositories' })}>
                  Save a repository first
                </Button>
              </ToolbarItem>
            )}
          </ToolbarContent>
        </Toolbar>
        {!schedules ? (
          !error && <Skeleton height="120px" screenreaderText="Loading" />
        ) : schedules.length === 0 ? (
          <EmptyState titleText="No schedules" headingLevel="h2" icon={ClockIcon}>
            <EmptyStateBody>Schedule Scans of a saved repository, for instance every night.</EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Schedules" variant="compact">
            <Thead>
              <Tr>
                <Th>Id</Th>
                <Th>Repository</Th>
                <Th>When</Th>
                <Th>Next run</Th>
                <Th>Last run</Th>
                <Th>Enabled</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {schedules.map((s) => {
                // A schedule of a private repository is the admin's (ADR-0014).
                const locked = !isAdmin && Boolean(repos.find((r) => r.id === s.repository)?.tokenSet);
                return (
                <Tr key={s.id}>
                  <Td dataLabel="Id">
                    <strong>{s.id}</strong>
                    <div className="app-subtle">{s.description || s.profile}</div>
                  </Td>
                  <Td dataLabel="Repository">
                    {s.repository}
                    {s.ref && <span className="app-subtle"> @ {s.ref}</span>}
                  </Td>
                  <Td dataLabel="When">{describeTiming(s)}</Td>
                  <Td dataLabel="Next run">{s.nextRunAt ? formatTime(s.nextRunAt) : <span className="app-subtle">—</span>}</Td>
                  <Td dataLabel="Last run">
                    {!s.lastRunAt ? (
                      <span className="app-subtle">Never</span>
                    ) : s.lastError ? (
                      <Tooltip content={s.lastError}>
                        <span className="app-schedule-error" tabIndex={0}>
                          <ExclamationTriangleIcon /> {formatTime(s.lastRunAt)}
                        </span>
                      </Tooltip>
                    ) : s.lastScanId ? (
                      <a href={href(scanRoute(s.lastScanId))}>{formatTime(s.lastRunAt)}</a>
                    ) : (
                      formatTime(s.lastRunAt)
                    )}
                  </Td>
                  <Td dataLabel="Enabled">
                    <Switch
                      id={`schedule-enabled-${s.id}`}
                      aria-label={`Enable ${s.id}`}
                      isChecked={s.enabled}
                      isDisabled={locked}
                      onChange={(_e, enabled) => act(() => api.updateSchedule(s.id, { enabled }))}
                    />
                  </Td>
                  <Td isActionCell>
                    <ActionsColumn
                      isDisabled={locked}
                      items={[
                        { title: 'Run now', onClick: () => runNow(s.id) },
                        { title: 'Edit', onClick: () => setEditing(s) },
                        { isSeparator: true },
                        { title: 'Remove', onClick: () => act(() => api.deleteSchedule(s.id)) },
                      ]}
                    />
                  </Td>
                </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </PageSection>

      {editing && (
        <ScheduleForm
          schedule={editing === 'new' ? undefined : editing}
          repos={repos.filter((r) => isAdmin || !r.tokenSet)}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}
    </>
  );
}

function ScheduleForm({ schedule, repos, onClose, onSaved }: { schedule?: Schedule; repos: SavedRepository[]; onClose: () => void; onSaved: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>();
  const [models, setModels] = useState<Model[]>([]);
  const [packs, setPacks] = useState<SkillPack[]>([]);

  const [id, setId] = useState(schedule?.id ?? '');
  const [description, setDescription] = useState(schedule?.description ?? '');
  const [repository, setRepository] = useState(schedule?.repository ?? repos[0]?.id ?? '');
  const [ref, setRef] = useState(schedule?.ref ?? '');
  const [profile, setProfile] = useState(schedule?.profile ?? '');
  // '': the Default Model when each Scan starts.
  const [model, setModel] = useState(schedule?.model ?? '');
  const [language, setLanguage] = useState(schedule?.language ?? '');
  const [instructions, setInstructions] = useState(schedule?.instructions ?? '');
  const [timeout, setTimeoutMinutes] = useState(schedule?.attemptTimeoutMinutes ? String(schedule.attemptTimeoutMinutes) : '');
  const [chosenPacks, setChosenPacks] = useState<string[]>(schedule?.skillPacks ?? []);
  const [cadence, setCadence] = useState<Cadence>(schedule?.cadence ?? 'daily');
  const [hours, setHours] = useState(String(schedule?.intervalHours ?? 24));
  const [time, setTime] = useState(schedule?.time ?? '02:00');
  const [weekdays, setWeekdays] = useState<number[]>(schedule?.weekdays ?? [1]);
  const [timeZone, setTimeZone] = useState(schedule?.timeZone ?? browserTimeZone());
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([api.profiles(), api.models()])
      .then(([p, m]) => {
        setProfiles(p);
        setModels(m);
        setProfile((current) => current || p[0]?.name || '');
      })
      .catch((e: Error) => setError(e.message));
    api.skillPacks().then(setPacks).catch(() => undefined);
  }, []);

  const idValid = Boolean(schedule) || SCHEDULE_ID_PATTERN.test(id);
  const hoursValid = /^\d+$/.test(hours) && +hours >= 1 && +hours <= 720;
  const timeoutValid = timeout.trim() === '' || (/^\d+$/.test(timeout.trim()) && +timeout >= 1 && +timeout <= 1440);
  const timingValid = cadence === 'interval' ? hoursValid : /^\d\d:\d\d$/.test(time) && (cadence === 'daily' || weekdays.length > 0);
  const canSave = idValid && Boolean(repository) && Boolean(profile) && timingValid && timeoutValid && !saving;

  const toggleDay = (day: number, on: boolean) =>
    setWeekdays((days) => (on ? [...new Set([...days, day])].sort() : days.filter((d) => d !== day)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(undefined);
    const body: Omit<NewSchedule, 'id'> = {
      description,
      repository,
      ref: ref.trim() || null,
      profile,
      model: model || null,
      language: language.trim() || null,
      instructions: instructions.trim() || null,
      skillPacks: chosenPacks,
      attemptTimeoutMinutes: timeout.trim() ? Number(timeout) : null,
      cadence,
      ...(cadence === 'interval' ? { intervalHours: Number(hours) } : { time, timeZone: timeZone.trim() }),
      ...(cadence === 'weekly' && { weekdays }),
      enabled,
    };
    try {
      if (schedule) await api.updateSchedule(schedule.id, body);
      else await api.createSchedule({ id: id.trim(), ...body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <Modal variant="medium" isOpen onClose={onClose} aria-labelledby="schedule-form">
      <ModalHeader title={schedule ? `Edit ${schedule.id}` : 'Create a schedule'} labelId="schedule-form" />
      <ModalBody>
        {!profiles ? (
          !error && <Skeleton height="300px" screenreaderText="Loading" />
        ) : (
          <Form id="schedule-form-body" onSubmit={submit}>
            {!schedule && (
              <FormGroup label="Id" isRequired fieldId="schedule-id">
                <TextInput id="schedule-id" value={id} onChange={(_e, v) => setId(v)} placeholder="payments-nightly" validated={id && !idValid ? 'error' : 'default'} isRequired />
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem variant={id && !idValid ? 'error' : 'default'}>
                      Lowercase letters, digits and dashes, at most 48. Its Scans are named id-yyyymmdd-hhmmss.
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
            )}
            <FormGroup label="Description" fieldId="schedule-description">
              <TextInput id="schedule-description" value={description} onChange={(_e, v) => setDescription(v)} placeholder="Optional" />
            </FormGroup>

            <FormGroup label="Repository" isRequired fieldId="schedule-repository">
              <FormSelect id="schedule-repository" value={repository} onChange={(_e, v) => setRepository(v)}>
                {repos.map((r) => (
                  <FormSelectOption key={r.id} value={r.id} label={`${r.id} — ${r.url}`} />
                ))}
              </FormSelect>
            </FormGroup>
            <FormGroup label="Branch or tag" fieldId="schedule-ref">
              <TextInput
                id="schedule-ref"
                value={ref}
                onChange={(_e, v) => setRef(v)}
                placeholder={`The repository's: ${repos.find((r) => r.id === repository)?.ref ?? 'default branch'}`}
              />
            </FormGroup>

            <FormGroup label="When" isRequired fieldId="schedule-cadence" role="radiogroup">
              <ToggleGroup aria-label="When">
                <ToggleGroupItem text="Every N hours" buttonId="cadence-interval" isSelected={cadence === 'interval'} onChange={() => setCadence('interval')} />
                <ToggleGroupItem text="Daily" buttonId="cadence-daily" isSelected={cadence === 'daily'} onChange={() => setCadence('daily')} />
                <ToggleGroupItem text="Weekly" buttonId="cadence-weekly" isSelected={cadence === 'weekly'} onChange={() => setCadence('weekly')} />
              </ToggleGroup>
            </FormGroup>
            {cadence === 'interval' ? (
              <FormGroup label="Hours between two Scans" isRequired fieldId="schedule-hours">
                <TextInput id="schedule-hours" type="number" min={1} max={720} value={hours} onChange={(_e, v) => setHours(v)} validated={hoursValid ? 'default' : 'error'} />
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem variant={hoursValid ? 'default' : 'error'}>1 to 720. The first Scan starts that long after saving.</HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
            ) : (
              <>
                {cadence === 'weekly' && (
                  <FormGroup label="Days" isRequired fieldId="schedule-days" role="group" isInline>
                    {DAYS.map((label, day) => (
                      <Checkbox key={label} id={`schedule-day-${day}`} label={label} isChecked={weekdays.includes(day)} onChange={(_e, on) => toggleDay(day, on)} />
                    ))}
                  </FormGroup>
                )}
                <FormGroup label="Time" isRequired fieldId="schedule-time">
                  <TextInput id="schedule-time" type="time" value={time} onChange={(_e, v) => setTime(v)} />
                </FormGroup>
                <FormGroup label="Time zone" isRequired fieldId="schedule-timezone">
                  <TextInput id="schedule-timezone" value={timeZone} onChange={(_e, v) => setTimeZone(v)} placeholder="Europe/Rome" />
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem>An IANA name such as Europe/Rome or UTC; daylight saving is followed.</HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                </FormGroup>
              </>
            )}

            <FormGroup label="Scan Profile" isRequired fieldId="schedule-profile">
              <FormSelect id="schedule-profile" value={profile} onChange={(_e, v) => setProfile(v)}>
                {profiles.map((p) => (
                  <FormSelectOption key={p.name} value={p.name} label={p.name} />
                ))}
              </FormSelect>
            </FormGroup>
            {packs.length > 0 && (
              <FormGroup label="Skill Packs" fieldId="schedule-packs" role="group">
                <TagSelect
                  id="schedule-packs"
                  placeholder="Add Skill Packs"
                  options={packs.map((p) => ({ value: p.id, description: p.description }))}
                  selected={chosenPacks}
                  onChange={setChosenPacks}
                />
              </FormGroup>
            )}
            <FormGroup label="Model" fieldId="schedule-model">
              <FormSelect id="schedule-model" value={model} onChange={(_e, v) => setModel(v)}>
                <FormSelectOption value="" label="The Default Model, when each Scan starts" />
                {models.map((m) => (
                  <FormSelectOption key={m.id} value={m.id} label={`${m.id} (${m.provider})`} />
                ))}
              </FormSelect>
            </FormGroup>
            <FormGroup label="Report language" fieldId="schedule-language">
              <TextInput id="schedule-language" value={language} onChange={(_e, v) => setLanguage(v)} placeholder="Server default, e.g. en" />
            </FormGroup>
            <FormGroup label="Attempt timeout (minutes)" fieldId="schedule-timeout">
              <TextInput
                id="schedule-timeout"
                type="number"
                min={1}
                max={1440}
                value={timeout}
                onChange={(_e, v) => setTimeoutMinutes(v)}
                placeholder="Server default"
                validated={timeoutValid ? 'default' : 'error'}
              />
            </FormGroup>
            <FormGroup label="Instructions" fieldId="schedule-instructions">
              <TextArea id="schedule-instructions" value={instructions} onChange={(_e, v) => setInstructions(v)} placeholder="Optional: steer the analysis" resizeOrientation="vertical" />
            </FormGroup>
            <FormGroup fieldId="schedule-enabled">
              <Switch id="schedule-enabled" label="Enabled" isChecked={enabled} onChange={(_e, v) => setEnabled(v)} />
            </FormGroup>
            {error && (
              <Alert variant="danger" isInline title="Not saved">
                {error}
              </Alert>
            )}
          </Form>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" type="submit" form="schedule-form-body" isLoading={saving} isDisabled={!canSave}>
          {schedule ? 'Save' : 'Create'}
        </Button>
        <Button variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}
