import {
  Alert,
  Button,
  Content,
  EmptyState,
  EmptyStateBody,
  FormSelect,
  FormSelectOption,
  Label,
  PageSection,
  Skeleton,
  Switch,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import CubesIcon from '@patternfly/react-icons/dist/esm/icons/cubes-icon';
import StarIcon from '@patternfly/react-icons/dist/esm/icons/star-icon';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useCallback, useEffect, useState } from 'react';
import { api, type AdminModel, type Provider } from '../api';
import { DiscoverModelsModal } from '../components/DiscoverModelsModal';
import { href } from '../router';

/** The Model Pool: what callers may run Scans with, and the Default Model. */
export function ModelsPage() {
  const [models, setModels] = useState<AdminModel[]>();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [source, setSource] = useState('');
  const [browsing, setBrowsing] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    Promise.all([api.adminModels(), api.providers()])
      .then(([m, p]) => {
        setModels(m);
        setProviders(p);
        setSource((current) => current || p[0]?.id || '');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  async function change(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  return (
    <>
      <PageSection>
        <Content>
          <Title headingLevel="h1">Models</Title>
          <p>
            The Model Pool. Callers choose among the enabled models; the Default Model <StarIcon className="app-default-star" /> runs when they
            choose none.
          </p>
        </Content>
      </PageSection>
      <PageSection isFilled>
        {error && (
          <Alert variant="danger" isInline title="Something went wrong" className="pf-v6-u-mb-md">
            {error}
          </Alert>
        )}
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <FormSelect value={source} onChange={(_e, v) => setSource(v)} aria-label="Provider" isDisabled={!providers.length}>
                {providers.map((p) => (
                  <FormSelectOption key={p.id} value={p.id} label={`${p.id} (${p.kind})`} />
                ))}
              </FormSelect>
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setBrowsing(source)} isDisabled={!source}>
                Add models from this Provider
              </Button>
            </ToolbarItem>
            {!providers.length && models && (
              <ToolbarItem>
                <Button variant="link" component="a" href={href({ page: 'providers' })}>
                  Add a Provider first
                </Button>
              </ToolbarItem>
            )}
          </ToolbarContent>
        </Toolbar>

        {!models ? (
          !error && <Skeleton height="120px" screenreaderText="Loading" />
        ) : models.length === 0 ? (
          <EmptyState titleText="The Model Pool is empty" headingLevel="h2" icon={CubesIcon}>
            <EmptyStateBody>No Scan can run until it has a model. Pick one from a Provider.</EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Models" variant="compact">
            <Thead>
              <Tr>
                <Th screenReaderText="Default" />
                <Th>Id</Th>
                <Th>Provider</Th>
                <Th>Name at the Provider</Th>
                <Th>Enabled</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {models.map((m) => (
                <Tr key={m.id} className={m.enabled ? undefined : 'app-row-disabled'}>
                  <Td modifier="fitContent">{m.default && <Label color="blue" icon={<StarIcon />}>Default</Label>}</Td>
                  <Td dataLabel="Id">
                    <strong>{m.id}</strong>
                  </Td>
                  <Td dataLabel="Provider">{m.provider}</Td>
                  <Td dataLabel="Name">
                    <code>{m.name}</code>
                  </Td>
                  <Td dataLabel="Enabled">
                    <Switch
                      id={`enabled-${m.id}`}
                      aria-label={`${m.id} enabled`}
                      isChecked={m.enabled}
                      isDisabled={m.default}
                      onChange={(_e, enabled) => change(() => api.updateModel(m.id, { enabled }))}
                    />
                  </Td>
                  <Td isActionCell>
                    <ActionsColumn
                      items={[
                        { title: 'Make it the Default Model', isDisabled: m.default, onClick: () => change(() => api.updateModel(m.id, { default: true })) },
                        { isSeparator: true },
                        {
                          title: 'Remove from the pool',
                          // The Default Model stays until another one takes its place.
                          isDisabled: m.default && models.length > 1,
                          onClick: () => change(() => api.deleteModel(m.id)),
                        },
                      ]}
                    />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </PageSection>

      {browsing && <DiscoverModelsModal providerId={browsing} onClose={() => setBrowsing(undefined)} onAdded={load} />}
    </>
  );
}
