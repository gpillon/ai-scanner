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
import CodeBranchIcon from '@patternfly/react-icons/dist/esm/icons/code-branch-icon';
import LockIcon from '@patternfly/react-icons/dist/esm/icons/lock-icon';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type SavedRepository } from '../api';
import { GitSourceFields, type GitSourceValue } from '../components/GitSourceFields';
import { navigate } from '../router';

const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Saved Repositories: Git repositories kept on the server, to scan again or on a schedule (ADR-0014). */
export function RepositoriesPage({ isAdmin }: { isAdmin: boolean }) {
  const [repos, setRepos] = useState<SavedRepository[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<SavedRepository | 'new'>();

  const load = useCallback(() => {
    api
      .repositories()
      .then(setRepos)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function remove(id: string) {
    setError(undefined);
    try {
      await api.deleteRepository(id);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  return (
    <>
      <PageSection>
        <Content>
          <Title headingLevel="h1">Repositories</Title>
          <p>
            Git repositories you scan often. Start a Scan of one in a click, or scan it on a schedule. A private
            repository, with a stored token, is the admin's: only the admin token adds, scans or changes one. Its token is
            stored encrypted and never shown again.
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
                Add repository
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        {!repos ? (
          !error && <Skeleton height="120px" screenreaderText="Loading" />
        ) : repos.length === 0 ? (
          <EmptyState titleText="No saved repositories" headingLevel="h2" icon={CodeBranchIcon}>
            <EmptyStateBody>Add the Git repositories you scan often.</EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Repositories" variant="compact">
            <Thead>
              <Tr>
                <Th>Id</Th>
                <Th>URL</Th>
                <Th>Branch or tag</Th>
                <Th>Access</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {repos.map((r) => (
                <Tr key={r.id}>
                  <Td dataLabel="Id">
                    <strong>{r.id}</strong>
                    {r.description && <div className="app-subtle">{r.description}</div>}
                  </Td>
                  <Td dataLabel="URL">
                    <code className="app-break">{r.url}</code>
                  </Td>
                  <Td dataLabel="Branch or tag">{r.ref ?? <span className="app-subtle">default branch</span>}</Td>
                  <Td dataLabel="Access">
                    {r.tokenSet ? (
                      <Label isCompact icon={<LockIcon />} color="orange">
                        Token{r.tokenHint ? ` …${r.tokenHint}` : ''}
                      </Label>
                    ) : (
                      <span className="app-subtle">Public</span>
                    )}
                  </Td>
                  <Td isActionCell>
                    <ActionsColumn
                      isDisabled={r.tokenSet && !isAdmin}
                      items={[
                        { title: 'Scan now', onClick: () => navigate({ page: 'new', repository: r.id }) },
                        { title: 'Edit', onClick: () => setEditing(r) },
                        { isSeparator: true },
                        { title: 'Remove', onClick: () => remove(r.id) },
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
        <RepositoryForm
          repo={editing === 'new' ? undefined : editing}
          isAdmin={isAdmin}
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

function RepositoryForm({ repo, isAdmin, onClose, onSaved }: { repo?: SavedRepository; isAdmin: boolean; onClose: () => void; onSaved: () => void }) {
  const [id, setId] = useState(repo?.id ?? '');
  const [description, setDescription] = useState(repo?.description ?? '');
  const [git, setGit] = useState<GitSourceValue>({ url: repo?.url ?? '', ref: repo?.ref ?? '', username: repo?.username ?? '', token: '' });
  const [dropToken, setDropToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const idValid = Boolean(repo) || REPOSITORY_ID_PATTERN.test(id);
  // Unchanged URL and no new token: the stored token lists the refs.
  const useStored = Boolean(repo?.tokenSet) && !git.token && !dropToken && git.url.trim() === repo?.url;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      if (repo) {
        await api.updateRepository(repo.id, {
          description,
          url: git.url.trim(),
          ref: git.ref.trim() || null,
          username: git.username.trim() || null,
          ...(dropToken ? { token: null } : git.token && { token: git.token }),
        });
      } else {
        await api.createRepository({
          id: id.trim(),
          description,
          url: git.url.trim(),
          ref: git.ref.trim() || undefined,
          username: git.username.trim() || undefined,
          token: git.token || undefined,
        });
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  const tokenHelp = repo?.tokenSet
    ? `A token${repo.tokenHint ? ` ending in …${repo.tokenHint}` : ''} is stored. Type a new one to replace it.`
    : 'A read-only access token is enough. Stored encrypted on the server (needs SCANNER_SECRET_KEY), never shown again.';

  return (
    <Modal variant="medium" isOpen onClose={onClose} aria-labelledby="repo-form">
      <ModalHeader title={repo ? `Edit ${repo.id}` : 'Add a repository'} labelId="repo-form" />
      <ModalBody>
        <Form id="repo-form-body" onSubmit={submit}>
          {!repo && (
            <FormGroup label="Id" isRequired fieldId="saved-repo-id">
              <TextInput id="saved-repo-id" value={id} onChange={(_e, v) => setId(v)} placeholder="payments-api" validated={id && !idValid ? 'error' : 'default'} isRequired />
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant={id && !idValid ? 'error' : 'default'}>Lowercase letters, digits and dashes.</HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>
          )}
          <FormGroup label="Description" fieldId="saved-repo-description">
            <TextInput id="saved-repo-description" value={description} onChange={(_e, v) => setDescription(v)} placeholder="Optional" />
          </FormGroup>
          <GitSourceFields
            value={git}
            onChange={setGit}
            isDisabled={saving}
            tokenHelp={tokenHelp}
            refLabel="Default branch or tag"
            loadRefs={useStored ? () => api.repositoryRefs(repo!.id) : undefined}
            noCredentials={!isAdmin}
          />
          {!isAdmin && (
            <HelperText>
              <HelperTextItem>A private repository needs the admin token: sign in with it to add one with its token.</HelperTextItem>
            </HelperText>
          )}
          {repo?.tokenSet && (
            <Checkbox id="saved-repo-drop-token" label="Remove the stored token" isChecked={dropToken} onChange={(_e, v) => setDropToken(v)} />
          )}
          {error && (
            <Alert variant="danger" isInline title="Not saved">
              {error}
            </Alert>
          )}
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" type="submit" form="repo-form-body" isLoading={saving} isDisabled={saving || !idValid || !git.url.trim() || (!repo && !id.trim())}>
          {repo ? 'Save' : 'Add'}
        </Button>
        <Button variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}
