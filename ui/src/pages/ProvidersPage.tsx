import {
  Alert,
  AlertActionCloseButton,
  Button,
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
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageSection,
  Skeleton,
  TextInput,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import CubesIcon from '@patternfly/react-icons/dist/esm/icons/cubes-icon';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Provider, type ProviderKind } from '../api';
import { DiscoverModelsModal } from '../components/DiscoverModelsModal';

/** Providers serve the Model Pool's models; adding one opens the agents' egress to it (ADR-0006). */
export function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>();
  const [kinds, setKinds] = useState<ProviderKind[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Provider | 'new'>();
  const [deleting, setDeleting] = useState<Provider>();
  const [browsing, setBrowsing] = useState<string>();

  const load = useCallback(() => {
    api
      .providers()
      .then(setProviders)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    api.providerKinds().then(setKinds).catch(() => undefined);
  }, [load]);

  async function remove(p: Provider) {
    try {
      await api.deleteProvider(p.id);
      setDeleting(undefined);
      load();
    } catch (e) {
      setError((e as Error).message);
      setDeleting(undefined);
    }
  }

  return (
    <>
      <PageSection>
        <Content>
          <Title headingLevel="h1">Providers</Title>
          <p>
            The LLM APIs the Model Pool's models come from. Agents may reach every Provider that serves a model, and nothing
            else.
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
              <Button variant="primary" onClick={() => setEditing('new')}>
                Add Provider
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        {!providers ? (
          !error && <Skeleton height="120px" screenreaderText="Loading" />
        ) : providers.length === 0 ? (
          <EmptyState titleText="No Providers" headingLevel="h2" icon={CubesIcon}>
            <EmptyStateBody>Add a Provider, then pick the models it offers.</EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Providers" variant="compact">
            <Thead>
              <Tr>
                <Th>Id</Th>
                <Th>Kind</Th>
                <Th>API</Th>
                <Th>Key</Th>
                <Th>Models</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {providers.map((p) => (
                <Tr key={p.id}>
                  <Td dataLabel="Id">
                    <strong>{p.id}</strong>
                  </Td>
                  <Td dataLabel="Kind">{p.kind}</Td>
                  <Td dataLabel="API">
                    <code>{p.effectiveBaseUrl ?? '—'}</code>
                  </Td>
                  <Td dataLabel="Key">
                    {p.apiKeySet ? (
                      <Label color="green">Stored{p.apiKeyHint ? ` …${p.apiKeyHint}` : ''}</Label>
                    ) : p.apiKeyEnv ? (
                      <Label variant="outline">From ${p.apiKeyEnv}</Label>
                    ) : (
                      <Label variant="outline">None</Label>
                    )}
                  </Td>
                  <Td dataLabel="Models">{p.models}</Td>
                  <Td isActionCell>
                    <ActionsColumn
                      items={[
                        { title: 'Browse models', onClick: () => setBrowsing(p.id) },
                        { title: 'Edit', onClick: () => setEditing(p) },
                        { isSeparator: true },
                        { title: 'Remove', onClick: () => setDeleting(p), isDisabled: p.models > 0 },
                      ]}
                    />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </PageSection>

      {editing && (
        <ProviderForm
          provider={editing === 'new' ? undefined : editing}
          kinds={kinds}
          onClose={() => setEditing(undefined)}
          onSaved={(p, isNew) => {
            setEditing(undefined);
            load();
            // A new Provider is only useful with models: go straight to its list.
            if (isNew) setBrowsing(p.id);
          }}
        />
      )}

      {browsing && <DiscoverModelsModal providerId={browsing} onClose={() => setBrowsing(undefined)} onAdded={load} />}

      <Modal variant="small" isOpen={Boolean(deleting)} onClose={() => setDeleting(undefined)} aria-labelledby="remove-provider">
        <ModalHeader title={`Remove ${deleting?.id}?`} titleIconVariant="warning" labelId="remove-provider" />
        <ModalBody>Its settings and stored API key are deleted. Agents can no longer reach it.</ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={() => deleting && remove(deleting)}>
            Remove
          </Button>
          <Button variant="link" onClick={() => setDeleting(undefined)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}

function ProviderForm({
  provider,
  kinds,
  onClose,
  onSaved,
}: {
  provider?: Provider;
  kinds: ProviderKind[];
  onClose: () => void;
  onSaved: (p: Provider, isNew: boolean) => void;
}) {
  const isNew = !provider;
  const [id, setId] = useState(provider?.id ?? '');
  const [kind, setKind] = useState(provider?.kind ?? 'openai-compatible');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const info = kinds.find((k) => k.kind === kind);
  const needsUrl = !info?.defaultBaseUrl;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const saved = isNew
        ? await api.createProvider({ id: id.trim(), kind, baseUrl: baseUrl.trim() || undefined, apiKey: apiKey || undefined })
        : await api.updateProvider(provider.id, {
            baseUrl: baseUrl.trim() || null,
            ...(apiKey ? { apiKey } : clearKey ? { apiKey: null } : {}),
          });
      onSaved(saved, isNew);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <Modal variant="small" isOpen onClose={onClose} aria-labelledby="provider-form">
      <ModalHeader title={isNew ? 'Add a Provider' : `Edit ${provider.id}`} labelId="provider-form" />
      <ModalBody>
        <Form id="provider-form-body" onSubmit={submit}>
          {isNew && (
            <>
              <FormGroup label="Kind" isRequired fieldId="kind">
                <FormSelect id="kind" value={kind} onChange={(_e, v) => setKind(v)}>
                  {kinds.map((k) => (
                    <FormSelectOption key={k.kind} value={k.kind} label={k.kind} />
                  ))}
                </FormSelect>
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>openai-compatible covers vLLM, LM Studio, Ollama and any other OpenAI-style API.</HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
              <FormGroup label="Id" isRequired fieldId="provider-id">
                <TextInput id="provider-id" value={id} onChange={(_e, v) => setId(v)} placeholder={kind === 'openai-compatible' ? 'local-vllm' : kind} isRequired />
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>Lowercase letters, digits and dashes.</HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
            </>
          )}
          <FormGroup label="Base URL" isRequired={needsUrl} fieldId="base-url">
            <TextInput
              id="base-url"
              value={baseUrl}
              onChange={(_e, v) => setBaseUrl(v)}
              placeholder={info?.defaultBaseUrl ?? 'http://host:8000/v1'}
              isRequired={needsUrl}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>{needsUrl ? 'Where its OpenAI-style API is.' : 'Leave empty for the default.'}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          <FormGroup label="API key" fieldId="api-key">
            <TextInput
              id="api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(_e, v) => setApiKey(v)}
              placeholder={provider?.apiKeySet ? `Stored${provider.apiKeyHint ? ` (…${provider.apiKeyHint})` : ''}: type to replace` : 'Optional'}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  Stored encrypted and never shown again.
                  {info?.apiKeyEnv && ` Without one, the server's ${info.apiKeyEnv} is used.`}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
            {provider?.apiKeySet && !apiKey && (
              <Button variant="link" isInline isDanger onClick={() => setClearKey(!clearKey)} className="pf-v6-u-mt-sm">
                {clearKey ? 'Keep the stored key' : 'Remove the stored key'}
              </Button>
            )}
          </FormGroup>
          {error && (
            <Alert variant="danger" isInline title="Not saved">
              {error}
            </Alert>
          )}
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" type="submit" form="provider-form-body" isLoading={saving} isDisabled={saving || (isNew && !id.trim()) || (needsUrl && !baseUrl.trim())}>
          {isNew ? 'Add' : 'Save'}
        </Button>
        <Button variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}
