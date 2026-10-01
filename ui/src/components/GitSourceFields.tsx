import {
  Alert,
  Button,
  ExpandableSection,
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
import { useState, type ReactNode } from 'react';
import { api, type GitRefs } from '../api';

export interface GitSourceValue {
  url: string;
  /** Empty for the default branch. */
  ref: string;
  username: string;
  token: string;
}

export const emptyGitSource: GitSourceValue = { url: '', ref: '', username: '', token: '' };

/**
 * A Git repository as a Scan's source (ADR-0010): its URL, credentials when private, and the
 * branch or tag, chosen from what the repository lists. Credentials stay in the form's memory.
 */
export function GitSourceFields({
  value,
  onChange,
  isDisabled,
  tokenHelp = 'A read-only access token is enough. Used for this fetch only: the server never stores it.',
  refLabel = 'Branch or tag',
  loadRefs,
  noCredentials,
}: {
  value: GitSourceValue;
  onChange: (v: GitSourceValue) => void;
  isDisabled?: boolean;
  tokenHelp?: ReactNode;
  refLabel?: string;
  /** Lists the refs some other way, e.g. with a Saved Repository's stored credentials. */
  loadRefs?: () => Promise<GitRefs>;
  /** Hides the credential fields, e.g. where only an admin may store them. */
  noCredentials?: boolean;
}) {
  const [refs, setRefs] = useState<GitRefs>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [privateOpen, setPrivateOpen] = useState(false);

  const set = (change: Partial<GitSourceValue>) => onChange({ ...value, ...change });

  async function fetchRefs() {
    setLoading(true);
    setError(undefined);
    try {
      const found = loadRefs
        ? await loadRefs()
        : await api.gitRefs(value.url.trim(), { username: value.username || undefined, token: value.token || undefined });
      setRefs(found);
      // A ref chosen before that the repository does not have is dropped.
      if (value.ref && !found.branches.includes(value.ref) && !found.tags.includes(value.ref)) set({ ref: '' });
    } catch (e) {
      setRefs(undefined);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <FormGroup label="Repository URL" isRequired fieldId="repo-url">
        <TextInput
          id="repo-url"
          type="url"
          value={value.url}
          onChange={(_e, url) => {
            set({ url });
            setRefs(undefined);
          }}
          placeholder="https://github.com/acme/app.git"
          isDisabled={isDisabled}
          isRequired
        />
        <FormHelperText>
          <HelperText>
            <HelperTextItem>The server checks out one commit of it. Never put credentials in the URL.</HelperTextItem>
          </HelperText>
        </FormHelperText>
      </FormGroup>

      {!noCredentials && (
      <ExpandableSection
        toggleText={privateOpen || value.token ? 'Private repository' : 'Private repository? Add credentials'}
        isExpanded={privateOpen || Boolean(value.token)}
        onToggle={(_e, open) => setPrivateOpen(open)}
        isIndented
      >
        <FormGroup label="Username" fieldId="repo-username">
          <TextInput id="repo-username" value={value.username} onChange={(_e, username) => set({ username })} placeholder="oauth2" autoComplete="off" isDisabled={isDisabled} />
        </FormGroup>
        <FormGroup label="Token or password" fieldId="repo-token" className="pf-v6-u-mt-sm">
          <TextInput id="repo-token" type="password" value={value.token} onChange={(_e, token) => set({ token })} autoComplete="new-password" isDisabled={isDisabled} />
          <FormHelperText>
            <HelperText>
              <HelperTextItem>{tokenHelp}</HelperTextItem>
            </HelperText>
          </FormHelperText>
        </FormGroup>
      </ExpandableSection>
      )}

      <FormGroup label={refLabel} fieldId="repo-ref">
        <InputGroup>
          <InputGroupItem isFill>
            {refs ? (
              <FormSelect id="repo-ref" value={value.ref} onChange={(_e, ref) => set({ ref })} isDisabled={isDisabled}>
                <FormSelectOption value="" label={`Default branch${refs.default ? ` (${refs.default})` : ''}`} />
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
              <TextInput id="repo-ref" value={value.ref} onChange={(_e, ref) => set({ ref })} placeholder="Default branch" isDisabled={isDisabled} />
            )}
          </InputGroupItem>
          <InputGroupItem>
            <Button variant="control" icon={<SyncAltIcon />} onClick={fetchRefs} isLoading={loading} isDisabled={isDisabled || loading || !value.url.trim()}>
              {refs ? 'Refresh' : 'Fetch branches and tags'}
            </Button>
          </InputGroupItem>
        </InputGroup>
        <FormHelperText>
          <HelperText>
            <HelperTextItem>
              {refs
                ? `${refs.branches.length} branches, ${refs.tags.length} tags.`
                : 'Optional: type a branch or tag, or fetch the list from the repository. The default branch otherwise.'}
            </HelperTextItem>
          </HelperText>
        </FormHelperText>
        {error && (
          <Alert variant="danger" isInline isPlain title={error} className="pf-v6-u-mt-sm" />
        )}
      </FormGroup>
    </>
  );
}
