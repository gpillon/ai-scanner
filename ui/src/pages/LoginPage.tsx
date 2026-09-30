import { ActionGroup, Button, Form, FormGroup, FormHelperText, HelperText, HelperTextItem, LoginPage as PfLoginPage, TextInput } from '@patternfly/react-core';
import { useState, type FormEvent } from 'react';
import { api } from '../api';

/** ai-scanner has no users: one shared bearer token opens everything (ADR-0002). */
export function LoginPage({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (await api.verifyToken(value.trim())) onToken(value.trim());
      else setError('The server rejected this token.');
    } catch (e) {
      setError(`Could not reach the server: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PfLoginPage
      loginTitle="Sign in to ai-scanner"
      loginSubtitle="Enter the server's bearer token"
      textContent="ai-scanner runs an AI coding agent on the source code you upload and returns a Report."
    >
      <Form onSubmit={submit}>
        <FormGroup label="Token" isRequired fieldId="token">
          <TextInput
            id="token"
            type="password"
            autoComplete="current-password"
            value={value}
            onChange={(_e, v) => setValue(v)}
            validated={error ? 'error' : 'default'}
            isRequired
          />
          <FormHelperText>
            <HelperText>
              <HelperTextItem variant={error ? 'error' : 'default'}>
                {error ?? 'The value of SCANNER_TOKEN. It is kept in this browser.'}
              </HelperTextItem>
            </HelperText>
          </FormHelperText>
        </FormGroup>
        <ActionGroup>
          <Button type="submit" variant="primary" isBlock isLoading={busy} isDisabled={busy || !value.trim()}>
            Sign in
          </Button>
        </ActionGroup>
      </Form>
    </PfLoginPage>
  );
}
