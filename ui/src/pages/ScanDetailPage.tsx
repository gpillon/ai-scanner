import {
  Alert,
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  Button,
  Card,
  CardBody,
  CardTitle,
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  EmptyState,
  EmptyStateBody,
  ExpandableSection,
  Flex,
  FlexItem,
  Gallery,
  Label,
  LabelGroup,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageBreadcrumb,
  PageSection,
  Skeleton,
  Split,
  SplitItem,
  Stack,
  StackItem,
  Tab,
  Tabs,
  TabTitleText,
  Title,
  Tooltip,
} from '@patternfly/react-core';
import CopyIcon from '@patternfly/react-icons/dist/esm/icons/copy-icon';
import DownloadIcon from '@patternfly/react-icons/dist/esm/icons/download-icon';
import SearchIcon from '@patternfly/react-icons/dist/esm/icons/search-icon';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useEffect, useState } from 'react';
import { api, ApiError, saveBlob, type ScanStatus } from '../api';
import { ActivityLog } from '../components/ActivityLog';
import { formatTime, isActive, ScanStateLabel } from '../components/ScanStateLabel';
import { href, navigate, scanRoute, type ScanTab } from '../router';

const POLL_MS = 3000;

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** The part of findings.json this page shows; the full shape is the profile's schema.json. */
interface Findings {
  report?: { summary?: string };
  findings?: {
    severity: Severity;
    title: string;
    description: string;
    location?: { file?: string; line?: number };
  }[];
}

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_COLOR = { critical: 'red', high: 'orangered', medium: 'orange', low: 'yellow', info: 'grey' } as const;

const ARTIFACT_LABELS: Record<string, string> = {
  'report.pdf': 'Report (PDF)',
  'report.md': 'Report (Markdown)',
  'findings.json': 'Findings (JSON)',
};

/** Known Artifacts in the order above, then any other. */
const sortArtifacts = (names: string[]) => {
  const rank = (n: string) => (n in ARTIFACT_LABELS ? Object.keys(ARTIFACT_LABELS).indexOf(n) : Infinity);
  return [...names].sort((a, b) => rank(a) - rank(b));
};

