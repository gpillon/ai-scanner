import { Card, CardBody, CardHeader, CardTitle, Content, Label } from '@patternfly/react-core';
import BookOpenIcon from '@patternfly/react-icons/dist/esm/icons/book-open-icon';
import CommentDotsIcon from '@patternfly/react-icons/dist/esm/icons/comment-dots-icon';
import ExclamationTriangleIcon from '@patternfly/react-icons/dist/esm/icons/exclamation-triangle-icon';
import FileAltIcon from '@patternfly/react-icons/dist/esm/icons/file-alt-icon';
import FolderOpenIcon from '@patternfly/react-icons/dist/esm/icons/folder-open-icon';
import ListIcon from '@patternfly/react-icons/dist/esm/icons/list-icon';
import PencilAltIcon from '@patternfly/react-icons/dist/esm/icons/pencil-alt-icon';
import SearchIcon from '@patternfly/react-icons/dist/esm/icons/search-icon';
import TachometerAltIcon from '@patternfly/react-icons/dist/esm/icons/tachometer-alt-icon';
import TerminalIcon from '@patternfly/react-icons/dist/esm/icons/terminal-icon';
import UsersIcon from '@patternfly/react-icons/dist/esm/icons/users-icon';
import WrenchIcon from '@patternfly/react-icons/dist/esm/icons/wrench-icon';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { ApiError, followScan, type Activity, type ScanStatus } from '../api';
import { isActive } from './ScanStateLabel';

/** Rows kept on screen; a long Scan drops its oldest ones. */
const MAX_ROWS = 2000;
const RETRY_MS = 2000;

/** A heading row: Attempt `n`, or the model warm-up before Attempt 1 (attempt 0, ADR-0009). */
type Row = { key: number } & ({ type: 'attempt'; attempt: number } | { type: 'activity'; activity: Activity; color?: SubagentColor });

type SubagentColor = 'purple' | 'teal' | 'orange' | 'green' | 'yellow' | 'orangered' | 'blue' | 'grey';
/** One per subagent, in the order they first act; red is left to failures. */
const SUBAGENT_COLORS: SubagentColor[] = ['purple', 'teal', 'orange', 'blue', 'green', 'yellow', 'orangered', 'grey'];

const TOOL_ICONS: Record<string, ComponentType> = {
  read: FileAltIcon,
  grep: SearchIcon,
  glob: FolderOpenIcon,
  list: FolderOpenIcon,
  skill: BookOpenIcon,
  write: PencilAltIcon,
  edit: PencilAltIcon,
  todowrite: ListIcon,
};

function iconOf(a: Activity): ComponentType {
  switch (a.kind) {
    case 'tool':
      return (a.tool && TOOL_ICONS[a.tool]) || WrenchIcon;
    case 'text':
      return CommentDotsIcon;
    case 'step':
      return TachometerAltIcon;
    case 'error':
      return ExclamationTriangleIcon;
    case 'log':
      return TerminalIcon;
    case 'subagent':
      return UsersIcon;
  }
}

