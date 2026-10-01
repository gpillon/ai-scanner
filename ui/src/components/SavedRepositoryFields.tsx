import {
  Alert,
  Button,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  FormSelectOptionGroup,
  HelperText,
  HelperTextItem,
  InputGroup,
  InputGroupItem,
  TextInput,
} from '@patternfly/react-core';
import SyncAltIcon from '@patternfly/react-icons/dist/esm/icons/sync-alt-icon';
import { useEffect, useState } from 'react';
import { api, type GitRefs, type SavedRepository } from '../api';
import { href } from '../router';

export interface SavedRepositoryValue {
  id: string;
  /** Empty for the repository's own. */
  ref: string;
}

/**
 * A Saved Repository as a Scan's source (ADR-0014): the server fetches it with its stored
 * credentials, at its own branch or tag unless one is chosen here.
 */
export function SavedRepositoryFields({
  value,
  onChange,
  isDisabled,
  isAdmin,
}: {
  value: SavedRepositoryValue;
  onChange: (v: SavedRepositoryValue) => void;
  isDisabled?: boolean;
  /** Only the admin token may scan a private repository (ADR-0014). */
  isAdmin: boolean;
}) {
  const [repos, setRepos] = useState<SavedRepository[]>();
  const [refs, setRefs] = useState<GitRefs>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .repositories()
      .then((list) => {
        setRepos(list);
        // The one asked for if it may be used, else the first that may.
        const usable = list.filter((r) => isAdmin || !r.tokenSet);
        if (!usable.some((r) => r.id === value.id)) onChange({ id: usable[0]?.id ?? '', ref: '' });
      })
      .catch((e: Error) => setError(e.message));
    // Only once: the list does not change while the form is open.
  }, []);

  const chosen = repos?.find((r) => r.id === value.id);

  async function fetchRefs() {
    setLoading(true);
    setError(undefined);
    try {
      setRefs(await api.repositoryRefs(value.id));
    } catch (e) {
      setRefs(undefined);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (repos && !repos.length) {
    return (
      <Alert variant="info" isInline title="No saved repositories yet">
        <a href={href({ page: 'repositories' })}>Save a repository</a> to scan it again in a click.
      </Alert>
    );
  }

  return (
    <>
      <FormGroup label="Repository" isRequired fieldId="saved-repo">
        <FormSelect
          id="saved-repo"
          value={value.id}
          onChange={(_e, id) => {
            onChange({ id, ref: '' });
            setRefs(undefined);
          }}
          isDisabled={isDisabled || !repos}
        >
          {(repos ?? []).map((r) => (
            <FormSelectOption
              key={r.id}
              value={r.id}
              label={`${r.description ? `${r.id} — ${r.description}` : r.id}${r.tokenSet && !isAdmin ? ' (private: admin only)' : ''}`}
              isDisabled={r.tokenSet && !isAdmin}
            />
          ))}
        </FormSelect>
        {chosen && (
          <FormHelperText>
            <HelperText>
              <HelperTextItem>
                <code className="app-break">{chosen.url}</code>
                {chosen.tokenSet && ' · private, with its stored token'}
              </HelperTextItem>
            </HelperText>
          </FormHelperText>
        )}
      </FormGroup>

      <FormGroup label="Branch or tag" fieldId="saved-repo-ref">
        <InputGroup>
          <InputGroupItem isFill>
            {refs ? (
              <FormSelect id="saved-repo-ref" value={value.ref} onChange={(_e, ref) => onChange({ ...value, ref })} isDisabled={isDisabled}>
                <FormSelectOption value="" label={`The repository's: ${chosen?.ref ?? `default branch${refs.default ? ` (${refs.default})` : ''}`}`} />
                {refs.branches.length > 0 && (
                  <FormSelectOptionGroup label="Branches">
                    {refs.branches.map((b) => (
                      <FormSelectOption key={`b-${b}`} value={b} label={b} />
                    ))}
                  </FormSelectOptionGroup>
                )}
                {refs.tags.length > 0 && (
                  <FormSelectOptionGroup label="Tags">
                    {refs.tags.map((t) => (
                      <FormSelectOption key={`t-${t}`} value={t} label={t} />
                    ))}
                  </FormSelectOptionGroup>
                )}
              </FormSelect>
            ) : (
              <TextInput
                id="saved-repo-ref"
                value={value.ref}
                onChange={(_e, ref) => onChange({ ...value, ref })}
                placeholder={`The repository's: ${chosen?.ref ?? 'default branch'}`}
                isDisabled={isDisabled}
              />
            )}
          </InputGroupItem>
          <InputGroupItem>
            <Button variant="control" icon={<SyncAltIcon />} onClick={fetchRefs} isLoading={loading} isDisabled={isDisabled || loading || !value.id}>
              {refs ? 'Refresh' : 'Fetch branches and tags'}
            </Button>
          </InputGroupItem>
        </InputGroup>
        {error && <Alert variant="danger" isInline isPlain title={error} className="pf-v6-u-mt-sm" />}
      </FormGroup>
    </>
  );
}