export function ScanDetailPage({ id, tab }: { id: string; tab: ScanTab }) {
  const [scan, setScan] = useState<ScanStatus>();
  const [error, setError] = useState<{ status?: number; message: string }>();
  const [findings, setFindings] = useState<Findings>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setScan(undefined);
    setError(undefined);
    setFindings(undefined);
    async function refresh() {
      try {
        const next = await api.scan(id);
        if (cancelled) return;
        setScan(next);
        if (isActive(next.state)) timer = setTimeout(refresh, POLL_MS);
        else if (next.artifacts?.includes('findings.json')) {
          const blob = await api.artifact(id, 'findings.json');
          if (!cancelled) setFindings(JSON.parse(await blob.text()));
        }
      } catch (e) {
        if (!cancelled) setError({ status: e instanceof ApiError ? e.status : undefined, message: (e as Error).message });
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id]);

  const [copied, setCopied] = useState(false);
  async function copyId() {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function download(name: string) {
    try {
      saveBlob(await api.artifact(id, name), `${id}-${name}`);
    } catch (e) {
      setError({ message: `Could not download ${name}: ${(e as Error).message}` });
    }
  }

  async function remove() {
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await api.deleteScan(id);
      navigate({ page: 'scans' });
    } catch (e) {
      setDeleteError((e as Error).message);
      setDeleting(false);
    }
  }

  const breadcrumb = (
    <PageBreadcrumb>
      <Breadcrumb>
        <BreadcrumbItem to={href({ page: 'scans' })}>Scans</BreadcrumbItem>
        <BreadcrumbItem isActive>{id}</BreadcrumbItem>
      </Breadcrumb>
    </PageBreadcrumb>
  );

  if (error?.status === 404) {
    return (
      <>
        {breadcrumb}
        <PageSection isFilled>
          <EmptyState titleText="Scan not found" headingLevel="h1" icon={SearchIcon}>
            <EmptyStateBody>
              No Scan has id <code>{id}</code>: it never existed, was deleted, or its retention expired.
            </EmptyStateBody>
            <Button variant="link" component="a" href={href({ page: 'scans' })}>
              Back to Scans
            </Button>
          </EmptyState>
        </PageSection>
      </>
    );
  }

  const counts = SEVERITIES.map((s) => [s, findings?.findings?.filter((f) => f.severity === s).length ?? 0] as const);

  return (
    <>
      {breadcrumb}
      <PageSection>
        <Split hasGutter>
          <SplitItem isFilled>
            <div className="app-scan-header">
              <span className="app-scan-title">
                <Title headingLevel="h1">{id}</Title>
                <Tooltip content={copied ? 'Copied' : 'Copy id'}>
                  <Button variant="plain" size="sm" icon={<CopyIcon />} aria-label="Copy id" onClick={copyId} />
                </Tooltip>
              </span>
              {scan && <ScanStateLabel state={scan.state} />}
            </div>
            <p className="app-scan-subtitle">{scan ? `Scan · ${scan.profile} · ${scan.model}` : 'Scan'}</p>
          </SplitItem>
          <SplitItem>
            <Button variant="danger" onClick={() => setConfirmDelete(true)} isDisabled={!scan}>
              {scan && isActive(scan.state) ? 'Stop and delete' : 'Delete'}
            </Button>
          </SplitItem>
        </Split>
      </PageSection>

      <PageSection isFilled>
        <Stack hasGutter>
          {error && (
            <StackItem>
              <Alert variant="danger" isInline title="Something went wrong">
                {error.message}
              </Alert>
            </StackItem>
          )}
          {scan?.state === 'failed' && (
            <StackItem>
              <Alert variant="danger" isInline title="The Scan failed">
                {scan.failureReason ?? 'No reason given.'}
              </Alert>
            </StackItem>
          )}
          <StackItem>
            <Tabs activeKey={tab} onSelect={(_e, key) => navigate(scanRoute(id, key as ScanTab))} aria-label="Scan">
              <Tab eventKey="overview" title={<TabTitleText>Overview</TabTitleText>}>
                <div className="app-tab-body">
                  <Gallery hasGutter minWidths={{ default: '100%', lg: '420px' }}>
                    <Card isFullHeight>
                      <CardTitle>Details</CardTitle>
                      <CardBody>
                        {!scan ? (
                          <Skeleton height="160px" screenreaderText="Loading" />
                        ) : (
                          <DescriptionList isHorizontal isCompact>
                            <DescriptionListGroup>
                              <DescriptionListTerm>Profile</DescriptionListTerm>
                              <DescriptionListDescription>{scan.profile}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                              <DescriptionListTerm>Model</DescriptionListTerm>
                              <DescriptionListDescription>{scan.model}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                              <DescriptionListTerm>Thinking</DescriptionListTerm>
                              <DescriptionListDescription>
                                {scan.modelOptions?.thinking === 'off'
                                  ? 'Off'
                                  : scan.modelOptions?.thinking === 'on'
                                    ? `On, ${scan.modelOptions.thinkingLevel ? `${scan.modelOptions.thinkingLevel} level` : "model's default level"}`
                                    : 'Model default'}
                              </DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                              <DescriptionListTerm>Language</DescriptionListTerm>
                              <DescriptionListDescription>{scan.language}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                              <DescriptionListTerm>Source</DescriptionListTerm>
                              <DescriptionListDescription>
                                {scan.source ? (
                                  <>
                                    <code className="app-break">{scan.source.url}</code>
                                    <div className="app-subtle">
                                      {scan.source.ref ?? 'default branch'} · commit <code>{scan.source.commit.slice(0, 12)}</code>
                                    </div>
                                  </>
                                ) : (
                                  'Zip archive'
                                )}
                              </DescriptionListDescription>
                            </DescriptionListGroup>
                            {scan.skillPacks && (
                              <DescriptionListGroup>
                                <DescriptionListTerm>Skill Packs</DescriptionListTerm>
                                <DescriptionListDescription>
                                  <LabelGroup numLabels={4}>
                                    {scan.skillPacks.map((p) => (
                                      <Label key={p.id} color="purple" isCompact title={p.skills.map((s) => s.name).join(', ')}>
                                        {p.id}
                                      </Label>
                                    ))}
                                  </LabelGroup>
                                </DescriptionListDescription>
                              </DescriptionListGroup>
                            )}
                            <DescriptionListGroup>
                              <DescriptionListTerm>Attempts</DescriptionListTerm>
                              <DescriptionListDescription>{scan.attempts}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                              <DescriptionListTerm>Attempt timeout</DescriptionListTerm>
                              <DescriptionListDescription>
                                {scan.attemptTimeoutMinutes ? `${scan.attemptTimeoutMinutes} min` : 'Server default'}
                              </DescriptionListDescription>
                            </DescriptionListGroup>
                            {scan.usage && (
                              <DescriptionListGroup>
                                <DescriptionListTerm>Tokens</DescriptionListTerm>
                                <DescriptionListDescription>
                                  <div>
                                    <strong>{formatCount(scan.usage.input)}</strong> input · <strong>{formatCount(scan.usage.output)}</strong> output
                                    {scan.usage.cost > 0 && <> · {formatCost(scan.usage.cost)}</>}
                                  </div>
                                  <div className="pf-v6-u-font-size-sm pf-v6-u-text-color-subtle">
                                    {formatCount(scan.usage.total)} in total
                                    {scan.usage.cacheRead > 0 && <>, {formatCount(scan.usage.cacheRead)} read from cache</>}
                                    {scan.usage.reasoning > 0 && <>, {formatCount(scan.usage.reasoning)} reasoning</>}
                                    {scan.usage.sessions > 1 && (
                                      <>
                                        {' '}
                                        · {scan.usage.sessions} sessions ({scan.usage.sessions - 1} subagent{scan.usage.sessions > 2 ? 's' : ''})
                                      </>
                                    )}
                                  </div>
                                </DescriptionListDescription>
                              </DescriptionListGroup>
                            )}
                            <DescriptionListGroup>
                              <DescriptionListTerm>Created</DescriptionListTerm>
                              <DescriptionListDescription>{formatTime(scan.createdAt)}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                              <DescriptionListTerm>Started</DescriptionListTerm>
                              <DescriptionListDescription>{formatTime(scan.startedAt)}</DescriptionListDescription>
                            </DescriptionListGroup>
                            <DescriptionListGroup>
                              <DescriptionListTerm>Finished</DescriptionListTerm>
                              <DescriptionListDescription>{formatTime(scan.finishedAt)}</DescriptionListDescription>
                            </DescriptionListGroup>
                          </DescriptionList>
                        )}
                      </CardBody>
                    </Card>

                    <Card isFullHeight>
                      <CardTitle>Artifacts</CardTitle>
                      <CardBody>
                        {!scan ? (
                          <Skeleton height="160px" screenreaderText="Loading" />
                        ) : scan.state !== 'succeeded' ? (
                          <Content component="p">
                            {scan.state === 'warming'
                              ? 'The model is warming up; the agent starts once it answers. This page refreshes on its own.'
                              : isActive(scan.state)
                                ? 'The Report will be available here when the Scan succeeds. This page refreshes on its own.'
                                : 'A failed Scan has no Artifacts.'}
                          </Content>
                        ) : (
                          <Stack hasGutter>
                            {sortArtifacts(scan.artifacts ?? []).map((name) => (
                              <StackItem key={name}>
                                <Button variant="secondary" icon={<DownloadIcon />} onClick={() => download(name)}>
                                  {ARTIFACT_LABELS[name] ?? name}
                                </Button>
                              </StackItem>
                            ))}
                          </Stack>
                        )}
                      </CardBody>
                    </Card>
                  </Gallery>
                </div>
              </Tab>
              <Tab
                eventKey="findings"
                title={
                  <TabTitleText>
                    Findings{' '}
                    {findings?.findings && <Badge isRead>{findings.findings.length}</Badge>}
                  </TabTitleText>
                }
              >
                <div className="app-tab-body">
                  {findings ? (
                    <Card>
                      <CardBody>
                        <Stack hasGutter>
                          {findings.report?.summary && (
                            <StackItem>
                              <Content component="p">{findings.report.summary}</Content>
                            </StackItem>
                          )}
                          <StackItem>
                            <Flex spaceItems={{ default: 'spaceItemsSm' }}>
                              {counts.map(([severity, n]) => (
                                <FlexItem key={severity}>
                                  <Label color={SEVERITY_COLOR[severity]} variant={n ? 'filled' : 'outline'}>
                                    {severity}: {n}
                                  </Label>
                                </FlexItem>
                              ))}
                            </Flex>
                          </StackItem>
                          {findings.findings?.length ? (
                            <StackItem>
                              <Table aria-label="Findings" variant="compact">
                                <Thead>
                                  <Tr>
                                    <Th width={10}>Severity</Th>
                                    <Th>Finding</Th>
                                    <Th width={25}>Location</Th>
                                  </Tr>
                                </Thead>
                                <Tbody>
                                  {[...findings.findings]
                                    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
                                    .map((f, i) => (
                                      <Tr key={i}>
                                        <Td dataLabel="Severity">
                                          <Label color={SEVERITY_COLOR[f.severity] ?? 'grey'}>{f.severity}</Label>
                                        </Td>
                                        <Td dataLabel="Finding">
                                          <ExpandableSection toggleText={f.title} isIndented>
                                            {f.description}
                                          </ExpandableSection>
                                        </Td>
                                        <Td dataLabel="Location">
                                          <code>
                                            {f.location?.file ?? '—'}
                                            {f.location?.line ? `:${f.location.line}` : ''}
                                          </code>
                                        </Td>
                                      </Tr>
                                    ))}
                                </Tbody>
                              </Table>
                            </StackItem>
                          ) : (
                            <StackItem>
                              <Content component="p">No Findings.</Content>
                            </StackItem>
                          )}
                        </Stack>
                      </CardBody>
                    </Card>
                  ) : (
                    <Content component="p">
                      {scan && isActive(scan.state)
                        ? 'The Findings appear here when the Scan succeeds.'
                        : 'This Scan has no Findings.'}
                    </Content>
                  )}
                </div>
              </Tab>
              <Tab
                eventKey="logs"
                title={
                  <TabTitleText>
                    Logs{scan && isActive(scan.state) && <span className="app-live-dot" aria-label="live" />}
                  </TabTitleText>
                }
              >
                <div className="app-tab-body">
                  <ActivityLog scanId={id} onState={setScan} />
                </div>
              </Tab>
            </Tabs>
          </StackItem>
        </Stack>
      </PageSection>

      <Modal variant="small" isOpen={confirmDelete} onClose={() => setConfirmDelete(false)} aria-labelledby="delete-title">
        <ModalHeader title="Delete this Scan?" titleIconVariant="warning" labelId="delete-title" />
        <ModalBody>
          {scan && isActive(scan.state) ? 'The running Scan stops, and its' : 'Its'} Source Archive, Artifacts and
          transcripts are removed for good. The id becomes free again.
          {deleteError && (
            <Alert variant="danger" isInline title="Could not delete" className="pf-v6-u-mt-md">
              {deleteError}
            </Alert>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={remove} isLoading={deleting} isDisabled={deleting}>
            Delete
          </Button>
          <Button variant="link" onClick={() => setConfirmDelete(false)} isDisabled={deleting}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}

const formatCount = (n: number) => n.toLocaleString();
const formatCost = (cost: number) => `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
