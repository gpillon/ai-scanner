import {
  Alert,
  Button,
  Content,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  PageSection,
  SearchInput,
  Skeleton,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import CubesIcon from '@patternfly/react-icons/dist/esm/icons/cubes-icon';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useEffect, useState } from 'react';
import { api, type ScanStatus } from '../api';
import { formatTime, ScanStateLabel } from '../components/ScanStateLabel';
import { href, navigate } from '../router';

/** Other callers start Scans too, so the list refreshes whether or not one is running here. */
const POLL_MS = 3000;

export function ScansPage() {
  const [scans, setScans] = useState<ScanStatus[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api.scans();
        if (cancelled) return;
        setScans(next);
        setError(undefined);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
      if (!cancelled) timer = setTimeout(refresh, POLL_MS);
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const needle = filter.trim().toLowerCase();
  const shown = scans?.filter((s) => !needle || [s.id, s.profile, s.model, s.state].some((v) => v.toLowerCase().includes(needle)));

  return (
    <>
      <PageSection>
        <Content>
          <Title headingLevel="h1">Scans</Title>
          <p>Every Scan on this server, newest first.</p>
        </Content>
      </PageSection>
      <PageSection isFilled>
        {error && (
          <Alert variant="danger" isInline title="Could not load the Scans" className="pf-v6-u-mb-md">
            {error}
          </Alert>
        )}
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <SearchInput
                placeholder="Filter by id, profile, model or state"
                value={filter}
                onChange={(_e, v) => setFilter(v)}
                onClear={() => setFilter('')}
                aria-label="Filter Scans"
              />
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="primary" component="a" href={href({ page: 'new' })}>
                New Scan
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>

        {!shown ? (
          !error && <Skeleton height="120px" screenreaderText="Loading" />
        ) : scans?.length === 0 ? (
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
                <Th>Finished</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {shown.map((scan) => (
                <Tr key={scan.id}>
                  <Td dataLabel="Id">
                    <a href={href({ page: 'scan', id: scan.id })}>
                      <code>{scan.id}</code>
                    </a>
                  </Td>
                  <Td dataLabel="State">
                    <ScanStateLabel state={scan.state} />
                  </Td>
                  <Td dataLabel="Profile">{scan.profile}</Td>
                  <Td dataLabel="Model">{scan.model}</Td>
                  <Td dataLabel="Attempts">{scan.attempts}</Td>
                  <Td dataLabel="Created">{formatTime(scan.createdAt)}</Td>
                  <Td dataLabel="Finished">{formatTime(scan.finishedAt)}</Td>
                  <Td isActionCell>
                    <ActionsColumn items={[{ title: 'Open', onClick: () => navigate({ page: 'scan', id: scan.id }) }]} />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </PageSection>
    </>
  );
}
