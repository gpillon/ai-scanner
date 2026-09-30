import { Button, Content, PageSection, Split, SplitItem, Title } from '@patternfly/react-core';
import ExternalLinkAltIcon from '@patternfly/react-icons/dist/esm/icons/external-link-alt-icon';
import { token } from '../api';

/** The backend's own Swagger UI (`/api/docs`), generated from the controllers. */
const DOCS_URL = '/api/docs';

/** Swagger UI exposes itself as `window.ui` once loaded. */
interface SwaggerWindow extends Window {
  ui?: { preauthorizeApiKey(name: string, value: string): void };
}

/**
 * Signs the embedded Swagger UI in with this browser's token, so "Try it out" works at once.
 * `bearer` is the security scheme `addBearerAuth()` declares. Same origin, hence reachable.
 */
function authorize(frame: HTMLIFrameElement, attemptsLeft = 20): void {
  const bearer = token.get();
  if (!bearer) return;
  try {
    const ui = (frame.contentWindow as SwaggerWindow | null)?.ui;
    if (ui) return ui.preauthorizeApiKey('bearer', bearer);
  } catch {
    return; // Not same-origin after all: the reader authorizes by hand.
  }
  if (attemptsLeft > 0) setTimeout(() => authorize(frame, attemptsLeft - 1), 100);
}

export function DocsPage() {
  return (
    <>
      <PageSection>
        <Split hasGutter>
          <SplitItem isFilled>
            <Content>
              <Title headingLevel="h1">Documentation</Title>
              <p>
                The HTTP API, as the server describes it. Requests sent from here use your token. The OpenAPI document
                is at <a href="/api/openapi.json">/api/openapi.json</a>.
              </p>
            </Content>
          </SplitItem>
          <SplitItem>
            <Button variant="link" component="a" href={DOCS_URL} target="_blank" rel="noopener" icon={<ExternalLinkAltIcon />} iconPosition="end">
              Open in a new tab
            </Button>
          </SplitItem>
        </Split>
      </PageSection>
      <PageSection isFilled padding={{ default: 'noPadding' }}>
        <iframe className="app-docs" title="API documentation" src={DOCS_URL} onLoad={(e) => authorize(e.currentTarget)} />
      </PageSection>
    </>
  );
}
