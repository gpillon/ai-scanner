import {
  Button,
  Content,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Form,
  Label,
  PageSection,
  SearchInput,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import CubesIcon from '@patternfly/react-icons/dist/esm/icons/cubes-icon';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, SCAN_ID_PATTERN, type ScanStatus } from '../api';
import { formatTime, isActive, ScanStateLabel } from '../components/ScanStateLabel';
import { history, useHistory } from '../history';
import { href, navigate } from '../router';

type Row = ScanStatus | { missing: true } | { error: string };

const POLL_MS = 3000;

export function ScansPage() {
  const known = useHistory();
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [lookup, setLookup] = useState('');

  const ids = known.map((s) => s.id).join(',');
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const entries = await Promise.all(
        known.map(async ({ id }): Promise<[string, Row]> => {
          try {
            return [id, await api.scan(id)];
          } catch (e) {
            return [id, e instanceof ApiError && e.status === 404 ? { missing: true } : { error: (e as Error).message }];
          }
        }),
      );
      if (cancelled) return;
      setRows(Object.fromEntries(entries));
      if (entries.some(([, r]) => 'state' in r && isActive(r.state))) timer = setTimeout(refresh, POLL_MS);
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `ids` stands for `known`: refresh when the set of Scans changes, not on every render.
  }, [ids]);

  function open(event: FormEvent) {
    event.preventDefault();
    const id = lookup.trim();
    if (SCAN_ID_PATTERN.test(id)) navigate({ page: 'scan', id });
  }

  return (
    <>
      <PageSection>
        <Content>
          <Title headingLevel="h1">Scans</Title>
          <p>The Scans started or opened from this browser. The server does not list Scans: open others by id.</p>
        </Content>
      </PageSection>
      <PageSection isFilled>
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <Form onSubmit={open}>
                <SearchInput
                  placeholder="Open a Scan by id"
                  value={lookup}
                  onChange={(_e, v) => setLookup(v)}
                  onClear={() => setLookup('')}
                  onSearch={() => SCAN_ID_PATTERN.test(lookup.trim()) && navigate({ page: 'scan', id: lookup.trim() })}
                  aria-label="Open a Scan by id"
                />
              </Form>
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="primary" component="a" href={href({ page: 'new' })}>
                New Scan
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        {known.length === 0 ? (
          <EmptyState titleText="No Scans yet" headingLevel="h2" icon={CubesIcon}>
            <EmptyStateBody>Start a Scan by uploading a zip of source code.</EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" component="a" href={href({ page: 'new' })}>
                  New Scan
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : (
          <Table aria-label="Scans" variant="compact">
            <Thead>
              <Tr>
                <Th>Id</Th>
                <Th>State</Th>
                <Th>Profile</Th>
                <Th>Model</Th>
                <Th>Attempts</Th>
                <Th>Created</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {known.map(({ id }) => {
                const row = rows[id];
                const scan = row && 'state' in row ? row : undefined;
                return (
                  <Tr key={id}>
                    <Td dataLabel="Id">
                      <a href={href({ page: 'scan', id })}>
                        <code>{id}</code>
                      </a>
                    </Td>
                    <Td dataLabel="State">
                      {scan ? (
                        <ScanStateLabel state={scan.state} />
                      ) : row && 'missing' in row ? (
                        <Label variant="outline">Deleted or expired</Label>
                      ) : row && 'error' in row ? (
                        <Label color="orange">{row.error}</Label>
                      ) : (
                        '…'
                      )}
                    </Td>
                    <Td dataLabel="Profile">{scan?.profile ?? '—'}</Td>
                    <Td dataLabel="Model">{scan?.model ?? '—'}</Td>
                    <Td dataLabel="Attempts">{scan?.attempts ?? '—'}</Td>
                    <Td dataLabel="Created">{formatTime(scan?.createdAt)}</Td>
                    <Td isActionCell>
                      <ActionsColumn
                        items={[
                          { title: 'Open', onClick: () => navigate({ page: 'scan', id }) },
                          { title: 'Forget in this browser', onClick: () => history.forget(id) },
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
    </>
  );
}
