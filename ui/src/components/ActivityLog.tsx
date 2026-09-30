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
import WrenchIcon from '@patternfly/react-icons/dist/esm/icons/wrench-icon';
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { ApiError, followScan, type Activity, type ScanStatus } from '../api';
import { isActive } from './ScanStateLabel';

/** Rows kept on screen; a long Scan drops its oldest ones. */
const MAX_ROWS = 2000;
const RETRY_MS = 2000;

type Row = { key: number } & ({ type: 'attempt'; attempt: number } | { type: 'activity'; activity: Activity });

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
  }
}

const KIND_CLASS: Record<Activity['kind'], string> = {
  tool: 'app-activity-tool-kind',
  text: 'app-activity-text-kind',
  step: 'app-activity-step',
  error: 'app-activity-error-kind',
  log: 'app-activity-log',
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
                  : { key: key++, type: 'activity', activity: event.data };
              setRows((prev) => (prev.length >= MAX_ROWS ? [...prev.slice(-MAX_ROWS + 1), row] : [...prev, row]));
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

  return (
    <Card>
      <CardHeader
        actions={{
          actions: live ? (
            <Label color="blue" className="app-live">
              Live
            </Label>
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
                  Attempt {row.attempt}
                </div>
              ) : (
                <ActivityRow key={row.key} activity={row.activity} />
              ),
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function ActivityRow({ activity: a }: { activity: Activity }) {
  const Icon = iconOf(a);
  const failed = a.kind === 'error' || a.ok === false;
  return (
    <div className={`app-activity-row ${KIND_CLASS[a.kind]}${failed ? ' app-activity-failed' : ''}`}>
      <span className="app-activity-time">{time(a.at)}</span>
      <span className="app-activity-icon" aria-hidden>
        <Icon />
      </span>
      <span className="app-activity-text">
        {a.kind === 'tool' && <span className="app-activity-toolname">{a.tool}</span>}
        {a.text}
      </span>
    </div>
  );
}