const KIND_CLASS: Record<Activity['kind'], string> = {
  tool: 'app-activity-tool-kind',
  text: 'app-activity-text-kind',
  step: 'app-activity-step',
  error: 'app-activity-error-kind',
  log: 'app-activity-log',
  subagent: 'app-activity-subagent-kind',
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * What the agent does, as it does it: follows `GET /api/scan/<id>/events`, which first replays
 * what already happened. `onState` receives every status the stream reports.
 */
export function ActivityLog({ scanId, onState }: { scanId: string; onState?: (scan: ScanStatus) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    const abort = new AbortController();
    let key = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function connect() {
      // Every connection replays the Scan from the start: begin from an empty log.
      setRows([]);
      setError(undefined);
      let finished = false;
      const colors = new Map<string, SubagentColor>();
      const colorOf = (subagent: string) => {
        if (!colors.has(subagent)) colors.set(subagent, SUBAGENT_COLORS[colors.size % SUBAGENT_COLORS.length]);
        return colors.get(subagent);
      };
      try {
        await followScan(
          scanId,
          (event) => {
            if (event.type === 'state') {
              finished = !isActive(event.data.state);
              setLive(!finished);
              onStateRef.current?.(event.data);
            } else if (event.type === 'attempt' || event.type === 'activity') {
              const row: Row =
                event.type === 'attempt'
                  ? { key: key++, type: 'attempt', attempt: event.data.attempt }
                  : { key: key++, type: 'activity', activity: event.data, color: event.data.subagent ? colorOf(event.data.subagent) : undefined };
              setRows((prev) => {
                // The warm-up has no `attempt` event of its own: head its lines before the first one.
                const warmupStarts = row.type === 'activity' && row.activity.attempt === 0 && !prev.some((r) => r.type === 'attempt' && r.attempt === 0);
                const added: Row[] = warmupStarts ? [{ key: key++, type: 'attempt', attempt: 0 }, row] : [row];
                const next = [...prev, ...added];
                return next.length > MAX_ROWS ? next.slice(-MAX_ROWS) : next;
              });
            } else if (event.type === 'deleted') {
              finished = true;
              setLive(false);
            }
          },
          abort.signal,
        );
      } catch (e) {
        if (abort.signal.aborted) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 401)) {
          setLive(false);
          return;
        }
        setError((e as Error).message);
      }
      // The server ends the stream once the Scan has finished; any other end is a dropped connection.
      if (!finished && !abort.signal.aborted) timer = setTimeout(connect, RETRY_MS);
    }
    void connect();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [scanId]);

  // Keep the newest row in view, unless the reader scrolled up to look at older ones.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // The subagents that have started but not finished, in the current attempt: the names the
  // "N subagents active" label lists. A start adds a name, a finish removes it.
  const activeNames = useMemo(() => {
    const lastAttempt = rows.map((r) => r.type).lastIndexOf('attempt');
    const names = new Set<string>();
    for (const row of rows.slice(lastAttempt + 1)) {
      if (row.type !== 'activity' || row.activity.kind !== 'subagent') continue;
      const name = row.activity.subagent ?? '';
      if (row.activity.ok === undefined) names.add(name);
      else names.delete(name);
    }
    return [...names];
  }, [rows]);

  return (
    <Card>
      <CardHeader
        actions={{
          actions: live ? (
            <>
              <Label color="blue" className="app-live">
                Live
              </Label>
              {activeNames.length > 0 && (
                <Label isCompact color="blue" className="app-active-subagents" title={activeNames.join(', ')}>
                  {activeNames.length} subagent{activeNames.length > 1 ? 's' : ''} active
                </Label>
              )}
            </>
          ) : undefined,
          hasNoOffset: true,
        }}
      >
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardBody>
        {error && <Content component="p" className="app-activity-error">Connection lost ({error}). Reconnecting…</Content>}
        {rows.length === 0 ? (
          <Content component="p">{live ? 'Waiting for the agent…' : 'No activity recorded.'}</Content>
        ) : (
          <div className="app-activity" ref={box} onScroll={onScroll} role="log" aria-live="polite">
            {rows.map((row) =>
              row.type === 'attempt' ? (
                <div key={row.key} className="app-activity-attempt">
                  {row.attempt === 0 ? 'Model warm-up' : `Attempt ${row.attempt}`}
                </div>
              ) : (
                <ActivityRow key={row.key} activity={row.activity} color={row.color} />
              ),
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function ActivityRow({ activity: a, color }: { activity: Activity; color?: SubagentColor }) {
  const Icon = iconOf(a);
  const failed = a.kind === 'error' || a.ok === false;
  return (
    <div className={`app-activity-row ${KIND_CLASS[a.kind]}${failed ? ' app-activity-failed' : ''}`}>
      <span className="app-activity-time">{time(a.at)}</span>
      <span className="app-activity-icon" aria-hidden>
        <Icon />
      </span>
      <span className="app-activity-text">
        {a.subagent && (
          <Label isCompact color={color ?? 'purple'} className="app-activity-subagent" title={`Subagent: ${a.subagent}`}>
            {a.subagent}
          </Label>
        )}
        {a.kind === 'tool' && <span className="app-activity-toolname">{a.tool}</span>}
        {a.text}
      </span>
    </div>
  );
}
