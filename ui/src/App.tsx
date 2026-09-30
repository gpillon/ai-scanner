import {
  Button,
  Masthead,
  MastheadBrand,
  MastheadContent,
  MastheadLogo,
  MastheadMain,
  MastheadToggle,
  Nav,
  NavItem,
  NavList,
  Page,
  PageSidebar,
  PageSidebarBody,
  PageToggleButton,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
} from '@patternfly/react-core';
import BarsIcon from '@patternfly/react-icons/dist/esm/icons/bars-icon';
import ShieldAltIcon from '@patternfly/react-icons/dist/esm/icons/shield-alt-icon';
import { useEffect, useState } from 'react';
import { setUnauthorizedHandler, token } from './api';
import { DocsPage } from './pages/DocsPage';
import { LoginPage } from './pages/LoginPage';
import { NewScanPage } from './pages/NewScanPage';
import { ScanDetailPage } from './pages/ScanDetailPage';
import { ScansPage } from './pages/ScansPage';
import { href, useRoute } from './router';

export function App() {
  const [signedIn, setSignedIn] = useState(() => Boolean(token.get()));
  const route = useRoute();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      token.clear();
      setSignedIn(false);
    });
  }, []);

  if (!signedIn) {
    return (
      <LoginPage
        onToken={(value) => {
          token.set(value);
          setSignedIn(true);
        }}
      />
    );
  }

  const signOut = () => {
    token.clear();
    setSignedIn(false);
  };

  const masthead = (
    <Masthead>
      <MastheadMain>
        <MastheadToggle>
          <PageToggleButton variant="plain" aria-label="Navigation">
            <BarsIcon />
          </PageToggleButton>
        </MastheadToggle>
        <MastheadBrand>
          <MastheadLogo component="a" href={href({ page: 'scans' })} className="app-logo">
            <Title headingLevel="h1" size="xl" className="app-brand">
              <ShieldAltIcon /> AI Scanner
            </Title>
          </MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar isFullHeight isStatic>
          <ToolbarContent>
            <ToolbarGroup align={{ default: 'alignEnd' }}>
              <ToolbarItem>
                <Button variant="plain" onClick={signOut}>
                  Sign out
                </Button>
              </ToolbarItem>
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );

  const sidebar = (
    <PageSidebar>
      <PageSidebarBody>
        <Nav aria-label="Navigation">
          <NavList>
            <NavItem to={href({ page: 'scans' })} isActive={route.page === 'scans' || route.page === 'scan'}>
              Scans
            </NavItem>
            <NavItem to={href({ page: 'new' })} isActive={route.page === 'new'}>
              New Scan
            </NavItem>
            <NavItem to={href({ page: 'docs' })} isActive={route.page === 'docs'}>
              Documentation
            </NavItem>
          </NavList>
        </Nav>
      </PageSidebarBody>
    </PageSidebar>
  );

  return (
    <Page masthead={masthead} sidebar={sidebar} isManagedSidebar>
      {route.page === 'new' && <NewScanPage />}
      {route.page === 'scans' && <ScansPage />}
      {route.page === 'scan' && <ScanDetailPage key={route.id} id={route.id} />}
      {route.page === 'docs' && <DocsPage />}
    </Page>
  );
}
