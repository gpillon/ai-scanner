import {
  Alert,
  Button,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  SearchInput,
  Skeleton,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useEffect, useState } from 'react';
import { api, ApiError, type DiscoveredModel } from '../api';

/**
 * The models a Provider offers, as its own API lists them, each one a click away from the
 * Model Pool.
 */
export function DiscoverModelsModal({ providerId, onClose, onAdded }: { providerId: string; onClose: () => void; onAdded: () => void }) {
  const [models, setModels] = useState<DiscoveredModel[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState<string>();

  useEffect(() => {
    api
      .discoverModels(providerId)
      .then(setModels)
      .catch((e: Error) => setError(e.message));
  }, [providerId]);

  async function add(model: DiscoveredModel) {
    setAdding(model.name);
    setError(undefined);
    try {
      let created;
      try {
        created = await api.createModel({ provider: providerId, name: model.name });
      } catch (e) {
        // Another Provider's model already has this name as its id: qualify it with ours.
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        created = await api.createModel({ provider: providerId, name: model.name, id: `${providerId}/${model.name}` });
      }
      setModels((list) => list?.map((m) => (m.name === model.name ? { ...m, inPool: created.id } : m)));
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(undefined);
    }
  }

  const needle = filter.trim().toLowerCase();
  const shown = models?.filter((m) => !needle || `${m.name} ${m.displayName ?? ''}`.toLowerCase().includes(needle));

  return (
    <Modal variant="medium" isOpen onClose={onClose} aria-labelledby="discover-title">
      <ModalHeader title={`Models of ${providerId}`} labelId="discover-title" description="As the Provider's API lists them." />
      <ModalBody>
        {error && (
          <Alert variant="danger" isInline title="Something went wrong" className="pf-v6-u-mb-md">
            {error}
          </Alert>
        )}
        {!models ? (
          !error && <Skeleton height="200px" screenreaderText="Asking the Provider" />
        ) : (
          <>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  <SearchInput placeholder="Filter models" value={filter} onChange={(_e, v) => setFilter(v)} onClear={() => setFilter('')} />
                </ToolbarItem>
                <ToolbarItem align={{ default: 'alignEnd' }}>
                  {shown?.length} of {models.length}
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>
            <div className="app-modal-scroll">
              <Table aria-label="Offered models" variant="compact" isStickyHeader>
                <Thead>
                  <Tr>
                    <Th>Model</Th>
                    <Th screenReaderText="Action" />
                  </Tr>
                </Thead>
                <Tbody>
                  {shown?.map((m) => (
                    <Tr key={m.name}>
                      <Td dataLabel="Model">
                        <code>{m.name}</code>
                        {m.displayName && m.displayName !== m.name && <div className="app-subtle">{m.displayName}</div>}
                      </Td>
                      <Td isActionCell modifier="fitContent">
                        {m.inPool ? (
                          <Label color="green">In the pool as {m.inPool}</Label>
                        ) : (
                          <Button variant="secondary" size="sm" onClick={() => add(m)} isLoading={adding === m.name} isDisabled={Boolean(adding)}>
                            Add
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </div>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </ModalFooter>
    </Modal>
  );
}
