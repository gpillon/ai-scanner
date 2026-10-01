import {
  Alert,
  AlertActionCloseButton,
  Button,
  Checkbox,
  CodeBlock,
  CodeBlockCode,
  Content,
  EmptyState,
  EmptyStateBody,
  FileUpload,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Label,
  LabelGroup,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageSection,
  Skeleton,
  Tab,
  Tabs,
  TabTitleText,
  TextInput,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import CubesIcon from '@patternfly/react-icons/dist/esm/icons/cubes-icon';
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type LibrarySkill } from '../api';

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** The Skill Library: skills the admin imported, which Skill Packs group (ADR-0008). */
export function SkillsPage() {
  const [skills, setSkills] = useState<LibrarySkill[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [viewing, setViewing] = useState<string>();

  const load = useCallback(() => {
    api
      .librarySkills()
      .then(setSkills)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function remove(name: string) {
    setError(undefined);
    try {
      await api.deleteSkill(name);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  return (
    <>
      <PageSection>
        <Content>
          <Title headingLevel="h1">Skills</Title>
          <p>
            Agent skills imported for Skill Packs. Callers never upload skills: they choose Skill Packs, which group these.
          </p>
        </Content>
      </PageSection>
      <PageSection isFilled>
        {error && (
          <Alert variant="danger" isInline title="Something went wrong" className="pf-v6-u-mb-md" actionClose={<AlertActionCloseButton onClose={() => setError(undefined)} />}>
            {error}
          </Alert>
        )}
        {notice && (
          <Alert variant="success" isInline title={notice} className="pf-v6-u-mb-md" actionClose={<AlertActionCloseButton onClose={() => setNotice(undefined)} />} />
        )}
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setImporting(true)}>
                Import skills
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        {!skills ? (
          !error && <Skeleton height="120px" screenreaderText="Loading" />
        ) : skills.length === 0 ? (
          <EmptyState titleText="No skills yet" headingLevel="h2" icon={CubesIcon}>
            <EmptyStateBody>Import a zip of skills, or install them from a repository with the skills CLI.</EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Skills" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Description</Th>
                <Th>Source</Th>
                <Th>Size</Th>
                <Th>Skill Packs</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {skills.map((s) => (
                <Tr key={s.name}>
                  <Td dataLabel="Name">
                    <Button variant="link" isInline onClick={() => setViewing(s.name)}>
                      <code>{s.name}</code>
                    </Button>
                  </Td>
                  <Td dataLabel="Description" modifier="truncate">
                    {s.description}
                  </Td>
                  <Td dataLabel="Source" modifier="truncate">
                    <code className="app-subtle">{s.source}</code>
                  </Td>
                  <Td dataLabel="Size" modifier="nowrap">
                    {s.files} files, {kb(s.bytes)}
                  </Td>
                  <Td dataLabel="Skill Packs">
                    {s.packs.length ? (
                      <LabelGroup>
                        {s.packs.map((p) => (
                          <Label key={p} color="purple" isCompact>
                            {p}
                          </Label>
                        ))}
                      </LabelGroup>
                    ) : (
                      <span className="app-subtle">none</span>
                    )}
                  </Td>
                  <Td isActionCell>
                    <ActionsColumn
                      items={[
                        { title: 'View SKILL.md', onClick: () => setViewing(s.name) },
                        { isSeparator: true },
                        { title: 'Remove', isDisabled: s.packs.length > 0, onClick: () => remove(s.name) },
                      ]}
                    />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </PageSection>

      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onImported={(names) => {
            setImporting(false);
            setNotice(`Imported ${names.join(', ')}`);
            load();
          }}
        />
      )}
      {viewing && <SkillModal name={viewing} onClose={() => setViewing(undefined)} />}
    </>
  );
}

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: (names: string[]) => void }) {
  const [tab, setTab] = useState<'upload' | 'source'>('source');
  const [file, setFile] = useState<File>();
  const [source, setSource] = useState('');
  const [only, setOnly] = useState('');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const ready = tab === 'upload' ? Boolean(file) : Boolean(source.trim());

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const names = only
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const result = tab === 'upload' ? await api.uploadSkills(file!, replace) : await api.installSkills(source.trim(), names, replace);
      onImported(result.imported.map((s) => s.name));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal variant="medium" isOpen onClose={onClose} aria-labelledby="import-skills">
      <ModalHeader title="Import skills" labelId="import-skills" />
      <ModalBody>
        <Tabs activeKey={tab} onSelect={(_e, k) => setTab(k as 'upload' | 'source')} aria-label="Import from">
          <Tab eventKey="source" title={<TabTitleText>From a repository</TabTitleText>} />
          <Tab eventKey="upload" title={<TabTitleText>Upload a zip</TabTitleText>} />
        </Tabs>
        <Form id="import-skills-form" onSubmit={submit} className="app-tab-body">
          {tab === 'source' ? (
            <>
              <FormGroup label="Source" isRequired fieldId="skill-source">
                <TextInput id="skill-source" value={source} onChange={(_e, v) => setSource(v)} placeholder="owner/repo or https://github.com/owner/repo" isRequired />
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>Installed by the server with the skills CLI (`skills add`): a GitHub owner/repo, a Git URL or a tree URL.</HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
              <FormGroup label="Only these skills" fieldId="skill-only">
                <TextInput id="skill-only" value={only} onChange={(_e, v) => setOnly(v)} placeholder="All of them" />
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>Skill names, separated by commas.</HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
            </>
          ) : (
            <FormGroup label="Zip of skills" isRequired fieldId="skill-zip">
              <FileUpload
                id="skill-zip"
                value={file}
                filename={file?.name ?? ''}
                filenamePlaceholder="Drag a .zip here or browse"
                browseButtonText="Browse…"
                hideDefaultPreview
                dropzoneProps={{ accept: { 'application/zip': ['.zip'] } }}
                onFileInputChange={(_e, f) => setFile(f)}
                onClearClick={() => setFile(undefined)}
              />
              <FormHelperText>
                <HelperText>
                  <HelperTextItem>Each skill is a directory holding a SKILL.md, with `name` and `description` in its frontmatter.</HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>
          )}
          <Checkbox id="skill-replace" label="Replace skills the library already has" isChecked={replace} onChange={(_e, v) => setReplace(v)} />
          {error && (
            <Alert variant="danger" isInline title="Nothing was imported">
              {error}
            </Alert>
          )}
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" type="submit" form="import-skills-form" isLoading={busy} isDisabled={busy || !ready}>
          {busy && tab === 'source' ? 'Installing…' : 'Import'}
        </Button>
        <Button variant="link" onClick={onClose} isDisabled={busy}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function SkillModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [skill, setSkill] = useState<LibrarySkill & { instructions: string }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api
      .librarySkill(name)
      .then(setSkill)
      .catch((e: Error) => setError(e.message));
  }, [name]);
  return (
    <Modal variant="large" isOpen onClose={onClose} aria-labelledby="skill-view">
      <ModalHeader title={name} labelId="skill-view" description={skill?.description} />
      <ModalBody>
        {error && <Alert variant="danger" isInline title={error} />}
        {!skill ? (
          !error && <Skeleton height="200px" />
        ) : (
          <>
            <Content component="p" className="app-subtle">
              From <code>{skill.source}</code>, imported {new Date(skill.importedAt).toLocaleString()} · sha256 <code>{skill.hash.slice(0, 12)}</code>
            </Content>
            <CodeBlock className="app-modal-scroll">
              <CodeBlockCode>{skill.instructions}</CodeBlockCode>
            </CodeBlock>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}
